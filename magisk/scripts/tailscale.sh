#!/system/bin/sh
# Tailscale（内核 tailscale 出站，tsnet）登录辅助。
#   tailscale.sh state DIR                 读取 DIR/tailscaled.state 中的登录资料（只输出 _current-profile 与 _profiles，不碰 _machinekey）
#   tailscale.sh login CTL PATH NAME [S]   订阅控制器日志并发起一次测速唤醒 tsnet，等待最多 S 秒（默认 20）：
#                                          输出 {"ok":true,"url":"https://…"} 或 {"ok":true,"url":null,"running":true|false}
#                                          CTL 为 http://127.0.0.1:端口，PATH 为 URL 编码后的出站名，NAME 为日志中 JSON 转义后的出站名；
#                                          控制器密钥通过环境变量 MIHOMO_SECRET 传入
#   tailscale.sh logout DIR                删除状态目录（服务运行时先停止、删除后再启动）
#   tailscale.sh open URL                  用系统浏览器打开链接
. "${0%/*}/common.sh"

fail() { json_error "$1"; exit 1; }

# 状态目录必须在数据目录之内
safe_dir() {
  case "$1" in "$DATA"/?*) ;; *) return 1 ;; esac
  case "$1/" in */../*|*/./*) return 1 ;; esac
}

running() { "$SCRIPTS/mihomo.sh" status 2>/dev/null | grep -q '"running":true'; }

case "$1" in
  # 读取登录资料与提取登录链接在 mihomo-webd 里（webd/tailscale.go）
  state|login) exec "$MODDIR/bin/mihomo-webd" tailscale -data "$DATA" "$@" ;;
  logout)
    dir=$2
    safe_dir "$dir" || fail '状态目录必须在数据目录之内'
    was=false
    if running; then
      was=true
      "$SCRIPTS/mihomo.sh" stop >/dev/null 2>&1 || fail '停止服务失败'
    fi
    rm -rf "$dir" || fail '删除状态目录失败'
    if [ "$was" = true ]; then
      "$SCRIPTS/mihomo.sh" start >/dev/null 2>&1 || fail '已退出登录，但启动服务失败'
    fi
    printf '{"ok":true,"restarted":%s}\n' "$was"
    ;;
  open)
    url=$2
    case "$url" in https://?*|http://?*) ;; *) fail '链接无效' ;; esac
    am start -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1 || fail '无法打开浏览器'
    printf '{"ok":true}\n'
    ;;
  *) echo '用法: tailscale.sh state|login|logout|open ...' >&2; exit 2 ;;
esac
