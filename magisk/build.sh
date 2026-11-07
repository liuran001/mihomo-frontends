#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

skip_webui_build=0
for option do
  case "$option" in
    --skip-webui-build) skip_webui_build=1 ;;
    -h|--help)
      printf '%s\n' '用法：sh magisk/build.sh [--skip-webui-build]'
      exit 0
      ;;
    *) fail "未知参数：$option" ;;
  esac
done

module_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$module_root/.." && pwd -P)
webui_root="$module_root/webui"
web_dist="$webui_root/build/dist/wasmJs/productionExecutable"
dist="$repo_root/dist"

command -v zip >/dev/null 2>&1 || fail '缺少 zip 命令'
version=$(sed -n 's/^version=//p' "$module_root/module.prop" | tr -d '\r')
id=$(sed -n 's/^id=//p' "$module_root/module.prop" | tr -d '\r')
for value in "$id" "$version"; do
  case "$value" in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._+-]*) fail 'module.prop 的 id/version 缺失或不适合用作文件名' ;;
  esac
done
out="$dist/${id}-magisk-${version}.zip"

if [ "$skip_webui_build" -eq 0 ]; then
  (
    cd -- "$webui_root"
    sh ./gradlew --no-daemon wasmJsBrowserDistribution
  )
fi

[ -d "$web_dist" ] && [ ! -L "$web_dist" ] || fail "缺少普通 WebUI 产物目录：$web_dist；请先构建 wasmJsBrowserDistribution"
[ -d "$module_root/scripts" ] && [ ! -L "$module_root/scripts" ] || fail 'scripts 必须是普通目录'
links=$(find "$web_dist" "$module_root/scripts" -type l -print)
[ -z "$links" ] || fail '打包源不能包含符号链接'
for name in index.html mihomo.js bootstrap.js backend.js config.js proxylink.js vendor/yaml.min.js vendor/YAML-LICENSE.txt vendor/qrcode.js vendor/QRCODE-LICENSE.txt template.yaml FONT-LICENSE.txt; do
  [ -f "$web_dist/$name" ] && [ -s "$web_dist/$name" ] || fail "WebUI 产物缺失或为空：$name"
done
wasm_files=$(find "$web_dist" -type f -name '*.wasm' -print)
empty_assets=$(find "$web_dist" -type f -name '*.wasm' -size 0 -print)
[ -n "$wasm_files" ] && [ -z "$empty_assets" ] || fail 'WebUI 产物缺少非空 wasm；拒绝打包旧 webroot'
font_files=$(find "$web_dist" -type f -name 'noto_sans_sc.otf' ! -size 0 -print)
[ -n "$font_files" ] || fail 'WebUI 产物缺少离线中文字体；拒绝打包'
for name in module.prop customize.sh service.sh post-fs-data.sh; do
  [ -f "$module_root/$name" ] && [ ! -L "$module_root/$name" ] || fail "模块文件必须是普通文件：$name"
done

[ ! -L "$dist" ] || fail "dist 不能是符号链接：$dist"
mkdir -p -- "$dist"
if [ -e "$out" ] || [ -L "$out" ]; then
  [ -f "$out" ] && [ ! -L "$out" ] || fail "拒绝覆盖目录或符号链接：$out"
fi

stage=''
cleanup() {
  [ -n "$stage" ] || return 0
  case "$stage" in
    "$dist"/.magisk.*)
      if [ "${stage%/*}" = "$dist" ] && [ -d "$dist" ] && [ ! -L "$dist" ] && [ ! -L "$stage" ]; then
        rm -rf -- "$stage"
      else
        printf '%s\n' "拒绝清理边界不明的临时目录：$stage" >&2
        return 1
      fi
      ;;
    *) printf '%s\n' "拒绝清理 dist 之外的目录：$stage" >&2; return 1 ;;
  esac
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
stage=$(mktemp -d "$dist/.magisk.XXXXXXXX")

for name in module.prop customize.sh service.sh post-fs-data.sh; do
  cp -- "$module_root/$name" "$stage/$name"
done
cp -R -- "$module_root/scripts" "$stage/scripts"
mkdir -- "$stage/webroot"
cp -R -- "$web_dist/." "$stage/webroot/"
# 网页资源只打包原文件：gzip 副本由 customize.sh 安装时生成（避免安装包里同一份资源存两遍）；
# source map 只用于调试，不打包
find "$stage/webroot" -type f \( -name '*.map' -o -name '*.gz' \) -exec rm -f {} +
# 网页管理服务：静态链接的 Linux 程序，customize.sh 按 ARCH 保留其一
command -v go >/dev/null 2>&1 || fail '缺少 go，无法构建 mihomo-webd'
(
  cd -- "$module_root/webd"
  go run . assets -data "$module_root/scrcpy-assets/out"
)
mkdir -p "$stage/bin/scrcpy"
for asset in scrcpy-server-v5.0.1.jar jmuxer.min.js; do
  cp "$module_root/scrcpy-assets/out/$asset" "$stage/bin/scrcpy/$asset"
done
# 第三方许可合并成模块根目录下的一个文件，不再分散在各目录
licenses=$stage/THIRD-PARTY-LICENSES.txt
: >"$licenses"
add_license() {
  printf '==================== %s ====================\n\n' "$1" >>"$licenses"
  tr -d '\r' <"$2" >>"$licenses"
  printf '\n\n' >>"$licenses"
}
add_license 'mihomo-webd 的 Go 依赖' "$module_root/webd/THIRD-PARTY-NOTICES.txt"
add_license 'Noto Sans CJK（界面字体子集）' "$stage/webroot/FONT-LICENSE.txt"
add_license 'yaml' "$stage/webroot/vendor/YAML-LICENSE.txt"
add_license 'qrcode' "$stage/webroot/vendor/QRCODE-LICENSE.txt"
add_license 'scrcpy server 5.0.1' "$module_root/scrcpy-assets/out/SCRCPY-LICENSE.txt"
add_license 'JMuxer 2.1.4' "$module_root/scrcpy-assets/out/JMUXER-LICENSE.txt"
rm -f "$stage/webroot/FONT-LICENSE.txt" "$stage/webroot/vendor/YAML-LICENSE.txt" "$stage/webroot/vendor/QRCODE-LICENSE.txt"
for target in arm64:arm64 x64:amd64 arm:arm; do
  (
    cd -- "$module_root/webd"
    GOOS=linux GOARCH=${target#*:} GOARM=7 CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o "$stage/bin/${target%%:*}/mihomo-webd" .
  )
done
JAVA_HOME=${JAVA_HOME:-} sh "$module_root/device-helper/build.sh" "$stage/device-helper"
cp "$stage/device-helper/device-control.jar" "$stage/bin/device-control.jar"
(
  cd -- "$stage"
  ZIPOPT='' zip -q -r -X "$stage/module.zip" module.prop customize.sh service.sh post-fs-data.sh THIRD-PARTY-LICENSES.txt scripts webroot bin
)
[ ! -L "$dist" ] || fail "dist 不能是符号链接：$dist"
if [ -e "$out" ] || [ -L "$out" ]; then
  [ -f "$out" ] && [ ! -L "$out" ] || fail "拒绝覆盖目录或符号链接：$out"
fi
mv -f -- "$stage/module.zip" "$out"
printf '已生成 %s\n' "$out"
