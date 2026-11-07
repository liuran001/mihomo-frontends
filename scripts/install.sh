#!/bin/sh
# mihomo eBPF 一键安装 / 更新
#   OpenWrt：安装或更新 LuCI 插件（自动选择 apk 或 ipk）
#   Android：安装或更新 Magisk / KernelSU / APatch 模块（需要 root）
#
# 用法：
#   OpenWrt：wget -qO- https://github.com/liuran001/mihomo-frontends/releases/latest/download/install.sh | sh
#   Android（Termux）：curl -fsSL https://github.com/liuran001/mihomo-frontends/releases/latest/download/install.sh | su -c sh
# 国内网络可以经镜像下载脚本，并用 MIRROR 让脚本里的下载也走镜像：
#   wget -qO- https://ghfast.top/https://github.com/liuran001/mihomo-frontends/releases/latest/download/install.sh | MIRROR=https://ghfast.top/ sh
# 其它环境变量：FORCE=1 版本相同也重新安装；DRY_RUN=1 只下载校验，不安装
set -u

REPO=liuran001/mihomo-frontends
MANIFEST_URL=https://github.com/$REPO/releases/latest/download/update.json
PKG_PREFIX=https://github.com/$REPO/releases/download/
DEFAULT_MIRROR=https://ghfast.top/
MODID=mihomo-ebpf
MIRROR=${MIRROR:-}
FORCE=${FORCE:-0}
DRY_RUN=${DRY_RUN:-0}

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

WORK=$(mktemp -d 2>/dev/null || { d=/tmp/mihomo-install.$$; mkdir -p "$d" && echo "$d"; }) || die '无法创建临时目录'
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------- 下载 ----------

BUSYBOX=
for b in /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox /data/adb/magisk/busybox; do
	[ -x "$b" ] && BUSYBOX=$b && break
done

# 在 Termux 里用 su 运行时，root 的 PATH 里通常没有 curl：借用 Termux 的
TERMUX=/data/data/com.termux/files/usr
termux_curl() { LD_LIBRARY_PATH=$TERMUX/lib "$TERMUX/bin/curl" "$@"; }

fetch_one() { # <url> <输出文件>
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 10 --max-time 300 -o "$2" "$1"
	elif [ -x "$TERMUX/bin/curl" ]; then
		termux_curl -fsSL --connect-timeout 10 --max-time 300 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -T 30 -O "$2" "$1"
	elif [ -n "$BUSYBOX" ]; then
		"$BUSYBOX" wget -q -T 30 -O "$2" "$1"
	else
		die '没有 curl 或 wget，无法下载'
	fi
}

# 指定了 MIRROR 时先走镜像；否则先直连，失败再试默认镜像
fetch() { # <url> <输出文件>
	rm -f "$2"
	if [ -n "$MIRROR" ]; then
		fetch_one "$MIRROR$1" "$2" && [ -s "$2" ] && return 0
		fetch_one "$1" "$2" && [ -s "$2" ] && return 0
	else
		fetch_one "$1" "$2" && [ -s "$2" ] && return 0
		say "直连 GitHub 失败，改用镜像 $DEFAULT_MIRROR"
		fetch_one "$DEFAULT_MIRROR$1" "$2" && [ -s "$2" ] && { MIRROR=$DEFAULT_MIRROR; return 0; }
	fi
	rm -f "$2"
	return 1
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	elif [ -n "$BUSYBOX" ]; then "$BUSYBOX" sha256sum "$1" | cut -d' ' -f1
	else die '没有 sha256sum，无法校验'
	fi
}

# ---------- update.json ----------

# update.json 是每个字段一行的格式：展开成 a.b.c=值 的形式，便于用 sed 取值
flatten() {
	awk '
	/^[[:space:]]*"[^"]+"[[:space:]]*:[[:space:]]*\{/ { match($0, /"[^"]+"/); stack[++d] = substr($0, RSTART + 1, RLENGTH - 2); next }
	/^[[:space:]]*\}/ { if (d > 0) d--; next }
	/^[[:space:]]*"[^"]+"[[:space:]]*:/ {
		match($0, /"[^"]+"/); k = substr($0, RSTART + 1, RLENGTH - 2)
		v = $0; sub(/^[^:]*:[[:space:]]*/, "", v); sub(/,[[:space:]]*$/, "", v); gsub(/^"|"$/, "", v)
		p = ""; for (i = 1; i <= d; i++) p = p stack[i] "."
		print p k "=" v
	}' "$1"
}

get() { sed -n "s/^$1=//p" "$WORK/manifest" | head -n 1; }

check_pkg() { # <地址> <sha256> <扩展名>
	case "$1" in "$PKG_PREFIX"*."$3") ;; *) die "更新信息里的下载地址不是本项目的 release：$1" ;; esac
	case "$1" in *..*|*' '*) die '更新信息里的下载地址无效' ;; esac
	printf '%s' "$2" | grep -Eq '^[0-9a-f]{64}$' || die '更新信息缺少有效的 sha256'
}

