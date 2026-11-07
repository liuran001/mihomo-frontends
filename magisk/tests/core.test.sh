#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEST_DIR=$(mktemp -d)
TMPDIR=$TEST_DIR
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
sed '/^case "\$1" in/,$d' "$ROOT/scripts/core.sh" | sed '/^\. /d' > "$TEST_DIR/functions.sh"
. "$TEST_DIR/functions.sh"
assert_equal() {
  [ "$1" = "$2" ] || { printf 'Expected <%s>, got <%s>\n' "$2" "$1" >&2; exit 1; }
}
uname() { echo aarch64; }
assert_equal "$(abi_asset)" android-arm64
uname() { echo x86_64; }
assert_equal "$(abi_asset)" android-amd64
assets='{"assets":[{"browser_download_url":"https://example.org/mihomo-linux-arm64-v1.gz"},{"browser_download_url":"https://example.org/mihomo-android-arm64.sha256"},{"browser_download_url":"https://example.org/mihomo-android-arm64-v8-alpha-ebpf.gz"}]}'
assert_equal "$(printf '%s' "$assets" | select_asset android-arm64)" https://example.org/mihomo-android-arm64-v8-alpha-ebpf.gz
assert_equal "$(printf '%s' "$assets" | select_asset android-amd64)" ''
core_repo() { echo liuran001/mihomo; }
core_tag() { echo ''; }
core_mirror() { echo ''; }
fetch_release() {
  case "$1" in
    */latest) return 1 ;;
    *releases?per_page=1) echo '[{"tag_name":"Prerelease-Alpha"}]' ;;
    *) return 1 ;;
  esac
}
assert_equal "$(latest_json)" '[{"tag_name":"Prerelease-Alpha"}]'
core_tag() { echo missing-tag; }
if latest_json >/dev/null; then echo 'Explicit tag must not fall back' >&2; exit 1; fi
printf '#!/bin/sh\necho "Mihomo Meta test android arm64 with go1.27"\necho "Use tags: with_gvisor"\n' > "$TEST_DIR/android"
printf '#!/bin/sh\necho "Mihomo Meta test linux arm64 with go1.27"\n' > "$TEST_DIR/linux"
chmod 755 "$TEST_DIR/android" "$TEST_DIR/linux"
check_core "$TEST_DIR/android"
if check_core "$TEST_DIR/linux"; then echo 'Linux core must be rejected' >&2; exit 1; fi
assert_equal "$(release_version https://example.org/mihomo-android-arm64-v8-alpha-smart-0cc66a1-ebpf.gz android-arm64)" alpha-smart-0cc66a1-ebpf
assert_equal "$(release_version https://example.org/mihomo-android-amd64-alpha-smart-0cc66a1-ebpf.gz android-amd64)" alpha-smart-0cc66a1-ebpf
assert_equal "$(release_version https://example.org/mihomo-android-arm64-v8-v1.19.0.gz android-arm64)" v1.19.0
# check 与 download 的同版本判断（不联网：替换取 release 与下载）
uname() { echo aarch64; }
core_tag() { echo ''; }
RUN_DIR=$TEST_DIR/run; mkdir -p "$RUN_DIR"
ensure_dirs() { :; }
json_escape() { printf '%s' "$1"; }
latest_json() { echo '{"tag_name":"Prerelease-Alpha","assets":[{"browser_download_url":"https://example.org/mihomo-android-arm64-v8-alpha-new-ebpf.gz"}]}'; }
BIN=$TEST_DIR/installed
printf '#!/bin/sh\necho "Mihomo Meta alpha-old-ebpf android arm64 with go1.27"\n' >"$BIN"; chmod 755 "$BIN"
assert_equal "$(check)" '{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"alpha-old-ebpf","update_available":true}'
printf '#!/bin/sh\necho "Mihomo Meta alpha-new-ebpf android arm64 with go1.27"\n' >"$BIN"
assert_equal "$(check)" '{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"alpha-new-ebpf","update_available":false}'
assert_equal "$(download)" '{"ok":true,"unchanged":true,"version":"alpha-new-ebpf","tag":"Prerelease-Alpha"}'
rm -f "$BIN"
assert_equal "$(check)" '{"ok":true,"latest":"alpha-new-ebpf","tag":"Prerelease-Alpha","current":"","update_available":true}'
printf 'core tests passed\n'

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
