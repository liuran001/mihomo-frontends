#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/module/scripts" "$TEST_DIR/bin" "$TEST_DIR/data/run"
for script in "$ROOT"/scripts/*.sh "$ROOT"/scripts/policy-*.awk; do
  tr -d '\r' <"$script" >"$TEST_DIR/module/scripts/${script##*/}"
done
export MODDIR=$TEST_DIR/module
export SCRIPTS=$MODDIR/scripts
export MIHOMO_DATA=$TEST_DIR/data
export TEST_DIR
export PATH=$TEST_DIR/bin:$PATH
export ASH_STANDALONE=0
passed=0

check() {
  if "$@"; then passed=$((passed+1)); else echo "FAIL: $*" >&2; exit 1; fi
}
contains() { grep -Fq -- "$2" "$1"; }
b64() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
call_policy() { sh "$SCRIPTS/policy.sh" "$@" >"$TEST_DIR/result"; }
set_policy() { call_policy set "$1" "$2" "$(b64 "$3")" "$(b64 "$4")" "$5" "$(b64 "$6")"; }

cat >"$TEST_DIR/bin/cmd" <<'EOF'
#!/bin/sh
echo 'Unknown command: status'
exit 0
EOF
cat >"$TEST_DIR/bin/dumpsys" <<'EOF'
#!/bin/sh
cat "$TEST_DIR/wifi"
EOF
chmod +x "$TEST_DIR/bin/cmd" "$TEST_DIR/bin/dumpsys"
cat >>"$SCRIPTS/common.sh" <<'EOF'

lock_backend() { ensure_dirs; LOCK_HELD=1; }
unlock_backend() { LOCK_HELD=0; }
boot_intent() { [ -f "$INTENT" ] || atomic_text "$INTENT" stopped; }
pid_alive() { [ -f "$RUN_DIR/fake-running" ]; }
EOF
cat >>"$SCRIPTS/policy-lib.sh" <<'EOF'

validate_runtime() {
  if grep -q 'INVALID_CORE' "$1"; then echo 'mock validation error' >&2; return 1; fi
}
stop_core() { rm -f "$RUN_DIR/fake-running"; }
start_core() {
  if grep -q 'FAIL_START' "$CONFIG"; then echo 'mock start failure' >&2; return 1; fi
  if [ "$(setting_get tethering 0)" = 1 ] && [ -f "$RUN_DIR/fail-tether" ]; then echo 'mock tether failure' >&2; return 1; fi
  policy_render "$CONFIG" "$RUNTIME" || return 1
  touch "$RUN_DIR/fake-running"
}
EOF

cat >"$MIHOMO_DATA/config.yaml" <<'EOF'
secret: 'a\\b"c'
proxies: [{name: DIRECT_TEST, type: direct}]
listeners:
  - name: transparent
    type: ebpf
    mode: hybrid
    local:
      enable: true
      dns-mode: hijack
      exclude-package:
        - com.old.app
      exclude-uid: [0]
    shared:
      enabled: true
      interface: [old0]
      dns-mode: off
rules:
  - MATCH,DIRECT
EOF
cp "$MIHOMO_DATA/config.yaml" "$TEST_DIR/original"
printf '%s\n' 'mWifiInfo SSID: "AndroidWifi", BSSID: 00:13:10:85:fe:01, Supplicant state: COMPLETED' >"$TEST_DIR/wifi"
check call_policy get
check contains "$TEST_DIR/result" '"current_ssid":""'
check contains "$TEST_DIR/result" '"tethering_interfaces":"ap0,wlan1,rndis0,usb0,bt-pan"'
check contains "$TEST_DIR/result" '"autostart":false'
check set_policy 0 0 '' 'com.example.app' only 'AndroidWifi'
check call_policy get
check contains "$TEST_DIR/result" '"allowed":true'
check test ! -f "$MIHOMO_DATA/run/fake-running"
check cmp "$MIHOMO_DATA/config.yaml" "$TEST_DIR/original"

. "$SCRIPTS/common.sh"
. "$SCRIPTS/policy-lib.sh"
check policy_render "$CONFIG" "$TEST_DIR/rendered"
check contains "$TEST_DIR/rendered" 'mode: local'
check contains "$TEST_DIR/rendered" 'dns-mode: respect_policy'
check contains "$TEST_DIR/rendered" 'exclude-package: ["com.example.app"]'
check contains "$TEST_DIR/rendered" 'exclude-uid: [0]'
check contains "$TEST_DIR/rendered" 'secret:'
check sh "$SCRIPTS/mihomo.sh" start
check test -f "$RUN_DIR/fake-running"
check set_policy 1 1 ap0,usb0 '' exclude 'Other'
check test -f "$RUN_DIR/fake-running"
check contains "$RUNTIME" 'mode: hybrid'
check contains "$RUNTIME" 'interface: ["ap0", "usb0"]'

