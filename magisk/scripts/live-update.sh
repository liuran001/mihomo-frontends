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

RUN_DIR=${MIHOMO_DATA:-/data/adb/mihomo}/run

# 网页管理服务（mihomo-webd）的程序在模块目录里，要换成新版本。必须在移动目录之前用旧脚本停止：
# 旧脚本按 /proc/<pid>/exe 是否等于模块目录里的程序来认进程，目录改名后就认不出了。
# 停止不会改「启用」设置，新版本的 service.sh 会按设置重新启动它。
webd_running=false
case "$(MODDIR=$CUR SCRIPTS=$CUR/scripts sh "$CUR/scripts/webui.sh" status 2>/dev/null)" in
  *'"running":true'*) webd_running=true ;;
esac
if [ "$webd_running" = true ]; then
  MODDIR=$CUR SCRIPTS=$CUR/scripts sh "$CUR/scripts/webui.sh" stop >/dev/null 2>&1
  log '已停止旧的网页管理服务'
fi

restore_webd() {
  [ "$webd_running" = true ] && MODDIR=$CUR SCRIPTS=$CUR/scripts sh "$CUR/scripts/webui.sh" start >/dev/null 2>&1
}
# 旧版本先移到数据目录里，替换失败时还能放回去；不能留在 modules 下：
# 管理器会把那里每个带 module.prop 的目录都当成模块，两个同 id 的模块会让它出错甚至崩溃
mkdir -p "$RUN_DIR" || { restore_webd; log '无法创建运行目录，保持重启后生效'; exit 1; }
OLD=$RUN_DIR/module-old.$$
rm -rf "$OLD"
mv "$CUR" "$OLD" || { restore_webd; log '无法移开旧版本，保持重启后生效'; exit 1; }
if ! mv "$NEW" "$CUR"; then
  mv "$OLD" "$CUR"
  restore_webd
  log '无法放入新版本，已还原，保持重启后生效'
  exit 1
fi
rm -f "$CUR/update"
rmdir "$ADB/modules_update" 2>/dev/null
# 以前的版本把旧目录放在 modules/.<id>.old.<pid>，中途被打断会一直留着，顺手清掉
for stale in "$ADB/modules/.$ID.old."*; do
  [ -d "$stale" ] && rm -rf "$stale" && log "已清理残留的旧版本目录 $stale"
done
log "已替换为 $(sed -n 's/^version=//p' "$CUR/module.prop")"

# 旧版本的巡检循环：它用 flock 占着 watch.lock，这把锁会被它正在 sleep 的子进程继承，
# 只结束外层 shell 时新巡检拿不到锁就会退出。所以结束所有持有这把锁的进程，再按命令行补一遍。
for proc in /proc/[0-9]*; do
  pid=${proc#/proc/}
  [ "$pid" = "$$" ] && continue
  hit=false
  for fd in "$proc"/fd/*; do
    [ "$(readlink "$fd" 2>/dev/null)" = "$RUN_DIR/watch.lock" ] && { hit=true; break; }
  done
  if [ "$hit" = false ]; then
    cmd=$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null) || continue
    case "$cmd" in
      *"/$ID/scripts/policy.sh watch"*|*"/.$ID.old."*"/scripts/policy.sh watch"*|*"/module-old."*"/scripts/policy.sh watch"*) hit=true ;;
    esac
  fi
  [ "$hit" = true ] && kill "$pid" 2>/dev/null && log "结束旧巡检进程 $pid"
done

# 旧版本的进程都已结束，旧目录不再需要
rm -rf "$OLD"

export MODDIR=$CUR SCRIPTS=$CUR/scripts
sleep 1
sh "$CUR/service.sh" </dev/null >/dev/null 2>&1
log '已启动新版本的后台进程'

# 核对：启用了网页管理的，等它起来
if "$CUR/bin/mihomo-webd" enabled -c "${MIHOMO_DATA:-/data/adb/mihomo}/webui.json" 2>/dev/null; then
  n=0
  until sh "$CUR/scripts/webui.sh" status 2>/dev/null | grep -q '"running":true'; do
    n=$((n + 1))
    [ "$n" -ge 15 ] && { log '网页管理服务没有起来，尝试再启动一次'; sh "$CUR/scripts/webui.sh" start >/dev/null 2>&1; break; }
    sleep 1
  done
  sh "$CUR/scripts/webui.sh" status 2>/dev/null | grep -q '"running":true' && log '网页管理服务已是新版本' || log '网页管理服务启动失败，见 run/webd.log'
fi
log '升级完成，无需重启'
