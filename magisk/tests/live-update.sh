#!/bin/sh
# live-update.sh：模块升级后立即替换。替换过程中和结束后 modules 下都不能出现第二个同 id 的目录
# （管理器会把每个带 module.prop 的目录当成模块，同 id 会让它出错甚至崩溃）；以前版本留下的残留也要清掉。
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT HUP INT TERM
ADB=$T/adb ID=mihomo-ebpf
export MIHOMO_DATA=$T/data
fail() { echo "FAIL: $*" >&2; exit 1; }

setup() {
  rm -rf "$ADB" "$MIHOMO_DATA"
  mkdir -p "$ADB/modules/$ID" "$ADB/modules_update/$ID/scripts" "$MIHOMO_DATA/run"
  for script in "$ROOT"/scripts/*; do mkdir -p "$ADB/modules/$ID/scripts"; tr -d '\r' <"$script" >"$ADB/modules/$ID/scripts/${script##*/}"; done
  printf 'id=%s\nversion=OLD\n' "$ID" >"$ADB/modules/$ID/module.prop"
  printf 'id=%s\nversion=NEW\n' "$ID" >"$ADB/modules_update/$ID/module.prop"
  # 新版本的 service.sh 记录启动时 modules 下有哪些目录
  printf '#!/bin/sh\nls -A "%s/modules" >"%s/seen-at-start"\n' "$ADB" "$T" >"$ADB/modules_update/$ID/service.sh"
  printf '#!/bin/sh\necho "{\\"ok\\":true,\\"running\\":false}"\n' >"$ADB/modules_update/$ID/scripts/webui.sh"
  touch "$ADB/modules/$ID/update"
}

# 正常升级，并清理旧版本留下的 modules/.<id>.old.*
setup
mkdir -p "$ADB/modules/.$ID.old.123"
echo "id=$ID" >"$ADB/modules/.$ID.old.123/module.prop"
sh "$ROOT/scripts/live-update.sh" "$ID" "$ADB/modules_update/$ID" >"$T/log" 2>&1 || fail "live-update failed: $(cat "$T/log")"
[ "$(ls -A "$ADB/modules")" = "$ID" ] || fail "modules 下应只剩 $ID：$(ls -A "$ADB/modules" | tr '\n' ' ')"
[ "$(cat "$T/seen-at-start")" = "$ID" ] || fail "新版本启动时 modules 下有多余目录：$(tr '\n' ' ' <"$T/seen-at-start")"
grep -qx 'version=NEW' "$ADB/modules/$ID/module.prop" || fail '没有换成新版本'
[ ! -e "$ADB/modules/$ID/update" ] || fail 'update 标记未去掉'
[ ! -e "$ADB/modules_update" ] || fail 'modules_update 未清理'
[ -z "$(ls -A "$MIHOMO_DATA/run" | grep '^module-old' || true)" ] || fail '数据目录里留下了旧版本'

# 标记了卸载：不替换
setup
touch "$ADB/modules/$ID/remove"
sh "$ROOT/scripts/live-update.sh" "$ID" "$ADB/modules_update/$ID" >"$T/log" 2>&1
grep -qx 'version=OLD' "$ADB/modules/$ID/module.prop" || fail '标记卸载时不应替换'

# 参数校验
if sh "$ROOT/scripts/live-update.sh" ../x "$ADB/modules_update/x" >/dev/null 2>&1; then fail '应拒绝无效 id'; fi
if sh "$ROOT/scripts/live-update.sh" "$ID" "$T/elsewhere/$ID" >/dev/null 2>&1; then fail '应拒绝 modules_update 之外的目录'; fi
echo 'PASS: live-update'
