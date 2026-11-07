#!/bin/sh
# 不依赖 OpenWrt SDK 的打包：在 Linux（如 WSL）里运行 sh scripts/build-apk.sh，输出 dist/luci-app-mihomo-ebpf-<版本>.apk。
# 包未签名，安装：apk add --allow-untrusted luci-app-mihomo-ebpf-<版本>.apk
# 需要 apk-tools 3：APK 指定路径，否则依次找 PATH 与 scripts/setup-apk-tools.sh 的编译结果。
set -e
cd "$(dirname "$0")/.."
sh scripts/sync-template.sh
NAME=luci-app-mihomo-ebpf
mk() { sed -n "s/^$1:=//p" Makefile; }
VERSION=$(mk PKG_VERSION)-r$(mk PKG_RELEASE)
DEPENDS=$(mk LUCI_DEPENDS | sed 's/+//g')
APK=${APK:-$(command -v apk 2>/dev/null || echo "${MH_TOOLS:-$HOME/.cache/mh-tools}/bin/apk")}
[ -x "$APK" ] || { echo "找不到 apk-tools 3，请先运行 scripts/setup-apk-tools.sh" >&2; exit 1; }

# 文件取自 root/，不能有 Windows 换行
if grep -rlI "$(printf '\r')" root scripts/apk-scripts; then
	echo "以上文件含 CRLF 换行，请转换为 LF" >&2
	exit 1
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -r root/. "$STAGE/"
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/etc/init.d/mihomo" "$STAGE/etc/init.d/mihomo-substore" "$STAGE/usr/libexec/mihomo-luci/apply-job" "$STAGE/usr/libexec/mihomo-luci/substore-install" "$STAGE/usr/libexec/mihomo-luci/plugin-upgrade"
# 与 OpenWrt 构建的包一样带文件清单与配置文件清单（sysupgrade、default_postinst 会读取）
mkdir -p "$STAGE/lib/apk/packages"
(cd "$STAGE" && find . ! -type d | sed 's|^\.||' | sort) > "$STAGE/lib/apk/packages/$NAME.list"
echo /etc/config/mihomo > "$STAGE/lib/apk/packages/$NAME.conffiles"
echo "/lib/apk/packages/$NAME.list" >> "$STAGE/lib/apk/packages/$NAME.list"
echo "/lib/apk/packages/$NAME.conffiles" >> "$STAGE/lib/apk/packages/$NAME.list"

mkdir -p dist
OUT=dist/$NAME-$VERSION.apk
S=scripts/apk-scripts
# 在用户命名空间里以 root 身份打包，文件属主记为 root（没有 unshare 时用 fakeroot）
ROOTCMD="unshare -r"
unshare -r true 2>/dev/null || ROOTCMD=fakeroot
$ROOTCMD "$APK" mkpkg \
	--info "name:$NAME" \
	--info "version:$VERSION" \
	--info "arch:noarch" \
	--info "description:LuCI support for mihomo (liuran001 eBPF fork)" \
	--info "url:https://github.com/liuran001/mihomo" \
	--info "depends:$DEPENDS" \
	--script "post-install:$S/post-install" \
	--script "post-upgrade:$S/post-upgrade" \
	--script "pre-deinstall:$S/pre-deinstall" \
	--files "$STAGE" \
	--output "$OUT"
echo "已生成 $OUT"
