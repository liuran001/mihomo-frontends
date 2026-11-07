#!/bin/sh
# 在 10.0.0.88 上驱动 HyperOS AVD 的模块 WebUI（测试辅助，不随模块打包）。
#   avd-ui.sh open            以 root 启动 KernelSU WebUIActivity 打开模块
#   avd-ui.sh tap X Y         物理坐标点击（1120x2436）
#   avd-ui.sh swipe X1 Y1 X2 Y2
#   avd-ui.sh text 内容        仅 ASCII
#   avd-ui.sh back
#   avd-ui.sh shot 名称        截图到 $DIR/名称.png 并缩放到 $DIR/名称-s.png
ADB="/Volumes/data/CodexToolchains/pill-android/sdk/platform-tools/adb -s emulator-5580"
DIR=/Volumes/data/HyperOS-AVD/tmp/mihomo-test
case "$1" in
  open)
    # 该 AVD 的 Vulkan 合成会让 WebView 白屏：仅在启动 Manager 时临时切到 skiagl，随后恢复。
    original=$($ADB shell getprop debug.hwui.renderer | tr -d '\r')
    $ADB shell su -c "am force-stop me.weishu.kernelsu"
    $ADB shell su -c "setprop debug.hwui.renderer skiagl"
    $ADB shell su -c "monkey -p me.weishu.kernelsu -c android.intent.category.LAUNCHER 1" >/dev/null 2>&1
    sleep 5
    $ADB shell su -c "am start -n me.weishu.kernelsu/.ui.webui.WebUIActivity -e id mihomo-ebpf -e name mihomo"
    sleep 4
    $ADB shell su -c "setprop debug.hwui.renderer ${original:-skiavk}"
    $ADB shell dumpsys activity activities | grep -m1 topResumedActivity
    ;;
  gltap)
    # 在临时 skiagl 下点击（例如 Manager 模块列表里的「打开」），WebView 创建后恢复渲染器。
    original=$($ADB shell getprop debug.hwui.renderer | tr -d '\r')
    $ADB shell su -c "setprop debug.hwui.renderer skiagl"
    $ADB shell su -c "input tap $2 $3"
    sleep 6
    $ADB shell su -c "setprop debug.hwui.renderer ${original:-skiavk}"
    ;;
  webui)
    # 完整流程：重启 Manager → 模块页 → 搜索 mihomo → 在 skiagl 下点「打开」
    "$0" open >/dev/null
    sleep 4
    "$0" tap 715 2290; sleep 3
    "$0" tap 542 534; sleep 1
    "$0" text mihomo; sleep 2
    "$0" gltap 198 860
    ;;
  close)$ADB shell su -c "am force-stop me.weishu.kernelsu" ;;
  tap) $ADB shell su -c "input tap $2 $3" ;;
  swipe) $ADB shell su -c "input swipe $2 $3 $4 $5 ${6:-300}" ;;
  text) $ADB shell su -c "input text '$2'" ;;
  back) $ADB shell su -c "input keyevent KEYCODE_BACK" ;;
  shot)
    $ADB exec-out screencap -p -d 4619827259835644672 >"$DIR/$2.png"
    sips -Z 900 "$DIR/$2.png" --out "$DIR/$2-s.png" >/dev/null
    ;;
  *) echo "usage: $0 open|close|tap|swipe|text|back|shot" >&2; exit 2 ;;
esac
