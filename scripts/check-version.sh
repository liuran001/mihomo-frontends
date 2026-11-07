#!/bin/sh
# 检查各处版本号一致：VERSION（唯一来源，格式 V主.次.修订-构建号）、模块 module.prop、LuCI 的 Makefile 与 version 文件。
# 用法：sh scripts/check-version.sh [标签]；给出标签（发布时）还要求标签与 VERSION 相同。
# 成功时输出：<版本> <构建号> <LuCI 包版本>
set -eu
cd "$(dirname "$0")/.."
fail() { printf '版本检查失败：%s\n' "$*" >&2; exit 1; }

version=$(tr -d '\r\n' <VERSION)
case "$version" in
	V[0-9]*.[0-9]*.[0-9]*-[0-9]*) ;;
	*) fail "VERSION 格式应为 V1.2.3-26110701：$version" ;;
esac
semver=${version#V}; semver=${semver%%-*}
code=${version##*-}
case "$semver" in *[!0-9.]*) fail "版本号只能是数字与点：$semver" ;; esac
case "$code" in *[!0-9]*|'') fail "构建号只能是数字：$code" ;; esac

prop() { sed -n "s/^$1=//p" magisk/module.prop | tr -d '\r'; }
[ "$(prop version)" = "$version" ] || fail "module.prop 的 version 是 $(prop version)，应为 $version"
[ "$(prop versionCode)" = "$code" ] || fail "module.prop 的 versionCode 是 $(prop versionCode)，应为 $code"

mk() { sed -n "s/^$1:=//p" luci/Makefile | tr -d '\r'; }
[ "$(mk PKG_VERSION)" = "$semver" ] || fail "luci/Makefile 的 PKG_VERSION 是 $(mk PKG_VERSION)，应为 $semver"
[ "$(mk PKG_RELEASE)" = "$code" ] || fail "luci/Makefile 的 PKG_RELEASE 是 $(mk PKG_RELEASE)，应为 $code"
[ "$(tr -d '\r\n' <luci/root/usr/share/mihomo-luci/version)" = "$version" ] || fail 'luci/root/usr/share/mihomo-luci/version 与 VERSION 不一致'

if [ $# -gt 0 ] && [ "$1" != "$version" ]; then
	fail "标签 $1 与 VERSION（$version）不一致"
fi
printf '%s %s %s\n' "$version" "$code" "$semver-r$code"
