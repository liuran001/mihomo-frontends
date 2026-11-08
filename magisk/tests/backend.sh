#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/module/scripts" "$TEST_DIR/bin" "$TEST_DIR/data/run"
for script in "$ROOT"/scripts/*.sh "$ROOT"/scripts/policy-*.awk "$ROOT"/scripts/discovery-*.awk; do
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
reload_core() {
  pid_alive || return 1
  if grep -Eq 'FAIL_RELOAD|FAIL_START' "$RUNTIME"; then echo 'mock reload failure' >&2; return 1; fi
  if grep -q 'mode: hybrid' "$RUNTIME" && [ -f "$RUN_DIR/fail-tether" ]; then echo 'mock tether reload failure' >&2; return 1; fi
  cp "$RUNTIME" "$RUN_DIR/reloaded"
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
# 共享网卡模式：全部（常见共享网卡 + 当前出现的共享网卡）、排除所选
mkdir -p "$TEST_DIR/sysnet/ap_br_wlan2" "$TEST_DIR/sysnet/wlan0" "$TEST_DIR/sysnet/rmnet_data0"
export MIHOMO_DISCOVERY_SYS_NET=$TEST_DIR/sysnet
check call_policy set 1 1 "$(b64 ap0,usb0)" '' exclude "$(b64 Other)" all ''
check contains "$RUNTIME" 'interface: ["ap0", "ap1", "swlan0", "softap0", "wlan1", "wlan2", "rndis0", "rndis1", "usb0", "usb1", "ncm0", "ncm1", "bt-pan", "bnep0", "bnep1", "ap_br_wlan2"]'
check call_policy get
check contains "$TEST_DIR/result" '"tethering_mode":"all"'
check contains "$TEST_DIR/result" '"tethering_interfaces":"ap0,usb0"'
check call_policy set 1 1 "$(b64 ap0,usb0)" '' exclude "$(b64 Other)" exclude "$(b64 usb0,ncm0)"
check contains "$RUNTIME" 'interface: ["ap0", "ap1", "swlan0", "softap0", "wlan1", "wlan2", "rndis0", "rndis1", "usb1", "ncm1", "bt-pan", "bnep0", "bnep1", "ap_br_wlan2"]'
check contains "$TEST_DIR/result" '"ok":true'
if call_policy set 1 1 "$(b64 ap0)" '' exclude "$(b64 Other)" bogus ''; then echo 'FAIL: invalid mode accepted' >&2; exit 1; fi
if call_policy set 1 1 "$(b64 ap0)" '' exclude "$(b64 Other)" exclude "$(b64 'a;b')"; then echo 'FAIL: invalid exclude accepted' >&2; exit 1; fi
# 旧调用方（六个参数）保持已存的模式
check set_policy 1 1 ap0,usb0 '' exclude 'Other'
check call_policy get
check contains "$TEST_DIR/result" '"tethering_mode":"exclude"'
check contains "$TEST_DIR/result" '"tethering_exclude":"usb0,ncm0"'
# 回到仅所选，后面的用例沿用原来的行为
check call_policy set 1 1 "$(b64 ap0,usb0)" '' exclude "$(b64 Other)" only ''
check contains "$RUNTIME" 'interface: ["ap0", "usb0"]'
unset MIHOMO_DISCOVERY_SYS_NET

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

# 热重载：运行中走 PUT /configs；控制器设置变了或重载失败时改为重启；未运行时只保存。
check sh "$SCRIPTS/mihomo.sh" start
rm -f "$RUN_DIR/reloaded"
sh "$SCRIPTS/apply.sh" "$(b64 "$(cat "$CONFIG")
# reload-marker")" reload >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"result":"reloaded"'
check contains "$RUN_DIR/reloaded" '# reload-marker'
check contains "$CONFIG" '# reload-marker'
check test -f "$RUN_DIR/fake-running"
rm -f "$RUN_DIR/reloaded"
sh "$SCRIPTS/apply.sh" "$(b64 "$(sed 's/^secret:.*/secret: changed/' "$CONFIG")")" reload >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"result":"restarted"'
check test ! -f "$RUN_DIR/reloaded"
check contains "$CONFIG" 'secret: changed'
check test -f "$RUN_DIR/fake-running"
sh "$SCRIPTS/apply.sh" "$(b64 "$(cat "$CONFIG")
# FAIL_RELOAD")" reload >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"result":"restarted"'
check contains "$CONFIG" '# FAIL_RELOAD'
check test -f "$RUN_DIR/fake-running"
old_revision=$(file_rev "$CONFIG")
if sh "$SCRIPTS/apply.sh" "$(b64 "$(cat "$CONFIG")
# FAIL_RELOAD
# FAIL_START")" reload >"$TEST_DIR/result"; then echo 'FAIL reload+start failure accepted'; exit 1; fi
check test "$old_revision" = "$(file_rev "$CONFIG")"
check test -f "$RUN_DIR/fake-running"
check sh "$SCRIPTS/mihomo.sh" stop
sh "$SCRIPTS/apply.sh" "$(b64 "$(cat "$TEST_DIR/original")")" reload >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"result":"saved"'
check test ! -f "$RUN_DIR/fake-running"
# 共享设置变化时同样先热重载
rm -f "$RUN_DIR/fail-tether"
check sh "$SCRIPTS/mihomo.sh" start
rm -f "$RUN_DIR/reloaded"
check set_policy 0 1 ap0 '' off ''
check contains "$TEST_DIR/result" '"result":"reloaded"'
check contains "$RUN_DIR/reloaded" 'interface: ["ap0"]'
check sh "$SCRIPTS/mihomo.sh" stop

