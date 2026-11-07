# 网页管理服务（mihomo-webd）的路径与进程辅助，由 webui.sh、webd-launch.sh、service.sh 引入。
WEBD=$MODDIR/bin/mihomo-webd
WEBD_CONF=$DATA/webui.json
WEBD_PID=$RUN_DIR/webd.pid
WEBD_LOG=$RUN_DIR/webd.log
WEBD_SOCKET=$RUN_DIR/webui.sock

webd_matches() {
  [ -n "$2" ] && [ "$(process_ticks "$1")" = "$2" ] || return 1
  executable=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  case "$executable" in "$WEBD"|"$WEBD (deleted)") return 0 ;; esac
  return 1
}

webd_alive() {
  [ -f "$WEBD_PID" ] || return 1
  read -r webd_pid webd_ticks extra <"$WEBD_PID" || return 1
  [ -z "$extra" ] && webd_matches "$webd_pid" "$webd_ticks"
}

# 只看顶层的 enabled（增强功能里也有同名字段，不能 grep），由 mihomo-webd 判断
webd_enabled() {
  [ -f "$WEBD_CONF" ] && [ -x "$WEBD" ] && "$WEBD" enabled -c "$WEBD_CONF" 2>/dev/null
}

webd_stop() {
  if webd_alive; then
    kill "$webd_pid" 2>/dev/null
    wait_count=0
    while webd_matches "$webd_pid" "$webd_ticks"; do
      [ "$wait_count" -ge 25 ] && { kill -9 "$webd_pid" 2>/dev/null; sleep 1; break; }
      wait_count=$((wait_count + 1))
      sleep 0.2 2>/dev/null || sleep 1
    done
  fi
  rm -f "$WEBD_PID"
}

webd_start() {
  webd_alive && return 0
  [ -x "$WEBD" ] || { echo "缺少 $WEBD，请重新安装完整模块" >&2; return 1; }
  ensure_dirs || return 1
  rm -f "$WEBD_PID"
  # 日志只留最近一份
  [ -f "$WEBD_LOG" ] && [ "$(wc -c <"$WEBD_LOG")" -gt 1048576 ] && mv -f "$WEBD_LOG" "$WEBD_LOG.1"
  # 在子 shell 里用 exec 永久改 0–2：若写成 ( … ) >/dev/null &，busybox ash 会把调用方的 0–2 备份到 10 以上并一直
  # 持有到子 shell 结束，而子 shell 要等常驻进程退出，调用方（ksu.exec、网页服务 api/run）就一直读不到输出结束
  (
    exec </dev/null >/dev/null 2>&1
    close_inherited_fds
    trap '' HUP
    tool setsid sh "$SCRIPTS/webd-launch.sh" </dev/null >>"$WEBD_LOG" 2>&1
  ) &
  # 每 0.2 秒检查一次，最多 10 秒（不支持小数的 sleep 退化为 1 秒）
  wait_count=0
  while [ "$wait_count" -lt 50 ]; do
    sleep 0.2 2>/dev/null || sleep 1
    webd_alive && return 0
    wait_count=$((wait_count + 1))
  done
  echo "网页管理服务未能启动，见 $WEBD_LOG：$(tail -n 2 "$WEBD_LOG" 2>/dev/null | tr '\n' ' ')" >&2
  return 1
}
