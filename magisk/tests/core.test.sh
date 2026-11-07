#!/bin/sh
# core.sh / module-update.sh / host.sh netcheck：经脚本入口调用 mihomo-webd（curl、getprop 用测试桩，不联网）。
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
. "$ROOT/tests/webd-bin.sh"
M=$TEST_DIR/module D=$TEST_DIR/data
mkdir -p "$M/scripts" "$D" "$TEST_DIR/bin" "$TEST_DIR/http"
for script in "$ROOT"/scripts/*; do tr -d '\r' <"$script" >"$M/scripts/${script##*/}"; done
install_webd "$M"
printf 'id=mihomo-ebpf\nversion=V1.0.0-26110701\nversionCode=26110701\n' >"$M/module.prop"
export MODDIR=$M MIHOMO_DATA=$D TEST_DIR PATH="$TEST_DIR/bin:$PATH"
assert_equal() {
  [ "$1" = "$2" ] || { printf 'Expected <%s>, got <%s>\n' "$2" "$1" >&2; exit 1; }
}
run() { script=$1; shift; sh "$M/scripts/$script" "$@" 2>/dev/null || true; }
http_file() { printf '%s/http/%s' "$TEST_DIR" "$(printf '%s' "${1#*://}" | tr '/?' '__')"; }
serve() { cp "$2" "$(http_file "$1")"; }
serve_text() { printf '%s' "$2" >"$(http_file "$1")"; }

# curl 测试桩：按 URL 返回 $TEST_DIR/http 下的文件（文件名为 URL 去掉协议、/ ? 换成 _），记录请求
cat >"$TEST_DIR/bin/curl" <<'STUB'
#!/bin/sh
out='' url='' format=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w) format=$2; shift ;;
    -m|--connect-timeout|--max-filesize|--proxy|--noproxy|-A) shift ;;
    --) url=$2; shift ;;
    http*) url=$1 ;;
  esac
  shift
done
echo "$url" >>"$TEST_DIR/curl.log"
file=$TEST_DIR/http/$(printf '%s' "${url#*://}" | tr '/?' '__')
[ -f "$file" ] || exit 22
if [ -n "$out" ] && [ "$out" != /dev/null ]; then cp "$file" "$out"; elif [ -z "$out" ]; then cat "$file"; fi
[ -z "$format" ] || printf '204 0.042'
exit 0
STUB
printf '#!/bin/sh\ncat "$TEST_DIR/abi" 2>/dev/null\n' >"$TEST_DIR/bin/getprop"
chmod 755 "$TEST_DIR/bin/curl" "$TEST_DIR/bin/getprop"

# ---------- 下载设置 ----------
assert_equal "$(run core.sh get_settings)" '{"ok":true,"repo":"liuran001/mihomo","tag":"","mirror":""}'
assert_equal "$(run core.sh settings 'bad repo' - -)" '{"ok":false,"error":"下载设置格式无效"}'
assert_equal "$(run core.sh settings - - ftp://x/)" '{"ok":false,"error":"镜像地址必须使用 http:// 或 https://"}'
printf 'autostart=1\n' >"$D/settings.ini"
assert_equal "$(run core.sh settings - - https://m.example/)" '{"ok":true}'
assert_equal "$(run core.sh get_settings)" '{"ok":true,"repo":"liuran001/mihomo","tag":"","mirror":"https://m.example/"}'
grep -qx 'autostart=1' "$D/settings.ini" || { echo 'settings lost other keys' >&2; exit 1; }
grep -qx 'core_mirror=https://m.example/' "$D/settings.ini" || { echo 'mirror not saved' >&2; exit 1; }
run core.sh settings - - - >/dev/null

