#!/system/bin/sh
# 模块自身的检查更新与一键升级，实现在 mihomo-webd（webd/moduleupdate.go）。
#   check    读取最新 release 的 update.json，与本模块的 versionCode 比较
#   upgrade  下载新版本 zip、校验 sha256，交给 root 管理器（KernelSU / APatch / Magisk）安装；
#            customize.sh 随后在后台把新版本直接换上（见 live-update.sh），不需要重启
#   current  当前版本
. "${0%/*}/common.sh"
exec "$MODDIR/bin/mihomo-webd" module -data "$DATA" -moddir "$MODDIR" "$@"
