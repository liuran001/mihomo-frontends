#!/system/bin/sh
# 内核下载 / 信息 / 更新 / 回滚，实现在 mihomo-webd（webd/core.go）。
#   core.sh check | download [force] | info | rollback | settings REPO TAG MIRROR（空值用 - 占位）| get_settings
. "${0%/*}/common.sh"
exec "$MODDIR/bin/mihomo-webd" core -data "$DATA" "$@"
