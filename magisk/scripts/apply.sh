#!/system/bin/sh
# apply.sh B64 [restart]     配置内容以 base64 参数传入（≤120000 字节）
# apply.sh B64 reload       服务运行时热重载（控制器设置变了时改为重启），未运行时只保存
# apply.sh --staged [restart|reload] 使用 host.sh stage 分段写入的 run/stage.b64（大配置）
. "${0%/*}/common.sh"
. "$SCRIPTS/policy-lib.sh"

fail() { json_error "$1"; exit 1; }
cleanup() { rm -f "$RUN_DIR/apply.$$."*; [ "${staged:-0}" = 0 ] || rm -f "$RUN_DIR/stage.b64"; unlock_backend; }
lock_backend || fail '后台忙'
trap cleanup EXIT
[ -n "$1" ] || fail '缺少配置内容'
case "${2:-}" in ''|restart|reload) ;; *) fail '第二参数必须为 restart、reload 或省略' ;; esac
tmp=$RUN_DIR/apply.$$.source
staged=0
if [ "$1" = --staged ]; then
  staged=1
  [ -s "$RUN_DIR/stage.b64" ] || fail '暂存配置不存在，请重新保存'
  base64 -d <"$RUN_DIR/stage.b64" >"$tmp" 2>/dev/null || fail '暂存配置 base64 解码失败'
else
  [ "${#1}" -le 120000 ] || fail '配置 base64 超过 120000 字节，当前命令参数接口不支持此大小'
  printf '%s' "$1" | base64 -d >"$tmp" 2>/dev/null || fail 'base64 解码失败'
fi
[ -s "$tmp" ] || fail '配置为空'
detail=$(apply_config_file "$tmp" "${2:-}" 2>&1) || fail "$detail"
printf '{"ok":true,"result":"%s"}\n' "$(cat "$RUN_DIR/apply.$$.result" 2>/dev/null || printf saved)"
