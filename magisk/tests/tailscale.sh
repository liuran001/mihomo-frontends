#!/bin/sh
# tailscale.sh：状态读取、登录参数校验、退出登录与路径校验（mihomo.sh 用测试桩；登录链接提取的完整用例在 webd/tools_test.go）。
set -eu

ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/module/scripts" "$TEST_DIR/bin" "$TEST_DIR/data/run"
for script in common.sh tailscale.sh; do
  tr -d '\r' <"$ROOT/scripts/$script" >"$TEST_DIR/module/scripts/$script"
done
. "$ROOT/tests/webd-bin.sh"
install_webd "$TEST_DIR/module"
export MODDIR=$TEST_DIR/module SCRIPTS=$TEST_DIR/module/scripts MIHOMO_DATA=$TEST_DIR/data TEST_DIR
export PATH=$TEST_DIR/bin:$PATH
D=$TEST_DIR/data
passed=0
check() { if "$@"; then passed=$((passed+1)); else echo "FAIL: $*" >&2; exit 1; fi; }
has() { grep -Fq -- "$2" "$1"; }
ts() { sh "$SCRIPTS/tailscale.sh" "$@" >"$TEST_DIR/out" 2>"$TEST_DIR/err" || true; }

# 服务脚本测试桩：记录调用，fake-running 表示运行中
cat >"$SCRIPTS/mihomo.sh" <<'EOF'
#!/bin/sh
echo "$1" >>"$TEST_DIR/service.calls"
case "$1" in
  status) if [ -f "$TEST_DIR/fake-running" ]; then echo '{"ok":true,"running":true}'; else echo '{"ok":true,"running":false}'; fi ;;
  stop) [ -d "$TEST_DIR/data/tailscale" ] && echo 'still-present-at-stop' >>"$TEST_DIR/service.calls"; rm -f "$TEST_DIR/fake-running" ;;
  start) touch "$TEST_DIR/fake-running" ;;
esac
EOF
chmod +x "$SCRIPTS/mihomo.sh"

# ---------- state ----------
ts state "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"exists":false}'
mkdir -p "$D/tailscale"
cat >"$D/tailscale/tailscaled.state" <<'EOF'
{
  "_current-profile": "cHJvZmlsZS1kZWE4",
  "_machinekey": "bWFjaGluZWtleS1zZWNyZXQ=",
  "_profiles": "eyJkZWE4Ijp7fX0=",
  "profile-dea8": "cHJpdmF0ZQ=="
}
EOF
ts state "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"exists":true,"current":"cHJvZmlsZS1kZWE4","profiles":"eyJkZWE4Ijp7fX0="}'
check sh -c "! grep -q 'bWFjaGluZWtleS' '$TEST_DIR/out'"
printf '{"_current-profile":"YQ==","_profiles":"Yg=="}' >"$D/tailscale/tailscaled.state"
ts state "$D/tailscale"
check has "$TEST_DIR/out" '"current":"YQ==","profiles":"Yg=="'
for bad in /etc/ts "$D" "$D/../x" "$D/a/../../x" relative; do
  ts state "$bad"
  check has "$TEST_DIR/out" '"ok":false'
done

# ---------- login ----------
# 控制器连不上时等到超时，报告未运行
ts login http://127.0.0.1:9 TS TS 1
check has "$TEST_DIR/out" '{"ok":true,"url":null,"running":false}'
ts login http://10.0.0.1:9090 TS TS 5
check has "$TEST_DIR/out" '控制器地址必须是本机'
ts login http://127.0.0.1:9090 'a/b' TS 5
check has "$TEST_DIR/out" '出站名编码无效'
ts login http://127.0.0.1:9090 TS TS 'x'
check has "$TEST_DIR/out" '等待时间无效'

# ---------- logout ----------
mkdir -p "$D/tailscale"; touch "$D/tailscale/tailscaled.state"
rm -f "$TEST_DIR/service.calls" "$TEST_DIR/fake-running"
ts logout "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"restarted":false}'
check test ! -e "$D/tailscale"
mkdir -p "$D/tailscale"; touch "$TEST_DIR/fake-running"; rm -f "$TEST_DIR/service.calls"
ts logout "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"restarted":true}'
check test ! -e "$D/tailscale"
check test -f "$TEST_DIR/fake-running"
check test "$(tr '\n' ' ' <"$TEST_DIR/service.calls")" = 'status stop still-present-at-stop start '
ts logout /data/adb
check has "$TEST_DIR/out" '"ok":false'

# ---------- open ----------
ts open 'javascript:alert(1)'
check has "$TEST_DIR/out" '链接无效'

echo "PASS: $passed tailscale checks"
