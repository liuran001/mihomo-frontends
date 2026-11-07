#!/system/bin/sh
# 模块升级后立即生效：由 customize.sh 在后台启动（先复制到数据目录再运行，因为它要搬走自己所在的目录）。
# 等 root 管理器写完 update 标记，把 modules_update/<id> 换到 modules/<id>，去掉 update 标记，再重启模块自己的后台进程。
# 内核与配置都在 /data/adb/mihomo，不受影响，代理不中断。
# 用法：live-update.sh <模块 id> <新版本目录（modules_update/<id>）>
ID=$1
NEW=$2
ADB=${NEW%/modules_update/*}
CUR=$ADB/modules/$ID
log() { printf '%s %s\n' "$(date '+%F %T' 2>/dev/null)" "$*"; }

case "$ID" in ''|*/*|.*) log "模块 id 无效：$ID"; exit 1 ;; esac
[ "$NEW" = "$ADB/modules_update/$ID" ] || { log "新版本目录无效：$NEW"; exit 1; }

# 安装器在 customize.sh 之后才写 update 标记并复制 module.prop；等它写完再动目录
waited=0
while [ ! -e "$CUR/update" ] && [ "$waited" -lt 180 ]; do
  sleep 1
  waited=$((waited + 1))
done
sleep 3
[ -f "$NEW/module.prop" ] && [ -f "$NEW/service.sh" ] || { log '新版本不完整，保持重启后生效'; exit 1; }
# 用户在此期间选择了卸载或禁用：交给管理器按原流程处理
if [ -e "$CUR/remove" ] || [ -e "$CUR/disable" ]; then
  log '模块已标记卸载或禁用，不立即替换'
  exit 0
fi

OLD=$ADB/modules/.$ID.old.$$
mv "$CUR" "$OLD" || { log '无法移开旧版本，保持重启后生效'; exit 1; }
if ! mv "$NEW" "$CUR"; then
  mv "$OLD" "$CUR"
  log '无法放入新版本，已还原，保持重启后生效'
  exit 1
fi
rm -f "$CUR/update"
rmdir "$ADB/modules_update" 2>/dev/null
log "已替换为 $(sed -n 's/^version=//p' "$CUR/module.prop")"

# 旧版本的巡检循环：脚本文件已随旧目录移走，结束它后由新版本的 service.sh 重新启动
for proc in /proc/[0-9]*; do
  pid=${proc#/proc/}
  [ "$pid" = "$$" ] && continue
  cmd=$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *"/$ID/scripts/policy.sh watch"*|*"/.$ID.old."*"/scripts/policy.sh watch"*) kill "$pid" 2>/dev/null && log "结束旧巡检 $pid" ;;
  esac
done

export MODDIR=$CUR SCRIPTS=$CUR/scripts
# 网页管理服务的程序在模块目录里：正在运行时换成新版本
webd_was=$(sh "$CUR/scripts/webui.sh" status 2>/dev/null)
case "$webd_was" in
  *'"running":true'*) sh "$CUR/scripts/webui.sh" stop >/dev/null 2>&1; log '已停止旧的网页管理服务' ;;
esac
sleep 1
sh "$CUR/service.sh" </dev/null >/dev/null 2>&1
log '已启动新版本的后台进程'
rm -rf "$OLD"
log '升级完成，无需重启'
