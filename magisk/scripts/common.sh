#!/system/bin/sh

for module_busybox in /data/adb/ksu/bin/busybox /data/adb/magisk/busybox /data/adb/ap/bin/busybox; do
  if [ -x "$module_busybox" ]; then
    if [ "$(readlink /proc/$$/exe 2>/dev/null)" != "$(readlink -f "$module_busybox")" ] || [ "${ASH_STANDALONE:-}" != 1 ]; then
      export ASH_STANDALONE=1
      exec "$module_busybox" sh "$0" "$@"
    fi
    break
  fi
done

MODDIR=${MODDIR:-/data/adb/modules/mihomo-ebpf}
SCRIPTS=${SCRIPTS:-${0%/*}}
DATA=${MIHOMO_DATA:-/data/adb/mihomo}
BIN=$DATA/mihomo
BIN_PREV=$DATA/mihomo.prev
CONFIG=$DATA/config.yaml
CANDIDATE=$DATA/config.yaml.new
BACKUP_DIR=$DATA/backup
RUN_DIR=$DATA/run
RUNTIME=$RUN_DIR/config.yaml
PID_FILE=$RUN_DIR/pid
LOG_FILE=$RUN_DIR/mihomo.log
SETTINGS=$DATA/settings.ini
INTENT=$RUN_DIR/intent
CONTROL_SOCKET=$RUN_DIR/controller.sock
TEMPLATE=$MODDIR/webroot/template.yaml
BACKUP_KEEP=10
START_TIMEOUT=${MIHOMO_START_TIMEOUT:-20}
STOP_TIMEOUT=${MIHOMO_STOP_TIMEOUT:-10}
LOCK_HELD=0
umask 077

ensure_dirs() {
  mkdir -p "$DATA" "$BACKUP_DIR" "$RUN_DIR" && chmod 700 "$DATA" "$RUN_DIR"
}

tool() {
  for toolbox in /data/adb/ksu/bin/busybox /data/adb/magisk/busybox /data/adb/ap/bin/busybox; do
    if [ -x "$toolbox" ] && "$toolbox" --list | grep -qx "$1"; then
      "$toolbox" "$@"
      return $?
    fi
  done
  if command -v "$1" >/dev/null 2>&1; then
    "$@"
    return $?
  fi
  echo "缺少工具: $1" >&2
  return 127
}

lock_backend() {
  [ "$LOCK_HELD" = 1 ] && return 0
  ensure_dirs || return 1
  exec 9>"$RUN_DIR/backend.lock" || return 1
  lock_wait=0
  until tool flock -n 9 2>/dev/null; do
    lock_wait=$((lock_wait + 1))
    [ "$lock_wait" -lt 60 ] || { echo '后台锁不可用或操作超时（需要 flock）' >&2; exec 9>&-; return 1; }
    sleep 1
  done
  LOCK_HELD=1
}

unlock_backend() {
  [ "$LOCK_HELD" = 1 ] || return 0
  exec 9>&-
  LOCK_HELD=0
}

setting_get() {
  if [ ! -f "${3:-$SETTINGS}" ]; then printf '%s\n' "$2"; return; fi
  awk -v key="$1" -v fallback="$2" '
    index($0, key "=") == 1 { print substr($0, length(key) + 2); found=1; exit }
    END { if (!found) print fallback }
  ' "${3:-$SETTINGS}"
}

settings_put() {
  case "$2" in ''|*[!a-zA-Z0-9_]*) return 1 ;; esac
  if printf '%s' "$3" | LC_ALL=C grep -q '[[:cntrl:]]'; then return 1; fi
  case "$3" in *'
'*) return 1 ;; esac
  touch "$1" || return 1
  awk -v key="$2" 'index($0, key "=") != 1 { print }' "$1" >"$1.edit" || return 1
  printf '%s=%s\n' "$2" "$3" >>"$1.edit" && mv -f "$1.edit" "$1"
}

setting_set() (
  lock_backend || exit 1
  trap 'rm -f "$RUN_DIR/settings.$$.tmp" "$RUN_DIR/settings.$$.tmp.edit"; unlock_backend' EXIT
  target=$RUN_DIR/settings.$$.tmp
  if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$target" || exit 1; else : >"$target"; fi
  settings_put "$target" "$1" "$2" && mv -f "$target" "$SETTINGS"
)

autostart() { [ "$(setting_get autostart 0)" = 1 ]; }
core_repo() { setting_get core_repo 'liuran001/mihomo'; }
core_tag() { setting_get core_tag ''; }
core_mirror() { setting_get core_mirror ''; }
file_rev() { if [ -f "$1" ]; then md5sum "$1" | awk '{print $1}'; else printf none; fi; }

json_escape() {
  printf '%s' "$1" | LC_ALL=C awk '
    BEGIN { for (number=1; number<32; number++) escape[sprintf("%c",number)]=sprintf("\\u%04x",number) }
    { if (NR>1) printf "\\n"; for (pos=1; pos<=length($0); pos++) {
      char=substr($0,pos,1)
      if (char=="\\") printf "\\\\"; else if (char=="\"") printf "\\\""
      else if (char in escape) printf "%s",escape[char]; else printf "%s",char
    } }
  '
}

json_error() { printf '{"ok":false,"error":"%s"}\n' "$(json_escape "$1")"; }

process_ticks() {
  case "$1" in ''|*[!0-9]*|0|1) return 1 ;; esac
  [ -r "/proc/$1/stat" ] || return 1
  sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '$1 != "Z" && NF>=20 {print $20}'
}

pid_matches() {
  [ -n "$2" ] && [ "$(process_ticks "$1")" = "$2" ] || return 1
  executable=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  case "$executable" in "$BIN"|"$BIN (deleted)") ;; *) return 1 ;; esac
  tr '\000' '\n' <"/proc/$1/cmdline" 2>/dev/null | awk -v data="$DATA" -v runtime="$RUNTIME" '
    previous=="-d" && $0==data {has_data=1}
    previous=="-f" && $0==runtime {has_config=1}
    {previous=$0}
    END {exit !(has_data && has_config)}
  '
}

pid_alive() {
  [ -f "$PID_FILE" ] || return 1
  read -r running_pid running_ticks extra <"$PID_FILE" || return 1
  [ -z "$extra" ] && pid_matches "$running_pid" "$running_ticks"
}

atomic_text() {
  printf '%s\n' "$2" >"$1.$$.tmp" && mv -f "$1.$$.tmp" "$1"
}

close_inherited_fds() {
  # 只关 3–9：后台锁（8、9）和调用方可能留下的低位描述符。10 以上是 shell 自己的（busybox ash 把被重定向的
  # 0–2 备份在这里），关掉后在 Android 上实测会让后台子 shell 空转写 /dev/null、长期占满一个 CPU；
  # mksh、dash 也不支持两位数描述符。
  for descriptor in 3 4 5 6 7 8 9; do
    eval "exec $descriptor>&-"
  done
}

module_enabled() { [ ! -e "$MODDIR/disable" ] && [ ! -e "$MODDIR/remove" ]; }

# 在 root 管理器的模块列表里显示运行状态：description 前加「状态 | 」，原说明保持不变
module_status() {
  status_prop=$MODDIR/module.prop
  [ -f "$status_prop" ] && [ -w "$status_prop" ] || return 0
  case "$1" in
    running) status_text='✅ 运行中' ;;
    paused) status_text='⏸️ 已暂停（Wi-Fi 条件）' ;;
    *) status_text='⏹️ 已停止' ;;
  esac
  grep -qF "description=$status_text | " "$status_prop" 2>/dev/null && return 0
  awk -v status="$status_text" '
    index($0, "description=") == 1 {
      text = substr($0, 13)
      sub(/^(✅|⏸️|⏹️)[^|]*\| /, "", text)
      print "description=" status " | " text
      next
    }
    { print }
  ' "$status_prop" >"$status_prop.$$.tmp" 2>/dev/null && mv -f "$status_prop.$$.tmp" "$status_prop" || rm -f "$status_prop.$$.tmp"
}

boot_intent() {
  boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || return 1
  if [ "$(cat "$RUN_DIR/boot-id" 2>/dev/null)" != "$boot_id" ]; then
    if autostart; then atomic_text "$INTENT" auto; else atomic_text "$INTENT" stopped; fi
    atomic_text "$RUN_DIR/boot-id" "$boot_id" || return 1
  fi
}