# 共享设备：邻居表里共享网卡上的设备，排除上游网卡与无效条目，补上 DHCP 主机名
cat >"$TEST_DIR/bin/ip" <<'EOF'
#!/bin/sh
case "$*" in
  'neigh show') cat "$TEST_DIR/neigh" ;;
  *route*) printf 'default via 192.168.1.1 dev wlan0 table 1001\n' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TEST_DIR/bin/ip"
cat >"$TEST_DIR/neigh" <<'EOF'
192.168.1.1 dev wlan0 lladdr 11:22:33:44:55:66 REACHABLE
192.168.43.5 dev ap0 lladdr AA:BB:CC:00:11:22 STALE
2408:8000::5 dev ap0 lladdr aa:bb:cc:00:11:22 REACHABLE
fe80::1 dev ap0 lladdr aa:bb:cc:00:11:22 STALE
192.168.43.9 dev ap0  FAILED
192.168.42.7 dev rndis0 lladdr de:ad:be:ef:00:01 DELAY
EOF
printf '1700000 aa:bb:cc:00:11:22 192.168.43.5 Pixel-7 *\n' >"$TEST_DIR/leases"
MIHOMO_DISCOVERY_LEASES=$TEST_DIR/leases MIHOMO_DISCOVERY_TMP_DIR=$TEST_DIR sh "$SCRIPTS/discovery.sh" clients >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"tethering":true'
check contains "$TEST_DIR/result" '{"mac":"aa:bb:cc:00:11:22","iface":"ap0","ipv4":"192.168.43.5","ipv6":["2408:8000::5"],"name":"Pixel-7","state":"REACHABLE"}'
check contains "$TEST_DIR/result" '"mac":"de:ad:be:ef:00:01","iface":"rndis0"'
if contains "$TEST_DIR/result" '11:22:33:44:55:66'; then echo 'FAIL upstream neighbour listed'; exit 1; fi
if command -v node >/dev/null 2>&1; then check node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEST_DIR/result"; fi
rm -f "$TEST_DIR/bin/ip"

# 本机探测：输出合法 JSON，缺少命令时也不失败。
sh "$SCRIPTS/host.sh" probe >"$TEST_DIR/result"
check contains "$TEST_DIR/result" '"ok":true'
check contains "$TEST_DIR/result" '"has_config":true'
if command -v node >/dev/null 2>&1; then check node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TEST_DIR/result"; fi
if sh "$SCRIPTS/host.sh" fetch 'file:///etc/passwd' >"$TEST_DIR/result"; then echo 'FAIL file url accepted'; exit 1; fi
check contains "$TEST_DIR/result" 'http(s)'

# Wi-Fi 事件触发巡检：ip monitor 报出 wlan 事件后立即检查，不等 30 秒的兜底间隔；非 wlan 事件忽略；退出时清理
check set_policy 0 0 '' '' only AndroidWifi
cat >"$TEST_DIR/bin/flock" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$TEST_DIR/bin/cmd" <<'EOF'
#!/bin/sh
echo x >>"$TEST_DIR/ssid-queries"
echo 'Unknown command: status'
EOF
cat >"$TEST_DIR/bin/ip" <<'EOF'
#!/bin/sh
if [ "$1" = -o ] && [ "$2" = monitor ]; then
  sleep 2; echo '5: rmnet_data0    inet 10.0.0.2/30 scope global rmnet_data0'
  sleep 2; echo '3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500'
  exec sleep 60
fi
exit 1
EOF
chmod +x "$TEST_DIR/bin/flock" "$TEST_DIR/bin/cmd" "$TEST_DIR/bin/ip"
: >"$TEST_DIR/ssid-queries"
atomic_text "$INTENT" manual
MIHOMO_POLICY_INTERVAL=30 MIHOMO_WIFI_SETTLE=0 sh "$SCRIPTS/policy.sh" watch &
watcher=$!
sleep 3
queries_before_event=$(wc -l <"$TEST_DIR/ssid-queries")
sleep 4
queries_after_event=$(wc -l <"$TEST_DIR/ssid-queries")
fifo_present=no; [ -p "$RUN_DIR/wifi-events" ] && fifo_present=yes
# 先停掉巡检再断言，断言失败退出时不会留下占着输出管道的后台进程
kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null || :
echo "watch: before=$queries_before_event after=$queries_after_event fifo=$fifo_present"
check test "$queries_before_event" -eq 1
check test "$queries_after_event" -eq 2
check test "$fifo_present" = yes
check test ! -e "$RUN_DIR/wifi-events"
rm -f "$TEST_DIR/bin/ip" "$TEST_DIR/bin/flock"

for script in "$SCRIPTS"/*.sh; do check sh -n "$script"; done
printf 'PASS: %s checks (portable pure tests; locks/process launch are mocked)\n' "$passed"
