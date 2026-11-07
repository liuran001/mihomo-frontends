#!/system/bin/sh
# 由 webui.sh start 在新会话中调用：移出管理器的 cgroup、记录 pid 与启动时刻后 exec 网页管理服务。
. "${0%/*}/common.sh"
. "$SCRIPTS/webui-lib.sh"
leave_app_cgroup "$$"
launch_ticks=$(process_ticks "$$")
[ -n "$launch_ticks" ] && atomic_text "$WEBD_PID" "$$ $launch_ticks" || exit 1
exec "$WEBD" serve -c "$WEBD_CONF" -root "$MODDIR/webroot" -scripts "$SCRIPTS" -data "$DATA" -socket "$WEBD_SOCKET"
