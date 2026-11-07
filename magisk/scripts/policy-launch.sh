#!/system/bin/sh
. "${0%/*}/common.sh"
leave_app_cgroup "$$"
launch_ticks=$(process_ticks "$$")
if [ -z "$launch_ticks" ] || ! atomic_text "$PID_FILE" "$$ $launch_ticks"; then
  : >"$RUN_DIR/launch-error"
  exit 1
fi
exec "$BIN" -d "$DATA" -f "$RUNTIME" -ext-ctl-unix "$CONTROL_SOCKET"
