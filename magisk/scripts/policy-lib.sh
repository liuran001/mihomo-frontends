#!/system/bin/sh

DEFAULT_INTERFACES=ap0,wlan1,rndis0,usb0,bt-pan

decode_value() {
  printf '%s' "$1" | base64 -d 2>/dev/null
}

policy_load() {
  policy_source=${1:-$SETTINGS}
  policy_autostart=$(setting_get autostart 0 "$policy_source")
  policy_tethering=$(setting_get tethering 0 "$policy_source")
  policy_interfaces=$(setting_get tethering_interfaces "$DEFAULT_INTERFACES" "$policy_source")
  policy_packages=$(decode_value "$(setting_get bypass_packages_b64 '' "$policy_source")") || return 1
  policy_wifi_mode=$(setting_get wifi_mode off "$policy_source")
  policy_ssids_b64=$(setting_get wifi_ssids_b64 '' "$policy_source")
  policy_ssids=$(decode_value "$policy_ssids_b64") || return 1
}

current_ssid() {
  ssid_result=$(tool timeout 5 cmd wifi status 2>/dev/null | awk -v source=cmd -f "$SCRIPTS/policy-ssid.awk")
  if [ "$ssid_result" = '?' ]; then
    ssid_result=$(tool timeout 5 dumpsys wifi 2>/dev/null | awk -v source=dumpsys -f "$SCRIPTS/policy-ssid.awk")
  fi
  case "$ssid_result" in +*) printf '%s' "${ssid_result#+}" ;; *) printf '' ;; esac
}

policy_allowed() {
  current_wifi_ssid=''
  [ "$policy_wifi_mode" != off ] || return 0
  current_wifi_ssid=$(current_ssid)
  policy_decision=false
  case "$policy_wifi_mode" in
    only) if [ -n "$current_wifi_ssid" ] && printf '%s\n' "$policy_ssids" | grep -Fxq -e "$current_wifi_ssid"; then policy_decision=true; fi ;;
    exclude) if [ -z "$current_wifi_ssid" ] || ! printf '%s\n' "$policy_ssids" | grep -Fxq -e "$current_wifi_ssid"; then policy_decision=true; fi ;;
    *) return 1 ;;
  esac
  policy_snapshot=$(printf '%s\n%s\n%s\n+%s' "$policy_wifi_mode" "$policy_ssids_b64" "$policy_decision" "$(printf '%s' "$current_wifi_ssid" | base64 | tr -d '\r\n')")
  if [ -d "$RUN_DIR" ] && [ "$(cat "$RUN_DIR/policy-status" 2>/dev/null)" != "$policy_snapshot" ]; then
    atomic_text "$RUN_DIR/policy-status" "$policy_snapshot" || :
  fi
  [ "$policy_decision" = true ]
}

policy_cached_status() {
  allowed=null
  current_wifi_ssid=''
  [ "$policy_wifi_mode" != off ] || { allowed=true; return 0; }
  [ -f "$RUN_DIR/policy-status" ] || return 0
  {
    IFS= read -r cached_mode && IFS= read -r cached_ssids && IFS= read -r cached_allowed && IFS= read -r cached_current
  } <"$RUN_DIR/policy-status" || return 0
  [ "$cached_mode" = "$policy_wifi_mode" ] && [ "$cached_ssids" = "$policy_ssids_b64" ] || return 0
  case "$cached_allowed" in true|false) ;; *) return 0 ;; esac
  case "$cached_current" in +*) ;; *) return 0 ;; esac
  current_wifi_ssid=$(decode_value "${cached_current#+}") || return 0
  allowed=$cached_allowed
}

policy_render() (
  render_input=$1
  render_output=$2
  policy_load "${3:-$SETTINGS}" || { echo '策略文件损坏' >&2; exit 1; }
  if [ -n "$policy_packages" ] && [ -x "$BIN" ]; then
    "$BIN" -v 2>/dev/null | head -n 1 | grep -Eq ' android (arm64|amd64|arm|386)( |$)' || {
      echo '包名绕过需要 Android 内核（不能使用 linux asset）' >&2; exit 1;
    }
  fi
  printf '%s\n' "$policy_packages" >"$RUN_DIR/packages.$$.tmp" || exit 1
  trap 'rm -f "$RUN_DIR/packages.$$.tmp"' EXIT
  awk -v tethering="$policy_tethering" -v interfaces="$policy_interfaces" \
    -v packages_file="$RUN_DIR/packages.$$.tmp" -f "$SCRIPTS/policy-yaml.awk" "$render_input" >"$render_output"
)

validate_runtime() {
  [ -x "$BIN" ] || return 0
  if ! "$BIN" -d "$DATA" -f "$1" -t >"$RUN_DIR/validation.$$.log" 2>&1; then
    printf '运行配置校验失败: %s\n' "$(tail -c 4096 "$RUN_DIR/validation.$$.log")" >&2
    rm -f "$RUN_DIR/validation.$$.log"
    return 1
  fi
  rm -f "$RUN_DIR/validation.$$.log"
}