# ---------- 检查与下载内核 ----------
API=https://api.github.com/repos/liuran001/mihomo/releases
ASSET=https://example.org/mihomo-android-arm64-v8-alpha-new-ebpf.gz
ASSET32=https://example.org/mihomo-android-armv7-alpha-v7-ebpf.gz
serve_text "$API/latest" '{"tag_name":"Prerelease-Alpha","assets":[{"browser_download_url":"https://example.org/mihomo-android-arm64.sha256"},{"browser_download_url":"'$ASSET'"},{"browser_download_url":"'$ASSET32'"}]}'
printf '#!/bin/sh\necho "Mihomo Meta alpha-new-ebpf android arm64 with go1.27"\n' | gzip -c >"$TEST_DIR/core.gz"
serve "$ASSET" "$TEST_DIR/core.gz"
echo arm64-v8a >"$TEST_DIR/abi"
assert_equal "$(run core.sh info)" '{"ok":true,"installed":false}'
assert_equal "$(run core.sh check)" '{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"","update_available":true}'
# 64 位内核上的 32 位系统：以 ABI 为准
echo armeabi-v7a >"$TEST_DIR/abi"
assert_equal "$(run core.sh check)" '{"ok":true,"latest":"alpha-v7-ebpf","tag":"Prerelease-Alpha","current":"","update_available":true}'
echo x86 >"$TEST_DIR/abi"
# 认不出的 ABI 按 mihomo-webd 自身架构选（测试机上没有对应的资源）
case "$(run core.sh check)" in *'"ok":false'*'架构的内核'*) ;; *) echo 'unknown ABI must fall back to the webd arch' >&2; exit 1 ;; esac
echo arm64-v8a >"$TEST_DIR/abi"
printf '#!/bin/sh\necho "Mihomo Meta alpha-old-ebpf android arm64 with go1.27"\n' >"$D/mihomo"; chmod 755 "$D/mihomo"
assert_equal "$(run core.sh download)" '{"ok":true,"version":"alpha-new-ebpf","tag":"Prerelease-Alpha"}'
assert_equal "$(run core.sh info)" '{"ok":true,"installed":true,"version":"Mihomo Meta alpha-new-ebpf android arm64 with go1.27","can_rollback":"yes"}'
assert_equal "$(run core.sh download)" '{"ok":true,"unchanged":true,"version":"alpha-new-ebpf","tag":"Prerelease-Alpha"}'
assert_equal "$(run core.sh check)" '{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"alpha-new-ebpf","update_available":false}'
assert_equal "$(run core.sh rollback)" '{"ok":true}'
"$D/mihomo" -v | grep -q alpha-old-ebpf || { echo 'rollback did not restore old core' >&2; exit 1; }
# 没有正式版时退回最新的预发布；指定的 tag 不存在时报错
rm -f "$(http_file "$API/latest")"
serve_text "$API?per_page=1" '[{"tag_name":"Only-Pre","assets":[{"browser_download_url":"'$ASSET'"}]}]'
assert_equal "$(run core.sh check)" '{"ok":true,"latest":"alpha-new-ebpf","tag":"Only-Pre","current":"alpha-old-ebpf","update_available":true}'
run core.sh settings - missing - >/dev/null
assert_equal "$(run core.sh check)" '{"ok":false,"error":"获取 release 信息失败"}'
run core.sh settings - - - >/dev/null
# Linux 版内核不能装
printf '#!/bin/sh\necho "Mihomo Meta x linux arm64"\n' | gzip -c >"$TEST_DIR/linux.gz"
serve "$ASSET" "$TEST_DIR/linux.gz"
assert_equal "$(run core.sh download force)" '{"ok":false,"error":"需要可运行的 Android 内核；Linux 内核不支持 Android 包名绕过"}'
"$D/mihomo" -v | grep -q alpha-old-ebpf || { echo 'rejected core replaced the old one' >&2; exit 1; }
left=$(ls "$D/run" | grep -v '^backend.lock$' || true)
[ -z "$left" ] || { echo "temporary files left: $left" >&2; exit 1; }
echo 'core tests passed'

