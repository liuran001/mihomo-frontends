#!/system/bin/sh
. "${0%/*}/common.sh"
. "$SCRIPTS/policy-lib.sh"

fail() { json_error "$1"; exit 1; }
valid_backup() {
  case "$1" in config-*.yaml) ;; *) return 1 ;; esac
  case "$1" in *[!a-zA-Z0-9_.-]*) return 1 ;; esac
  [ -f "$BACKUP_DIR/$1" ] && [ ! -L "$BACKUP_DIR/$1" ]
}
lock_backend || fail '后台忙'
trap 'rm -f "$RUN_DIR/apply.$$."*; unlock_backend' EXIT

case "$1" in
  list)
    printf '{"ok":true,"list":['
    first=1
    for file in "$BACKUP_DIR"/config-*.yaml; do
      [ -f "$file" ] || continue
      name=${file##*/}
      valid_backup "$name" || continue
      [ "$first" = 1 ] || printf ','
      first=0
      printf '{"name":"%s","size":%s}' "$(json_escape "$name")" "$(wc -c <"$file" | tr -d ' ')"
    done
    printf ']}\n'
    ;;
  read)
    valid_backup "$2" || fail '备份不存在或文件名无效'
    base64 <"$BACKUP_DIR/$2" | tr -d '\r\n'; echo
    ;;
  delete)
    valid_backup "$2" || fail '备份不存在或文件名无效'
    rm -f "$BACKUP_DIR/$2" || fail '删除失败'
    echo '{"ok":true}'
    ;;
  restore)
    valid_backup "$2" || fail '备份不存在或文件名无效'
    # 运行中时热重载（控制器设置不同或重载失败时自动改为重启）
    restart=''; pid_alive && restart=reload
    detail=$(apply_config_file "$BACKUP_DIR/$2" "$restart" 2>&1) || fail "$detail"
    echo '{"ok":true}'
    ;;
  *) fail '用法: backup.sh list|read|delete|restore' ;;
esac