printf '%s\n' 'mWifiInfo SSID: <unknown ssid>, BSSID: <none>, Supplicant state: DISCONNECTED' >"$TEST_DIR/wifi"
check set_policy 1 0 '' '' only AndroidWifi
check test ! -f "$RUN_DIR/fake-running"
check call_policy get
check contains "$TEST_DIR/result" '"allowed":false'
printf '%s\n' 'mWifiInfo SSID: "AndroidWifi", BSSID: 00:13:10:85:fe:01, Supplicant state: COMPLETED' >"$TEST_DIR/wifi"
check call_policy tick
check test -f "$RUN_DIR/fake-running"
check sh "$SCRIPTS/mihomo.sh" stop
check call_policy tick
check test ! -f "$RUN_DIR/fake-running"
check set_policy 1 1 '' '' off ''
check call_policy tick
check test ! -f "$RUN_DIR/fake-running"

printf '%s\n' 'mWifiInfo SSID: <unknown ssid>, BSSID: <none>, Supplicant state: DISCONNECTED' >"$TEST_DIR/wifi"
check set_policy 0 0 '' '' exclude AndroidWifi
check call_policy get
check contains "$TEST_DIR/result" '"allowed":true'
printf '%s\n' 'mWifiInfo SSID: "Cafe, "A"", BSSID: 00:13:10:85:fe:01, Supplicant state: COMPLETED' >"$TEST_DIR/wifi"
check set_policy 0 0 '' '' only 'Cafe, "A"'
check call_policy get
check contains "$TEST_DIR/result" '"current_ssid":"Cafe, \"A\""'
check contains "$TEST_DIR/result" '"allowed":true'
printf '%s\n' '11-04 history mWifiInfo SSID: "Cafe, "A"", BSSID: 00:13:10:85:fe:01, Supplicant state: COMPLETED' 'mWifiInfo SSID: <unknown ssid>, BSSID: <none>, Supplicant state: DISCONNECTED' >"$TEST_DIR/wifi"
check call_policy ssid
check contains "$TEST_DIR/result" '"current_ssid":""'
check set_policy 0 0 '' '' only 'Cafe, "A"'
check call_policy get
check contains "$TEST_DIR/result" '"current_ssid":""'
check contains "$TEST_DIR/result" '"allowed":false'

check set_policy 0 0 '' '' off ''
settings_before=$(file_rev "$SETTINGS")
if set_policy 0 0 'ap0;touch /tmp/injected' '' off ''; then echo 'FAIL injection accepted'; exit 1; fi
check test "$settings_before" = "$(file_rev "$SETTINGS")"
if set_policy 0 0 '' 'com.example;reboot' off ''; then echo 'FAIL invalid package accepted'; exit 1; fi
if set_policy 0 0 '' '' wildcard ''; then echo 'FAIL invalid mode accepted'; exit 1; fi
if call_policy set 0 0 '' '' off 'YQBi'; then echo 'FAIL NUL accepted'; exit 1; fi
check setting_set core_mirror 'https://example.test/a|b&c\d$(touch not-executed)'
check test "$(setting_get core_mirror '')" = 'https://example.test/a|b&c\d$(touch not-executed)'

content=$(b64 "$(cat "$CONFIG")")
check sh "$SCRIPTS/apply.sh" "$content" restart
check test -f "$RUN_DIR/fake-running"
old_revision=$(file_rev "$CONFIG")
if sh "$SCRIPTS/apply.sh" "$(b64 "$(cat "$CONFIG")
# FAIL_START")" restart >"$TEST_DIR/result"; then echo 'FAIL failed start accepted'; exit 1; fi
check test "$old_revision" = "$(file_rev "$CONFIG")"
check test -f "$RUN_DIR/fake-running"
check contains "$TEST_DIR/result" '"ok":false'
check sh "$SCRIPTS/mihomo.sh" stop
if sh "$SCRIPTS/apply.sh" "$(b64 "$(cat "$CONFIG")
# FAIL_START")" restart >"$TEST_DIR/result"; then exit 1; fi
check test ! -f "$RUN_DIR/fake-running"
check test "$old_revision" = "$(file_rev "$CONFIG")"
check test "$(cat "$INTENT")" = stopped

check sh "$SCRIPTS/mihomo.sh" start
touch "$RUN_DIR/fail-tether"
settings_before=$(file_rev "$SETTINGS")
if set_policy 0 1 '' '' off ''; then echo 'FAIL policy restart failure accepted'; exit 1; fi
check test "$settings_before" = "$(file_rev "$SETTINGS")"
check test -f "$RUN_DIR/fake-running"
touch "$MODDIR/disable"
check call_policy tick
check test ! -f "$RUN_DIR/fake-running"
check test "$(cat "$INTENT")" = stopped
rm -f "$MODDIR/disable"