# ---------- 模块更新 ----------
MANIFEST=https://github.com/liuran001/mihomo-frontends/releases/latest/download/update.json
ZIP=https://github.com/liuran001/mihomo-frontends/releases/download/V1.0.1-26110702/mihomo-ebpf-magisk-V1.0.1-26110702.zip
NOTES=https://github.com/liuran001/mihomo-frontends/releases/download/V1.0.1-26110702/changelog.md
serve_text "$MANIFEST" '{
  "version": "V1.0.1-26110702",
  "versionCode": 26110702,
  "zipUrl": "'$ZIP'",
  "changelog": "'$NOTES'",
  "zipSha256": "'"$(printf x | sha256sum | cut -d' ' -f1)"'",
  "luci": {"version": "1.0.1-r26110702"}
}'
assert_equal "$(run module-update.sh current)" '{"ok":true,"current":"V1.0.0-26110701","current_code":26110701}'
assert_equal "$(run module-update.sh check)" '{"ok":true,"current":"V1.0.0-26110701","current_code":26110701,"latest":"V1.0.1-26110702","latest_code":26110702,"update_available":true,"changelog":"'$NOTES'"}'
# 没有 root 管理器时不下载
assert_equal "$(run module-update.sh upgrade)" '{"ok":false,"error":"没有找到 KernelSU、APatch 或 Magisk 的安装命令"}'
if grep -q "$ZIP" "$TEST_DIR/curl.log"; then echo 'downloaded without an installer' >&2; exit 1; fi
rm -f "$(http_file "$MANIFEST")"
assert_equal "$(run module-update.sh check)" '{"ok":false,"error":"获取更新信息失败，请检查网络或下载镜像"}'
echo 'module update tests passed'

# ---------- 连通性检测与出口 IP ----------
for site in www.baidu.com/favicon.ico www.gstatic.com/generate_204 github.githubassets.com/favicon.ico www.youtube.com/favicon.ico; do
  serve_text "https://$site" ''
done
printf 'mixed-port: 7890\n' >"$D/config.yaml"
assert_equal "$(run host.sh netcheck)" '{"ok":true,"via":"proxy","sites":[{"name":"百度","ms":42},{"name":"Google","ms":42},{"name":"GitHub","ms":42},{"name":"YouTube","ms":42}]}'
serve_text https://myip.ipip.net/json '{"ip":"1.2.3.4"}'
rm -f "$D/config.yaml"
assert_equal "$(run host.sh exitip)" '{"ok":true,"via":"direct","cn":"{\"ip\":\"1.2.3.4\"}","intl":""}'
echo 'netcheck tests passed'

# 安装预设：首次写入默认值，已有设置保持不变。
install_dir=$(mktemp -d)
mkdir -p "$install_dir/mod/scripts"
(
  ui_print() { :; }; abort() { exit 1; }; set_perm() { :; }; set_perm_recursive() { :; }
  ARCH=arm64 MODPATH="$install_dir/mod" MIHOMO_DATA="$install_dir/data"
  export ARCH MODPATH MIHOMO_DATA
  . "$(dirname "$0")/../customize.sh"
)
grep -qx 'autostart=1' "$install_dir/data/settings.ini" || { echo 'FAIL preset autostart'; exit 1; }
grep -qx 'core_mirror=https://ghfast.top/' "$install_dir/data/settings.ini" || { echo 'FAIL preset mirror'; exit 1; }
printf 'autostart=0\ncore_mirror=\n' >"$install_dir/data/settings.ini"
(
  ui_print() { :; }; abort() { exit 1; }; set_perm() { :; }; set_perm_recursive() { :; }
  ARCH=arm64 MODPATH="$install_dir/mod" MIHOMO_DATA="$install_dir/data"
  export ARCH MODPATH MIHOMO_DATA
  . "$(dirname "$0")/../customize.sh"
)
grep -qx 'autostart=0' "$install_dir/data/settings.ini" || { echo 'FAIL preset overwrote autostart'; exit 1; }
grep -qx 'core_mirror=' "$install_dir/data/settings.ini" || { echo 'FAIL preset overwrote mirror'; exit 1; }
[ "$(grep -c '^autostart=' "$install_dir/data/settings.ini")" = 1 ] || { echo 'FAIL duplicate preset'; exit 1; }
rm -rf "$install_dir"
echo 'install preset tests passed'
