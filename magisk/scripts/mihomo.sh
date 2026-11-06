#!/system/bin/sh
. "${0%/*}/common.sh"
. "$SCRIPTS/policy-lib.sh"

if [ "$1" != status ]; then
  lock_backend || exit 1
  trap unlock_backend EXIT
fi

case "$1" in
  status)
    policy_load || exit 1
    policy_cached_status
    desired=$(cat "$INTENT" 2>/dev/null)
    case "$desired" in manual|auto) ;; *) desired=stopped ;; esac
    module_enabled || desired=stopped
    status_policy=$(printf '"desired":"%s","allowed":%s,"current_ssid":"%s"' "$desired" "$allowed" "$(json_escape "$current_wifi_ssid")")
    if pid_alive; then
      rss=$(awk '/VmRSS/{print $2}' "/proc/$running_pid/status" 2>/dev/null)
      started=$(stat -c %Y "/proc/$running_pid" 2>/dev/null)
      uptime=null
      case "$started" in ''|*[!0-9]*) ;; *) uptime=$(( $(date +%s) - started )); [ "$uptime" -ge 0 ] || uptime=null ;; esac
      printf '{"ok":true,"running":true,"pid":%s,"rss_kb":%s,"uptime":%s,%s}\n' "$running_pid" "${rss:-null}" "$uptime" "$status_policy"
    else
      printf '{"ok":true,"running":false,"pid":null,"rss_kb":null,"uptime":null,%s}\n' "$status_policy"
    fi
    ;;
  stop)
    boot_intent && atomic_text "$INTENT" stopped && stop_core
    ;;
  start|restart)
    boot_intent || exit 1
    [ "$1" != restart ] || stop_core || exit 1
    atomic_text "$INTENT" manual || exit 1
    reconcile_policy || { atomic_text "$INTENT" stopped; exit 1; }
    ;;
  autostart)
    reconcile_policy
    ;;
  enable|disable)
    enabled=0; [ "$1" = enable ] && enabled=1
    setting_set autostart "$enabled"
    ;;
  *) echo '用法: mihomo.sh start|stop|restart|status|autostart|enable|disable' >&2; exit 2 ;;
esac
