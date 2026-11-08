#!/system/bin/sh
. "${0%/*}/common.sh"
. "$SCRIPTS/policy-lib.sh"

fail() { json_error "$1"; exit 1; }
cleanup() {
  rm -f "$RUN_DIR/policy.$$."* "$RUN_DIR/packages.$$.tmp"
  unlock_backend
}

decode_input() {
  case "$1" in *[!a-zA-Z0-9+/=]*) return 1 ;; esac
  printf '%s' "$1" | base64 -d >"$2" 2>/dev/null || return 1
  canonical=$(base64 <"$2" | tr -d '\r\n')
  [ "$canonical" = "$1" ] || return 1
  [ "$(wc -c <"$2")" -le 32768 ] || return 1
  filtered_size=$(LC_ALL=C tr -d '\000-\011\013-\037\177' <"$2" | wc -c)
  [ "$filtered_size" -eq "$(wc -c <"$2")" ] || return 1
  return 0
}

get_policy() {
  policy_load || fail '策略文件损坏'
  policy_cached_status
  auto=false; [ "$policy_autostart" = 1 ] && auto=true
  tether=false; [ "$policy_tethering" = 1 ] && tether=true
  printf '{"ok":true,"autostart":%s,"tethering":%s,"tethering_mode":"%s","tethering_interfaces":"%s","tethering_exclude":"%s","tethering_effective":"%s","bypass_packages":"%s","wifi_mode":"%s","wifi_ssids":"%s","current_ssid":"%s","allowed":%s}\n' \
    "$auto" "$tether" "$policy_tether_mode" "$(json_escape "$policy_interfaces")" "$(json_escape "$policy_excludes")" \
    "$(json_escape "$(policy_shared_interfaces)")" "$(json_escape "$policy_packages")" \
    "$(json_escape "$policy_wifi_mode")" "$(json_escape "$policy_ssids")" "$(json_escape "$current_wifi_ssid")" "$allowed"
}

set_policy() {
  # 第 7、8 个参数可省略（旧调用方）：共享网卡模式 all/only/exclude 与排除的网卡（base64），省略时保持原设置
  [ "$#" = 6 ] || [ "$#" = 8 ] || fail '需要六个或八个设置参数'
  case "$1:$2" in 0:0|0:1|1:0|1:1) ;; *) fail '开关必须为 0 或 1' ;; esac
  case "$5" in off|only|exclude) ;; *) fail 'wifi_mode 必须为 off/only/exclude' ;; esac
  decode_input "$3" "$RUN_DIR/policy.$$.interfaces" || fail '接口 base64 无效或含控制字符'
  decode_input "$4" "$RUN_DIR/policy.$$.packages" || fail '包名 base64 无效或含控制字符'
  decode_input "$6" "$RUN_DIR/policy.$$.ssids" || fail 'SSID base64 无效或含控制字符'
  interfaces=$(cat "$RUN_DIR/policy.$$.interfaces")
  [ -n "$interfaces" ] || interfaces=$DEFAULT_INTERFACES
  printf '%s\n' "$interfaces" | LC_ALL=C awk -F, '
    NR>1 {exit 1} {for (pos=1; pos<=NF; pos++) if ($pos !~ /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/ || length($pos)>15) exit 1}
  ' || fail '接口须为逗号分隔的有效网卡名称'
  policy_load || fail '策略文件损坏'
  tether_mode=$policy_tether_mode
  excludes=$policy_excludes
  if [ "$#" = 8 ]; then
    case "$7" in all|only|exclude) tether_mode=$7 ;; *) fail '共享网卡模式必须为 all/only/exclude' ;; esac
    decode_input "$8" "$RUN_DIR/policy.$$.excludes" || fail '排除网卡 base64 无效或含控制字符'
    excludes=$(cat "$RUN_DIR/policy.$$.excludes")
    [ -z "$excludes" ] || printf '%s\n' "$excludes" | LC_ALL=C awk -F, '
      NR>1 {exit 1} {for (pos=1; pos<=NF; pos++) if ($pos !~ /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/ || length($pos)>15) exit 1}
    ' || fail '排除网卡须为逗号分隔的有效网卡名称'
  fi
  LC_ALL=C awk 'length($0) && $0 !~ /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/ {exit 1}' "$RUN_DIR/policy.$$.packages" || fail '包名格式无效'
  LC_ALL=C awk 'length($0)>32 {exit 1}' "$RUN_DIR/policy.$$.ssids" || fail 'SSID 不能超过 32 字节'
  candidate=$RUN_DIR/policy.$$.settings
  if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$candidate" || fail '无法复制设置'; else : >"$candidate"; fi
  settings_put "$candidate" autostart "$1" && settings_put "$candidate" tethering "$2" &&
    settings_put "$candidate" tethering_interfaces "$interfaces" && settings_put "$candidate" bypass_packages_b64 "$4" &&
    settings_put "$candidate" wifi_mode "$5" && settings_put "$candidate" wifi_ssids_b64 "$6" || fail '无法暂存设置'
  # 旧调用方（六个参数）不写模式：没存过模式时仍按网卡列表推断（改过网卡即「仅所选」）
  if [ "$#" = 8 ]; then
    settings_put "$candidate" tethering_mode "$tether_mode" && settings_put "$candidate" tethering_exclude "$excludes" || fail '无法暂存设置'
  fi
  if [ -s "$CONFIG" ]; then
    detail=$(policy_render "$CONFIG" "$RUN_DIR/policy.$$.yaml" "$candidate" 2>&1) &&
      detail=$(validate_runtime "$RUN_DIR/policy.$$.yaml" 2>&1) || fail "$detail"
  fi
  was_running=0; pid_alive && was_running=1
  policy_load || fail '读取旧设置失败'
  old_tethering=$policy_tethering
  old_interfaces=$(policy_shared_interfaces)
  old_packages=$policy_packages
  had_settings=0
  if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$RUN_DIR/policy.$$.old" || fail '无法保存旧设置'; had_settings=1; fi
  mv -f "$candidate" "$SETTINGS" || fail '保存策略失败'
  policy_load || fail '读取新设置失败'
  if [ "$was_running" = 1 ]; then
    if ! module_enabled || ! policy_allowed; then
      stop_core || { rollback_policy; fail '停止失败，设置已回滚'; }
    elif [ "$old_tethering" != "$policy_tethering" ] || [ "$old_interfaces" != "$(policy_shared_interfaces)" ] || [ "$old_packages" != "$policy_packages" ]; then
      # 先热重载（上面已按新设置渲染并校验过 policy.$$.yaml），不成功再重启
      # （失败时下面的 start_core 会按新设置重新渲染 $RUNTIME）
      if [ -f "$RUN_DIR/policy.$$.yaml" ] && mv -f "$RUN_DIR/policy.$$.yaml" "$RUNTIME" && reload_core 2>/dev/null; then
        echo '{"ok":true,"result":"reloaded"}'
        return 0
      fi
      if ! stop_core; then rollback_policy; fail '停止失败，设置已回滚'; fi
      if ! detail=$(start_core 2>&1); then
        rollback_policy
        recovery=$(start_core 2>&1); recovered=$?
        fail "$detail；已回滚设置，旧服务恢复结果=$recovered $recovery"
      fi
    fi
  elif [ "$policy_wifi_mode" != off ]; then
    policy_allowed || :
  fi
  echo '{"ok":true}'
}