download_verified() { # <地址> <sha256> <输出文件>
	say "下载 ${1##*/}"
	fetch "$1" "$3" || die '下载失败，请检查网络，或设置 MIRROR=https://ghfast.top/ 后重试'
	[ "$(sha256_of "$3")" = "$2" ] || die 'sha256 校验失败，文件不完整或已被篡改'
	say 'sha256 校验通过'
}

# ---------- OpenWrt ----------

install_openwrt() {
	rel=$(sed -n "s/^DISTRIB_RELEASE='\{0,1\}\([0-9]*\).*/\1/p" /etc/openwrt_release | head -n 1)
	case "$rel" in ''|*[!0-9]*) ;; *) [ "$rel" -ge 24 ] || die "需要 OpenWrt 24.10 或更新（当前 $rel.x）" ;; esac
	if [ -x /usr/bin/apk ]; then fmt=apk
	elif [ -x /bin/opkg ] || command -v opkg >/dev/null 2>&1; then fmt=ipk
	else die '没有找到 apk 或 opkg'
	fi
	url=$(get "luci.$fmt.url")
	sha=$(get "luci.$fmt.sha256")
	check_pkg "$url" "$sha" "$fmt"
	cur=$(cat /usr/share/mihomo-luci/version 2>/dev/null | tr -d '\r\n')
	say "已安装：${cur:-无}　最新：$latest"
	if [ -n "$cur" ] && [ "${cur##*-}" -ge "$latest_code" ] 2>/dev/null && [ "$FORCE" != 1 ]; then
		say '已是最新版本。需要重新安装时加 FORCE=1'
		return 0
	fi
	pkg=$WORK/luci-app-mihomo-ebpf.$fmt
	download_verified "$url" "$sha" "$pkg"
	[ "$DRY_RUN" = 1 ] && { say 'DRY_RUN=1，跳过安装'; return 0; }
	# 依赖（mihomo 运行所需的 curl、yq、ip-full 等）从软件源安装，先刷新软件源列表
	if [ "$fmt" = apk ]; then
		say '刷新软件源…'
		apk update >/dev/null 2>&1 || say '刷新软件源失败，继续尝试安装'
		apk add --allow-untrusted "$pkg" || die '安装失败'
	else
		say '刷新软件源…'
		opkg update >/dev/null 2>&1 || say '刷新软件源失败，继续尝试安装'
		# 重装时 opkg 会先跑卸载脚本：放下标记，让它跳过停服务、取消自启
		if [ "$FORCE" = 1 ]; then touch /tmp/mihomo-luci-reinstall; opkg install --force-reinstall "$pkg" || { rm -f /tmp/mihomo-luci-reinstall; die '安装失败'; }
		else opkg install "$pkg" || die '安装失败'
		fi
	fi
	say "完成：LuCI 插件已是 $(cat /usr/share/mihomo-luci/version 2>/dev/null)"
	say '打开 LuCI 的「服务 › Mihomo」，按向导完成设置'
}

# ---------- Android ----------

install_android() {
	[ "$(id -u)" = 0 ] || die '需要 root 权限：请用 su 运行'
	if [ -x /data/adb/ksud ]; then installer='/data/adb/ksud module install'; name=KernelSU
	elif [ -x /data/adb/apd ]; then installer='/data/adb/apd module install'; name=APatch
	elif command -v magisk >/dev/null 2>&1; then installer='magisk --install-module'; name=Magisk
	else die '没有找到 KernelSU、APatch 或 Magisk'
	fi
	url=$(get zipUrl)
	sha=$(get zipSha256)
	check_pkg "$url" "$sha" zip
	prop=/data/adb/modules/$MODID/module.prop
	code=$(sed -n 's/^versionCode=//p' "$prop" 2>/dev/null | tr -d '\r')
	cur=$(sed -n 's/^version=//p' "$prop" 2>/dev/null | tr -d '\r')
	say "已安装：${cur:-无}　最新：$latest"
	if [ -n "$code" ] && [ "$code" -ge "$latest_code" ] 2>/dev/null && [ "$FORCE" != 1 ]; then
		say '已是最新版本。需要重新安装时加 FORCE=1'
		return 0
	fi
	zip=$WORK/mihomo-ebpf.zip
	download_verified "$url" "$sha" "$zip"
	[ "$DRY_RUN" = 1 ] && { say 'DRY_RUN=1，跳过安装'; return 0; }
	say "用 $name 安装模块…"
	$installer "$zip" </dev/null || die '安装失败'
	if [ -n "$code" ]; then
		say '完成：已更新，几秒后自动生效，不用重启'
	else
		say '完成：重启手机后，在模块列表里打开 WebUI 按向导完成设置'
	fi
}

# ---------- 入口 ----------

say '获取最新版本信息…'
fetch "$MANIFEST_URL" "$WORK/update.json" || die '获取更新信息失败，请检查网络，或设置 MIRROR=https://ghfast.top/ 后重试'
flatten "$WORK/update.json" >"$WORK/manifest"
latest=$(get version)
latest_code=$(get versionCode)
case "$latest_code" in ''|*[!0-9]*) die '更新信息格式不对' ;; esac

if [ -f /etc/openwrt_release ]; then
	install_openwrt
elif [ -d /data/adb ] || [ -f /system/build.prop ]; then
	install_android
else
	die '只支持 OpenWrt 与已 root 的 Android'
fi
