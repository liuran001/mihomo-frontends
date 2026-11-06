#!/bin/sh
set -eu
# dash（Ubuntu 的 sh）不支持两位数的文件描述符；设备上的 mksh/ash 支持。这里需要测 12、19 号描述符，改用 bash 运行
if ! (eval 'exec 12>/dev/null') 2>/dev/null; then
  command -v bash >/dev/null 2>&1 || { echo 'SKIP: 当前 sh 不支持两位数文件描述符且没有 bash'; exit 0; }
  exec bash "$0" "$@"
fi
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
. "$SCRIPTS/common.sh"
. "$SCRIPTS/policy-lib.sh"
ensure_dirs
for invalid_pid in '-1 1' '0 1' '1 1' '999999999 1' "$$ 0" "$$ $(process_ticks "$$")"; do
  printf '%s\n' "$invalid_pid" >"$PID_FILE"
  if pid_alive; then echo "FAIL: accepted foreign PID $invalid_pid" >&2; exit 1; fi
  stop_core
  kill -0 "$$"
done
BIN=$(readlink "/proc/$$/exe")
if pid_matches "$$" "$(process_ticks "$$")"; then echo 'FAIL: ignored command line ownership'; exit 1; fi
exec 9>"$TEST_DIR/extra-fd"
exec 12>"$TEST_DIR/extra-fd12"
exec 19>"$TEST_DIR/extra-fd19"
(
  close_inherited_fds
  if [ -e /proc/self/fd/9 ]; then echo 'FAIL: FD9 inherited'; exit 1; fi
  # 10 以上属于 shell 自身，不去关闭（见 common.sh），只要求子 shell 正常继续
  printf 'parsed child continues\n' >"$TEST_DIR/child-result"
)
test -s "$TEST_DIR/child-result"
test -e /proc/self/fd/19
exec 9>&-
exec 12>&-
exec 19>&-
echo 'PASS: real foreign/stale PID rejection and lock FD closure (no core launched)'
