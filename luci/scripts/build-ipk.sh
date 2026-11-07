#!/bin/sh
# 给使用 opkg 的 OpenWrt 24.10 打 ipk 包（23.05 的 ucode 缺 socket 模块，不支持），不依赖 OpenWrt SDK：在 Linux（如 WSL）里运行 sh scripts/build-ipk.sh，
# 输出 dist/luci-app-mihomo-ebpf_<版本>_all.ipk。安装：opkg install luci-app-mihomo-ebpf_<版本>_all.ipk
# ipk 的格式：gzip 压缩的 tar，内含 debian-binary、control.tar.gz（control 与安装脚本）、data.tar.gz（文件）。
set -e
cd "$(dirname "$0")/.."
sh scripts/sync-template.sh
NAME=luci-app-mihomo-ebpf
mk() { sed -n "s/^$1:=//p" Makefile; }
VERSION=$(mk PKG_VERSION)-r$(mk PKG_RELEASE)
# Makefile 里是 +a +b，control 里要写成 a, b
DEPENDS=$(mk LUCI_DEPENDS | sed 's/+//g; s/^ *//; s/ *$//; s/  */, /g')

if grep -rlI "$(printf '\r')" root scripts/apk-scripts; then
	echo "以上文件含 CRLF 换行，请转换为 LF" >&2
	exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
DATA=$WORK/data CTRL=$WORK/control
mkdir -p "$DATA" "$CTRL"
cp -r root/. "$DATA/"
find "$DATA" -type d -exec chmod 755 {} +
find "$DATA" -type f -exec chmod 644 {} +
chmod 755 "$DATA/etc/init.d/mihomo" "$DATA/etc/init.d/mihomo-substore" "$DATA/usr/libexec/mihomo-luci/apply-job" "$DATA/usr/libexec/mihomo-luci/substore-install" "$DATA/usr/libexec/mihomo-luci/plugin-upgrade"

SIZE=$(du -sb "$DATA" | cut -f1)
cat >"$CTRL/control" <<EOF
Package: $NAME
Version: $VERSION
Depends: $DEPENDS
Source: https://github.com/liuran001/mihomo-frontends
SourceName: $NAME
Section: luci
URL: https://github.com/liuran001/mihomo
Architecture: all
Installed-Size: $SIZE
Description: LuCI support for mihomo (liuran001 eBPF fork)
EOF
echo /etc/config/mihomo >"$CTRL/conffiles"
# opkg 安装与升级都只运行 postinst；升级时不运行旧包的 prerm（以防万一，收到 upgrade 参数时也跳过）
S=scripts/apk-scripts
{
	echo '#!/bin/sh'
	echo '[ -n "$IPKG_INSTROOT" ] && exit 0'
	echo 'rm -f /tmp/mihomo-luci-reinstall'
	sed '1d' "$S/post-upgrade"
} >"$CTRL/postinst"
{
	echo '#!/bin/sh'
	echo '[ -n "$IPKG_INSTROOT" ] && exit 0'
	echo '[ "$1" = upgrade ] && exit 0'
	# opkg --force-reinstall 会先按卸载流程运行 prerm；重装方事先放下这个标记，避免停掉服务、取消自启
	echo '[ -e /tmp/mihomo-luci-reinstall ] && exit 0'
	sed '1d' "$S/pre-deinstall"
} >"$CTRL/prerm"
chmod 755 "$CTRL/postinst" "$CTRL/prerm"
chmod 644 "$CTRL/control" "$CTRL/conffiles"

T="tar --format=gnu --numeric-owner --owner=0 --group=0 --sort=name --mtime=@0"
(cd "$DATA" && $T -czf "$WORK/data.tar.gz" .)
(cd "$CTRL" && $T -czf "$WORK/control.tar.gz" .)
echo 2.0 >"$WORK/debian-binary"
mkdir -p dist
OUT=dist/${NAME}_${VERSION}_all.ipk
(cd "$WORK" && $T -czf pkg.ipk ./debian-binary ./control.tar.gz ./data.tar.gz)
mv "$WORK/pkg.ipk" "$OUT"
echo "已生成 $OUT"
