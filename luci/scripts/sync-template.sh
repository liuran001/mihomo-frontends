#!/bin/sh
# 仓库根 shared/ 下的共用文件同步到 luci 的 root/ 下（生成的文件不入库）：
#   shared/template.yaml  → root/usr/share/mihomo-luci/template.yaml
#   shared/proxylink.js   → root/www/luci-static/resources/mihomo/proxylink.js（包装为 LuCI 模块）
# build-apk.sh、deploy.sh、tests/preview/snapshot.sh、tests/frontend/run.js 运行前都会调用。
set -e
cd "$(dirname "$0")/.."
SRC=../shared/template.yaml
DST=root/usr/share/mihomo-luci/template.yaml
if [ ! -f "$SRC" ]; then
	echo "缺少 $SRC（模板应放在仓库根的 shared/ 下）" >&2
	exit 1
fi
if ! cmp -s "$SRC" "$DST" 2>/dev/null; then
	mkdir -p "$(dirname "$DST")"
	cp "$SRC" "$DST"
	echo "已同步模板 shared/template.yaml → $DST"
fi

# LuCI 模块的函数体：shared 文件按 CommonJS 方式把接口写进 module.exports，再交给 baseclass
SRC=../shared/proxylink.js
DST=root/www/luci-static/resources/mihomo/proxylink.js
TMP=$DST.tmp
{
	printf "'use strict';\n'require baseclass';\n// 由 scripts/sync-template.sh 从 shared/proxylink.js 生成，请修改源文件\n"
	printf "const module = { exports: null };\n"
	cat "$SRC"
	printf "\nreturn baseclass.extend(module.exports);\n"
} > "$TMP"
if cmp -s "$TMP" "$DST" 2>/dev/null; then
	rm -f "$TMP"
else
	mv "$TMP" "$DST"
	echo "已同步 shared/proxylink.js → $DST"
fi
