#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/scripts"
for script in common.sh policy-lib.sh; do
  tr -d '\r' <"$ROOT/scripts/$script" >"$TEST_DIR/scripts/$script"
done
MODDIR=$TEST_DIR
SCRIPTS=$TEST_DIR/scripts
MIHOMO_DATA=$TEST_DIR/data
# legacy 用例需要轮询三次（未启动 → 404 → 就绪），CI 机器较慢时留足余量
MIHOMO_START_TIMEOUT=6
. "$SCRIPTS/common.sh"
. "$SCRIPTS/policy-lib.sh"
ensure_dirs
printf 'test source\n' >"$CONFIG"
printf '#!/bin/sh\nexit 0\n' >"$BIN"
chmod +x "$BIN"
policy_render() { cp "$1" "$2"; }
validate_runtime() { return 0; }
pid_alive() { [ -f "$RUN_DIR/mock-running" ]; }
stop_core() { rm -f "$RUN_DIR/mock-running"; touch "$RUN_DIR/mock-stopped"; }
tool() {
  case "$1" in
    setsid) touch "$RUN_DIR/mock-running" ;;
    curl)
      if [ "$6" != "$CONTROL_SOCKET" ] || { [ "$7" != http://localhost/ebpf/summary ] && [ "$7" != http://localhost/ebpf ]; }; then
        echo 'wrong readiness endpoint' >&2; return 1
      fi
      printf '%s\n' "$7" >>"$RUN_DIR/mock-endpoints"
      case "$(cat "$RUN_DIR/mock-response")" in
        missing) printf '404\n' ;;
        empty) printf '{"inbounds":[]}\n200\n' ;;
        ready) printf '{"inbounds":[{"id":1,"mode":"local"}]}\n200\n' ;;
        legacy)
          if [ "$7" = http://localhost/ebpf/summary ]; then printf '404\n'
          else printf '{"inbounds":[{"id":1,"mode":"local"}]}\n200\n'; fi
          ;;
      esac
      ;;
    *) return 127 ;;
  esac
}
for response in missing empty ready legacy; do
  printf '%s\n' "$response" >"$RUN_DIR/mock-response"
  rm -f "$RUN_DIR/mock-running" "$RUN_DIR/mock-stopped"
  : >"$RUN_DIR/mock-endpoints"
  if start_core >"$TEST_DIR/result" 2>&1; then
    { [ "$response" = ready ] || [ "$response" = legacy ]; } || { echo "FAIL: accepted $response /ebpf"; exit 1; }
    test -f "$RUN_DIR/mock-running"
  else
    { [ "$response" != ready ] && [ "$response" != legacy ]; } || { cat "$TEST_DIR/result"; exit 1; }
    test -f "$RUN_DIR/mock-stopped"
    test ! -f "$RUN_DIR/mock-running"
    grep -q '/ebpf' "$TEST_DIR/result"
  fi
  if [ "$response" = ready ] || [ "$response" = empty ]; then
    ! grep -qx 'http://localhost/ebpf' "$RUN_DIR/mock-endpoints"
  fi
done
echo 'PASS: real start_core rejects missing/empty /ebpf and accepts nonempty (process/network mocked)'
