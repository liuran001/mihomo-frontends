#!/system/bin/sh
# 安装时由 Magisk / KernelSU / APatch 安装器执行。ARCH、MODPATH、ui_print、abort 由安装器提供。
ui_print "- 安装 mihomo eBPF 模块"

case "$ARCH" in
  arm64|x64|arm) ;;
  *)
    ui_print "! 仅支持 arm64 / armv7 / x86_64，当前架构：$ARCH"
    abort
    ;;
esac

set_perm_recursive "$MODPATH/scripts" 0 0 0755 0755
set_perm_recursive "$MODPATH/bin" 0 0 0755 0644

# 网页管理服务：只保留当前架构的程序
if [ -f "$MODPATH/bin/$ARCH/mihomo-webd" ]; then
  mv -f "$MODPATH/bin/$ARCH/mihomo-webd" "$MODPATH/bin/mihomo-webd"
  set_perm "$MODPATH/bin/mihomo-webd" 0 0 0755
fi
rm -rf "$MODPATH/bin/arm64" "$MODPATH/bin/x64" "$MODPATH/bin/arm"

# 网页资源预压缩：网页管理服务向浏览器发送 gzip 版本，远程打开更快。安装包里不带这些副本以减小体积；
# 压缩失败只影响传输体积，不影响使用（服务会改发原文件）。
if command -v gzip >/dev/null 2>&1; then
  ui_print "- 预压缩网页资源"
  find "$MODPATH/webroot" -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' -o -name '*.otf' -o -name '*.ttf' -o -name '*.txt' \) |
    while IFS= read -r asset; do
      gzip -c "$asset" >"$asset.gz" 2>/dev/null || rm -f "$asset.gz"
    done
fi
set_perm "$MODPATH/service.sh" 0 0 0755
set_perm "$MODPATH/post-fs-data.sh" 0 0 0755

DATA=${MIHOMO_DATA:-/data/adb/mihomo}
SETTINGS=$DATA/settings.ini
mkdir -p "$DATA/run" "$DATA/backup"
chmod 700 "$DATA" "$DATA/run"

# ---- 环境检查（只提示，不阻止安装） ----
release=$(uname -r 2>/dev/null)
major=${release%%.*}; rest=${release#*.}; minor=${rest%%[!0-9]*}
case "$major$minor" in
  ''|*[!0-9]*) ui_print "! 无法识别内核版本：$release" ;;
  *)
    if [ "$major" -lt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -lt 10 ]; }; then
      ui_print "! 内核 $release 低于 5.10，eBPF 透明代理可能无法启动"
    fi
    ;;
esac
[ -r /sys/kernel/btf/vmlinux ] || ui_print "! 未找到 /sys/kernel/btf/vmlinux，eBPF 透明代理可能无法启动"
command -v curl >/dev/null 2>&1 || [ -x /system/bin/curl ] || ui_print "! 系统缺少 curl，下载内核与订阅需要 curl"

# ---- 首次安装的预设（已有设置时保持不变） ----
# 在中国大陆网络下 GitHub 直连常失败，首次安装默认启用下载镜像；可在 WebUI「内核」页修改。
preset() {
  key=$1; value=$2
  [ -f "$SETTINGS" ] && grep -q "^$key=" "$SETTINGS" && return 0
  printf '%s=%s\n' "$key" "$value" >>"$SETTINGS"
}
if [ ! -f "$SETTINGS" ]; then
  ui_print "- 写入默认设置：开机自启、GitHub 下载镜像"
  : >"$SETTINGS"
fi
preset core_repo liuran001/mihomo
preset core_mirror https://ghfast.top/
preset autostart 1
preset tethering 0
preset tethering_interfaces ap0,wlan1,rndis0,usb0,bt-pan
preset wifi_mode off
chmod 600 "$SETTINGS"

if [ -s "$DATA/config.yaml" ]; then
  ui_print "- 保留现有配置 $DATA/config.yaml"
else
  ui_print "- 安装完成后打开模块 WebUI，按向导下载内核并导入订阅"
fi

# ---- 升级后立即生效 ----
# root 管理器会把新版本放进 modules_update 并标记 update，默认要重启才换上；这样网页管理要等重启后才能打开新版本。
# 已安装过（旧版本在运行）时，在后台等安装器收尾后直接换上新版本并重启模块自己的后台进程；内核与配置不受影响。
MODID=${MODID:-mihomo-ebpf}
LIVE_CUR=${NVBASE:-/data/adb}/modules/$MODID
if [ -f "$LIVE_CUR/service.sh" ] && [ ! -e "$LIVE_CUR/remove" ] && [ ! -e "$LIVE_CUR/disable" ] &&
  [ "$MODPATH" = "${NVBASE:-/data/adb}/modules_update/$MODID" ] && cp -f "$MODPATH/scripts/live-update.sh" "$DATA/run/live-update.sh"; then
  ui_print "- 升级完成后立即生效，无需重启"
  (
    exec </dev/null >>"$DATA/run/live-update.log" 2>&1
    if command -v setsid >/dev/null 2>&1; then setsid sh "$DATA/run/live-update.sh" "$MODID" "$MODPATH" &
    else nohup sh "$DATA/run/live-update.sh" "$MODID" "$MODPATH" & fi
  )
fi
