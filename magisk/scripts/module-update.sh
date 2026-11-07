#!/system/bin/sh
# 模块自身的检查更新与一键升级。
#   check    读取最新 release 的 update.json，与本模块的 versionCode 比较
#   upgrade  下载新版本 zip、校验 sha256，交给 root 管理器（KernelSU / APatch / Magisk）安装；
#            customize.sh 随后在后台把新版本直接换上（见 live-update.sh），不需要重启
. "${0%/*}/common.sh"

MODULE_REPO=liuran001/mihomo-frontends
MANIFEST_URL=https://github.com/$MODULE_REPO/releases/latest/download/update.json
DOWNLOAD_PREFIX=https://github.com/$MODULE_REPO/releases/download/
UPDATE_LOG=$RUN_DIR/module-update.log

fail() { json_error "$1"; exit 1; }

prop() { sed -n "s/^$1=//p" "$MODDIR/module.prop" 2>/dev/null | head -n 1 | tr -d '\r'; }

# 先走下载镜像（与内核下载同一设置），失败再直连
fetch() {
  mirror=$(core_mirror)
  if [ -n "$mirror" ] && curl -fsSL -m "$1" -o "$3" "$mirror$2" 2>/dev/null && [ -s "$3" ]; then return 0; fi
  curl -fsSL -m "$1" -o "$3" "$2" 2>/dev/null && [ -s "$3" ]
}

# update.json 每个字段一行；version 取第一个（顶层），luci 段里的同名字段在后面
field() { sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*$/\1/p" "$2" | head -n 1; }

# 读清单：设置 latest、latest_code、zip_url、zip_sha、changelog
read_manifest() {
  command -v curl >/dev/null 2>&1 || fail '缺少 curl，无法检查更新'
  ensure_dirs || fail '无法创建运行目录'
  manifest=$(mktemp "$RUN_DIR/update-json.XXXXXX") || fail '无法创建临时文件'
  if ! fetch 30 "$MANIFEST_URL" "$manifest"; then rm -f "$manifest"; fail '获取更新信息失败，请检查网络或下载镜像'; fi
  latest=$(field version "$manifest")
  latest_code=$(field versionCode "$manifest")
  zip_url=$(field zipUrl "$manifest")
  zip_sha=$(field zipSha256 "$manifest")
  changelog=$(field changelog "$manifest")
  rm -f "$manifest"
  case "$latest_code" in ''|*[!0-9]*) fail '更新信息格式不对' ;; esac
  # 只接受本仓库 release 里的文件，校验值必须是 64 位十六进制
  case "$zip_url" in "$DOWNLOAD_PREFIX"*.zip) ;; *) fail '更新信息里的下载地址不是本项目的 release' ;; esac
  case "$zip_url" in *..*|*' '*) fail '更新信息里的下载地址无效' ;; esac
  printf '%s' "$zip_sha" | grep -Eq '^[0-9a-f]{64}$' || fail '更新信息缺少有效的 sha256'
}

current_code() { c=$(prop versionCode); case "$c" in ''|*[!0-9]*) echo 0 ;; *) echo "$c" ;; esac; }

check() {
  read_manifest
  current=$(prop version)
  code=$(current_code)
  update=false
  [ "$latest_code" -gt "$code" ] && update=true
  printf '{"ok":true,"current":"%s","current_code":%s,"latest":"%s","latest_code":%s,"update_available":%s,"changelog":"%s"}\n' \
    "$(json_escape "$current")" "$code" "$(json_escape "$latest")" "$latest_code" "$update" "$(json_escape "$changelog")"
}

# 按 root 方案选安装命令
installer() {
  if [ -x /data/adb/ksud ]; then echo '/data/adb/ksud module install'
  elif [ -x /data/adb/apd ]; then echo '/data/adb/apd module install'
  elif command -v magisk >/dev/null 2>&1; then echo 'magisk --install-module'
  else return 1
  fi
}

upgrade() {
  read_manifest
  code=$(current_code)
  [ "$latest_code" -gt "$code" ] || [ "${1:-}" = force ] || {
    printf '{"ok":true,"unchanged":true,"version":"%s"}\n' "$(json_escape "$(prop version)")"
    return 0
  }
  cmd=$(installer) || fail '没有找到 KernelSU、APatch 或 Magisk 的安装命令'
  zip=$RUN_DIR/module-update.zip
  rm -f "$zip"
  fetch 600 "$zip_url" "$zip" || { rm -f "$zip"; fail '下载新版本失败，请检查网络或下载镜像'; }
  got=$(sha256sum "$zip" | cut -d' ' -f1)
  [ "$got" = "$zip_sha" ] || { rm -f "$zip"; fail '新版本校验失败（sha256 不符），已放弃安装'; }
  # 安装器输出写日志；customize.sh 会在后台换上新版本
  if ! $cmd "$zip" >"$UPDATE_LOG" 2>&1 </dev/null; then
    rm -f "$zip"
    fail "安装失败：$(tail -n 3 "$UPDATE_LOG" | tr '\n' ' ')"
  fi
  rm -f "$zip"
  live=false
  grep -q '立即生效' "$UPDATE_LOG" && live=true
  printf '{"ok":true,"version":"%s","live":%s}\n' "$(json_escape "$latest")" "$live"
}

case "$1" in
  check) check ;;
  upgrade) upgrade "$2" ;;
  current) printf '{"ok":true,"current":"%s","current_code":%s}\n' "$(json_escape "$(prop version)")" "$(current_code)" ;;
  *) fail '用法: module-update.sh check|upgrade [force]|current' ;;
esac