# 只有控制器本身（地址、密钥、面板目录、TLS 证书、CORS、DoH）在内核重载配置时不会重建；
# 输出这些顶层段落的原文，新旧不同就得重启而不能热重载。
hub_sections() {
  awk '
    /^[^ #-][^:]*:/ { k=$0; sub(/:.*/,"",k); keep=(k ~ /^(external-controller.*|external-ui.*|external-doh-server|secret|tls)$/) }
    keep { sub(/\r$/,""); print }
  ' "$1" 2>/dev/null
}

# 一次探测 eBPF 入站是否就绪（/ebpf/summary 有入站）。旧内核没有 summary 时退回 /ebpf。
ebpf_ready_once() {
  ready=$(tool curl -sS --max-time 2 --unix-socket "$CONTROL_SOCKET" "http://localhost${readiness_endpoint:-/ebpf/summary}" -w '\n%{http_code}' 2>/dev/null)
  readiness_code=$(printf '%s\n' "$ready" | tail -n 1)
  if [ "${readiness_endpoint:-/ebpf/summary}" = /ebpf/summary ] && [ "$readiness_code" = 404 ]; then
    readiness_endpoint=/ebpf
    return 1
  fi
  [ "$readiness_code" = 200 ] || return 1
  printf '%s' "$ready" | grep -Eq '"inbounds"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{'
}

# 让运行中的内核重新读取 $RUNTIME（PUT /configs?force=true），不重启进程。
# 节点、规则、DNS、监听器（含 eBPF 入站）都会按新配置重建；之后确认 eBPF 入站重新就绪。
reload_core() {
  pid_alive || return 1
  reload_out=$(tool curl -sS --max-time 60 --unix-socket "$CONTROL_SOCKET" -X PUT \
    -H 'Content-Type: application/json' --data "{\"path\":\"$RUNTIME\"}" \
    'http://localhost/configs?force=true' -w '\n%{http_code}' 2>&1)
  reload_code=$(printf '%s\n' "$reload_out" | tail -n 1)
  case "$reload_code" in
    200|204) ;;
    *) echo "内核重载失败（HTTP $reload_code）：$(printf '%s\n' "$reload_out" | sed '$d' | tail -c 1024)" >&2; return 1 ;;
  esac
  readiness_endpoint=/ebpf/summary
  reload_wait=0
  while [ "$reload_wait" -lt "$START_TIMEOUT" ]; do
    pid_alive || { echo '重载后内核进程退出' >&2; return 1; }
    ebpf_ready_once && return 0
    reload_wait=$((reload_wait + 1))
    sleep 1
  done
  echo '重载后 eBPF 入站未就绪' >&2
  return 1
}

stop_core() {
  if pid_alive; then
    stop_pid=$running_pid
    stop_ticks=$running_ticks
    kill "$stop_pid" 2>/dev/null || return 1
    stop_wait=0
    while pid_matches "$stop_pid" "$stop_ticks"; do
      if [ "$stop_wait" -ge "$STOP_TIMEOUT" ]; then
        kill -9 "$stop_pid" 2>/dev/null || return 1
        sleep 1
        pid_matches "$stop_pid" "$stop_ticks" && { echo '无法停止已验证的内核进程' >&2; return 1; }
        break
      fi
      stop_wait=$((stop_wait + 1))
      sleep 1
    done
  fi
  rm -f "$PID_FILE" "$CONTROL_SOCKET"
  module_status stopped
}

start_core() {
  module_enabled || { echo '模块已禁用' >&2; return 1; }
  pid_alive && return 0
  [ -x "$BIN" ] || { echo "未安装可执行内核 $BIN" >&2; return 1; }
  [ -s "$CONFIG" ] || { echo '缺少源配置 config.yaml' >&2; return 1; }
  policy_render "$CONFIG" "$RUNTIME.$$.tmp" && validate_runtime "$RUNTIME.$$.tmp" || { rm -f "$RUNTIME.$$.tmp"; return 1; }
  mv -f "$RUNTIME.$$.tmp" "$RUNTIME" || return 1
  rm -f "$PID_FILE" "$CONTROL_SOCKET" "$RUN_DIR/launch-error"
  ulimit -n 65535 2>/dev/null
  # 在子 shell 里用 exec 永久改 0–2：若写成 ( … ) >/dev/null &，busybox ash 会把调用方的 0–2 备份到 10 以上并一直
  # 持有到子 shell 结束，而子 shell 要等常驻进程退出，调用方（ksu.exec、网页服务 api/run）就一直读不到输出结束
  (
    exec </dev/null >/dev/null 2>&1
    close_inherited_fds
    trap '' HUP
    tool setsid sh "$SCRIPTS/policy-launch.sh" </dev/null >>"$LOG_FILE" 2>&1
  ) &
  start_wait=0
  readiness_endpoint=/ebpf/summary
  while [ "$start_wait" -lt "$START_TIMEOUT" ]; do
    if pid_alive; then
      if ebpf_ready_once; then
        pid_alive && { module_status running; return 0; }
      fi
    elif [ "$start_wait" -ge 2 ] && { [ -f "$PID_FILE" ] || [ -f "$RUN_DIR/launch-error" ]; }; then
      break
    fi
    start_wait=$((start_wait + 1))
    sleep 1
  done
  stop_core || return 1
  echo "启动失败：eBPF listener 未就绪（/ebpf/summary 必须非空），见 $LOG_FILE" >&2
  return 1
}

