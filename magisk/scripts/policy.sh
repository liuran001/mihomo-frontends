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
  printf '{"ok":true,"autostart":%s,"tethering":%s,"tethering_interfaces":"%s","bypass_packages":"%s","wifi_mode":"%s","wifi_ssids":"%s","current_ssid":"%s","allowed":%s}\n' \
    "$auto" "$tether" "$(json_escape "$policy_interfaces")" "$(json_escape "$policy_packages")" \
    "$(json_escape "$policy_wifi_mode")" "$(json_escape "$policy_ssids")" "$(json_escape "$current_wifi_ssid")" "$allowed"
}

set_policy() {
  [ "$#" = 6 ] || fail '需要六个设置参数'
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
  LC_ALL=C awk 'length($0) && $0 !~ /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/ {exit 1}' "$RUN_DIR/policy.$$.packages" || fail '包名格式无效'
  LC_ALL=C awk 'length($0)>32 {exit 1}' "$RUN_DIR/policy.$$.ssids" || fail 'SSID 不能超过 32 字节'
  candidate=$RUN_DIR/policy.$$.settings
  if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$candidate" || fail '无法复制设置'; else : >"$candidate"; fi
  settings_put "$candidate" autostart "$1" && settings_put "$candidate" tethering "$2" &&
    settings_put "$candidate" tethering_interfaces "$interfaces" && settings_put "$candidate" bypass_packages_b64 "$4" &&
    settings_put "$candidate" wifi_mode "$5" && settings_put "$candidate" wifi_ssids_b64 "$6" || fail '无法暂存设置'
  if [ -s "$CONFIG" ]; then
    detail=$(policy_render "$CONFIG" "$RUN_DIR/policy.$$.yaml" "$candidate" 2>&1) &&
      detail=$(validate_runtime "$RUN_DIR/policy.$$.yaml" 2>&1) || fail "$detail"
  fi
  was_running=0; pid_alive && was_running=1
  policy_load || fail '读取旧设置失败'
  old_tethering=$policy_tethering
  old_interfaces=$policy_interfaces
  old_packages=$policy_packages
  had_settings=0
  if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$RUN_DIR/policy.$$.old" || fail '无法保存旧设置'; had_settings=1; fi
  mv -f "$candidate" "$SETTINGS" || fail '保存策略失败'
  policy_load || fail '读取新设置失败'
  if [ "$was_running" = 1 ]; then
    if ! module_enabled || ! policy_allowed; then
      stop_core || { rollback_policy; fail '停止失败，设置已回滚'; }
    elif [ "$old_tethering" != "$policy_tethering" ] || [ "$old_interfaces" != "$policy_interfaces" ] || [ "$old_packages" != "$policy_packages" ]; then
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
    while :; do
      (exec 8>&-; sh "$SCRIPTS/policy.sh" tick)
      module_enabled || exit 0
      # 巡检只用来发现内核意外退出、模块被禁用和 Wi-Fi 切换。没开 Wi-Fi 条件时 30 秒一次即可；
      # 开了时 10 秒内跟上网络切换（每次要向系统查询一次 Wi-Fi 状态，不宜更频繁）。sleep 不会唤醒休眠中的设备。
      if grep -Eq '^wifi_mode=(only|exclude)$' "$SETTINGS" 2>/dev/null; then policy_interval=10; else policy_interval=30; fi
      sleep "${MIHOMO_POLICY_INTERVAL:-$policy_interval}"
    done
    ;;
  *) fail '用法: policy.sh get|ssid|set|tick|watch' ;;
esac