rollback_policy() {
  if [ "$had_settings" = 1 ]; then mv -f "$RUN_DIR/policy.$$.old" "$SETTINGS"; else rm -f "$SETTINGS"; fi
}

case "$1" in
  get) get_policy ;;
  ssid) printf '{"ok":true,"current_ssid":"%s"}\n' "$(json_escape "$(current_ssid)")" ;;
  set) lock_backend || fail '后台忙'; trap cleanup EXIT; boot_intent || fail '无法初始化开机状态'; shift; set_policy "$@" ;;
  tick) lock_backend || exit 1; trap cleanup EXIT; reconcile_policy ;;
  watch)
    ensure_dirs || exit 1
    exec 8>"$RUN_DIR/watch.lock" || exit 1
    tool flock -n 8 || exit 0
    watch_pid=$$
    monitor_ip=''
    monitor_reader=''
    woken=0
    # Wi-Fi 变化事件：系统 ip 的 monitor 阻塞在 netlink 上（不定时唤醒），wlan 网卡的连接 / 断开 / 换地址时
    # 给巡检循环发 USR1，打断它的 sleep 立即检查。拿不到 ip monitor 时退回 10 秒轮询。
    monitor_alive() { [ -n "$monitor_ip" ] && kill -0 "$monitor_ip" 2>/dev/null && kill -0 "$monitor_reader" 2>/dev/null; }
    monitor_stop() {
      [ -n "$monitor_ip" ] && kill "$monitor_ip" "$monitor_reader" 2>/dev/null
      monitor_ip=''; monitor_reader=''
      rm -f "$RUN_DIR/wifi-events"
    }
    monitor_start() {
      monitor_stop
      ip_bin=$(command -v ip 2>/dev/null) || return 1
      rm -f "$RUN_DIR/wifi-events"
      mkfifo "$RUN_DIR/wifi-events" 2>/dev/null || tool mkfifo "$RUN_DIR/wifi-events" || return 1
      # exec 让 $! 就是 ip 本身，停的时候能直接杀掉
      (exec 8>&- </dev/null 2>/dev/null; exec "$ip_bin" -o monitor link address >"$RUN_DIR/wifi-events") &
      monitor_ip=$!
      (
        exec 8>&-
        while IFS= read -r event; do
          case "$event" in *wlan*) kill -USR1 "$watch_pid" 2>/dev/null || exit 0 ;; esac
        done <"$RUN_DIR/wifi-events"
      ) &
      monitor_reader=$!
      sleep 1
      monitor_alive || { monitor_stop; return 1; }
    }
    trap 'woken=1' USR1
    trap 'monitor_stop' EXIT
    trap 'exit 0' TERM INT HUP
    while :; do
      woken=0
      (exec 8>&-; sh "$SCRIPTS/policy.sh" tick)
      module_enabled || exit 0
      # 巡检兜底发现内核意外退出、模块被禁用；Wi-Fi 切换靠上面的事件，事件不可用时才 10 秒轮询。sleep 不会唤醒休眠中的设备。
      policy_interval=30
      if grep -Eq '^wifi_mode=(only|exclude)$' "$SETTINGS" 2>/dev/null; then
        monitor_alive || monitor_start || policy_interval=10
      else
        monitor_alive && monitor_stop
      fi
      # 检查期间来过事件就不再等
      if [ "$woken" = 0 ]; then
        sleep "${MIHOMO_POLICY_INTERVAL:-$policy_interval}" &
        sleep_pid=$!
        [ "$woken" = 1 ] || wait "$sleep_pid" 2>/dev/null
        kill "$sleep_pid" 2>/dev/null
      fi
      # 被事件叫醒：等连接或地址稳定（关联、DHCP 往往连着来几条事件）再检查，期间的事件合并成一次
      if [ "$woken" = 1 ]; then sleep "${MIHOMO_WIFI_SETTLE:-2}"; fi
    done
    ;;
  *) fail '用法: policy.sh get|ssid|set|tick|watch' ;;
esac