reconcile_policy() {
  boot_intent || return 1
  policy_load || return 1
  if ! module_enabled; then
    atomic_text "$INTENT" stopped
    stop_core
    return $?
  fi
  wanted=$(cat "$INTENT" 2>/dev/null)
  case "$wanted" in
    manual) ;;
    auto) ;;
    *) stop_core; return $? ;;
  esac
  if policy_allowed; then
    start_core
  else
    stop_core || return 1
    module_status paused
  fi
}

backup_config() {
  [ -f "$CONFIG" ] || return 0
  cp "$CONFIG" "$BACKUP_DIR/config-$(date +%Y%m%d-%H%M%S)-$$.yaml" || return 1
  ls -1t "$BACKUP_DIR"/config-*.yaml 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" | while IFS= read -r old_backup; do
    rm -f "$old_backup"
  done
}

apply_config_file() {
  apply_source=$1
  apply_action=$2
  boot_intent || { echo '无法初始化开机状态' >&2; return 1; }
  policy_render "$apply_source" "$RUN_DIR/apply.$$.runtime" &&
    validate_runtime "$RUN_DIR/apply.$$.runtime" || return 1
  had_config=0
  if [ -f "$CONFIG" ]; then cp "$CONFIG" "$RUN_DIR/apply.$$.old" || return 1; had_config=1; fi
  old_intent=$(cat "$INTENT" 2>/dev/null)
  was_running=0; pid_alive && was_running=1
  # reload：服务在运行时热重载；没运行时只保存；控制器设置变了（重载不会重建控制器）改为重启。
  # 实际做了什么写到 apply.$$.result（saved / reloaded / restarted），调用方在子 shell 外读取
  printf saved >"$RUN_DIR/apply.$$.result"
  if [ "$apply_action" = reload ]; then
    if [ "$was_running" != 1 ]; then
      apply_action=''
    elif [ "$(hub_sections "$CONFIG")" != "$(hub_sections "$apply_source")" ]; then
      apply_action=restart
    fi
  fi
  cp "$apply_source" "$RUN_DIR/apply.$$.commit" || return 1
  backup_config || { echo '配置备份失败' >&2; return 1; }
  if [ "$apply_action" = restart ]; then stop_core || return 1; fi
  if ! mv -f "$RUN_DIR/apply.$$.commit" "$CONFIG"; then
    [ "$was_running" != 1 ] || start_core
    echo '配置替换失败' >&2
    return 1
  fi
  if [ "$apply_action" = reload ]; then
    if mv -f "$RUN_DIR/apply.$$.runtime" "$RUNTIME" && reload_core 2>"$RUN_DIR/apply.$$.reload"; then
      printf reloaded >"$RUN_DIR/apply.$$.result"
      return 0
    fi
    # 热重载没成功：按重启处理（失败时回滚源配置并恢复旧服务）
    printf '%s 热重载失败，改为重启：%s\n' "$(date '+%F %T')" "$(cat "$RUN_DIR/apply.$$.reload" 2>/dev/null)" >>"$LOG_FILE"
    stop_core || return 1
    apply_action=restart
  fi
  if [ "$apply_action" = restart ]; then
    printf restarted >"$RUN_DIR/apply.$$.result"
    if atomic_text "$INTENT" manual && reconcile_policy; then return 0; fi
    if [ "$had_config" = 1 ]; then
      mv -f "$RUN_DIR/apply.$$.old" "$CONFIG" || { echo '源配置回滚失败' >&2; return 1; }
    else
      rm -f "$CONFIG"
    fi
    atomic_text "$INTENT" "$old_intent" || return 1
    if [ "$was_running" = 1 ]; then
      if start_core; then echo '新配置失败；源配置已回滚，旧服务已恢复' >&2
      else echo '新配置失败；源配置已回滚，但旧服务恢复失败' >&2; fi
    else
      echo '新配置失败；源配置已回滚，保持停止' >&2
    fi
    return 1
  fi
}