cp "$TEST_DIR/original" "$TEST_DIR/multiple"
cat >>"$TEST_DIR/multiple" <<'EOF'
listeners:
  - name: second
    type: ebpf
EOF
if policy_render "$TEST_DIR/multiple" "$TEST_DIR/rendered" 2>/dev/null; then echo 'FAIL duplicate root accepted'; exit 1; fi
sed '/    type: ebpf/a\  - name: second\n    type: ebpf' "$TEST_DIR/original" >"$TEST_DIR/multiple"
if policy_render "$TEST_DIR/multiple" "$TEST_DIR/rendered" 2>/dev/null; then echo 'FAIL multiple listeners accepted'; exit 1; fi
sed 's/type: ebpf/type: *ebpf/' "$TEST_DIR/original" >"$TEST_DIR/alias"
if policy_render "$TEST_DIR/alias" "$TEST_DIR/rendered" 2>/dev/null; then echo 'FAIL alias accepted'; exit 1; fi
check sh "$SCRIPTS/backup.sh" list
if sh "$SCRIPTS/backup.sh" delete ../../settings.ini >"$TEST_DIR/result"; then echo 'FAIL traversal accepted'; exit 1; fi
check test -f "$SETTINGS"
check sh "$SCRIPTS/mihomo.sh" stop
cp "$TEST_DIR/original" "$BACKUP_DIR/config-test.yaml"
check sh "$SCRIPTS/backup.sh" restore config-test.yaml
check test ! -f "$RUN_DIR/fake-running"
check sh "$SCRIPTS/mihomo.sh" start
printf '%s\n' '# FAIL_START' >>"$BACKUP_DIR/config-test.yaml"
old_revision=$(file_rev "$CONFIG")
if sh "$SCRIPTS/backup.sh" restore config-test.yaml >"$TEST_DIR/result"; then echo 'FAIL restore accepted bad start'; exit 1; fi
check test "$old_revision" = "$(file_rev "$CONFIG")"
check test -f "$RUN_DIR/fake-running"
check atomic_text "$INTENT" auto
check setting_set autostart 0
check call_policy tick
check test -f "$RUN_DIR/fake-running"
check test "$(cat "$INTENT")" = auto
sh "$SCRIPTS/mihomo.sh" status >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"desired":"auto"'
check contains "$TEST_DIR/result" '"allowed":true'
check atomic_text "$INTENT" stopped
check call_policy tick
check test ! -f "$RUN_DIR/fake-running"
# 大配置分段写入：stage 0 清空、后续追加，apply --staged 读取后删除暂存文件。
staged=$(b64 "$(cat "$CONFIG")
# staged-marker")
half=$(( ${#staged} / 2 ))
first=$(printf '%s' "$staged" | cut -c1-"$half")
second=$(printf '%s' "$staged" | cut -c"$((half + 1))"-)
check sh "$SCRIPTS/host.sh" stage 0 "$first"
check sh "$SCRIPTS/host.sh" stage 1 "$second"
check test "$(cat "$RUN_DIR/stage.b64")" = "$staged"
check sh "$SCRIPTS/host.sh" stage 0 "$first"
check test "$(cat "$RUN_DIR/stage.b64")" = "$first"
check sh "$SCRIPTS/host.sh" stage 1 "$second"
check sh "$SCRIPTS/apply.sh" --staged
check contains "$CONFIG" '# staged-marker'
check test ! -f "$RUN_DIR/stage.b64"
if sh "$SCRIPTS/apply.sh" --staged >"$TEST_DIR/result"; then echo 'FAIL missing stage accepted'; exit 1; fi
check contains "$TEST_DIR/result" '暂存配置不存在'
if sh "$SCRIPTS/host.sh" stage 0 'not base64!' >"$TEST_DIR/result"; then echo 'FAIL bad chunk accepted'; exit 1; fi
if sh "$SCRIPTS/host.sh" stage x "$first" >"$TEST_DIR/result"; then echo 'FAIL bad index accepted'; exit 1; fi
rm -f "$RUN_DIR/stage.b64"
if sh "$SCRIPTS/host.sh" stage 1 "$second" >"$TEST_DIR/result"; then echo 'FAIL orphan chunk accepted'; exit 1; fi

# 本机探测：输出合法 JSON，缺少命令时也不失败。
sh "$SCRIPTS/host.sh" probe >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"ok":true'
check contains "$TEST_DIR/result" '"has_config":true'
if command -v node >/dev/null 2>&1; then check node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEST_DIR/result"; fi
if sh "$SCRIPTS/host.sh" fetch 'file:///etc/passwd' >"$TEST_DIR/result"; then echo 'FAIL file url accepted'; exit 1; fi
check contains "$TEST_DIR/result" 'http(s)'

for script in "$SCRIPTS"/*.sh; do check sh -n "$script"; done
printf 'PASS: %s checks (portable pure tests; locks/process launch are mocked)\n' "$passed"
