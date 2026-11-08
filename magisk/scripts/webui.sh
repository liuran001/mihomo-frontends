#!/system/bin/sh
# 网页管理（局域网 / Tailscale 访问模块网页）。
#   webui.sh status          {"ok":true,"installed":bool,"running":bool,"settings":{...,"addrs":[...]}}
#   webui.sh set B64JSON     保存设置（字段见 mihomo-webd set），并按 enabled 启停服务；
#                            端口或局域网监听变化时由运行中的服务自己换到新地址（保存后发 SIGHUP 通知它）
#   webui.sh passwd B64      设置密码（空串清除）
#   webui.sh start|stop|restart
#   webui.sh boot            开机时由 service.sh 调用：启用时启动
. "${0%/*}/common.sh"
. "$SCRIPTS/webui-lib.sh"

fail() { json_error "$1"; exit 1; }

webd_cli() {
  [ -x "$WEBD" ] || fail "缺少 $WEBD，请重新安装完整模块"
  # 选项须在位置参数之前（Go flag 遇到第一个位置参数即停止解析）
  sub=$1; shift
  "$WEBD" "$sub" -c "$WEBD_CONF" "$@" 2>&1
}

status() {
  installed=false; [ -x "$WEBD" ] && installed=true
  settings=
  [ "$installed" = true ] && settings=$("$WEBD" get -c "$WEBD_CONF" 2>/dev/null | head -n 1)
  [ -n "$settings" ] || settings=null
  running=false; webd_alive && running=true
  printf '{"ok":true,"installed":%s,"running":%s,"settings":%s}\n' "$installed" "$running" "$settings"
}

# 设置变化后让服务与 enabled 一致。端口、局域网监听变化不用重启：运行中的服务会自己换到新地址并关掉旧端口
reconcile() {
  if webd_enabled; then
    if webd_alive; then
      # 通知运行中的服务立刻重新读取设置（端口、局域网监听变化时换地址）
      kill -HUP "$webd_pid" 2>/dev/null || :
    else
      error=$(webd_start 2>&1) || fail "$error"
    fi
  else
    webd_stop
  fi
}

case "$1" in
  status) status ;;
  set)
    [ "$#" -eq 2 ] || fail '参数无效'
    out=$(webd_cli set "$2") || { printf '%s\n' "$out"; exit 1; }
    settings=$(printf '%s\n' "$out" | head -n 1)
    reconcile
    running=false; webd_alive && running=true
    printf '{"ok":true,"installed":true,"running":%s,"settings":%s}\n' "$running" "$settings"
    ;;
  passwd)
    [ "$#" -eq 2 ] || fail '参数无效'
    out=$(webd_cli passwd "$2") || { printf '%s\n' "$out"; exit 1; }
    printf '%s\n' "$out"
    ;;
  enhanced-set)
    [ "$#" -eq 2 ] || fail '参数无效'
    out=$(webd_cli enhanced-set "$2") || { printf '%s\n' "$out"; exit 1; }
    reconcile
    status
    ;;
  enhanced-request)
    [ "$#" -eq 3 ] || fail '参数无效'
    webd_cli enhanced-request -data "$DATA" "$2" "$3"
    ;;
  start) webd_start || exit 1; status ;;
  stop) webd_stop; status ;;
  restart) webd_stop; webd_start || exit 1; status ;;
  boot) if webd_enabled; then webd_start; fi ;;
  *) fail '用法: webui.sh status|set|passwd|start|stop|restart|boot' ;;
esac
