#!/system/bin/sh
# 内核下载 / 信息 / 更新 / 回滚。
. "${0%/*}/common.sh"

abi_asset() {
  case "$(uname -m)" in
    aarch64|arm64) echo "android-arm64" ;;
    x86_64)        echo "android-amd64" ;;
    *)             return 1 ;;
  esac
}

latest_json() {
  repo=$(core_repo); tag=$(core_tag); mirror=$(core_mirror)
  if [ -n "$tag" ]; then
    url="https://api.github.com/repos/$repo/releases/tags/$tag"
  else
    url="https://api.github.com/repos/$repo/releases/latest"
  fi
  release_file=$(mktemp "${TMPDIR:-/data/local/tmp}/mihomo-release.XXXXXX") || return 1
  if ! fetch_release "$url" >"$release_file"; then
    if [ -n "$tag" ] || ! fetch_release "https://api.github.com/repos/$repo/releases?per_page=1" >"$release_file"; then
      rm -f "$release_file"
      return 1
    fi
  fi
  cat "$release_file"
  rm -f "$release_file"
}

fetch_release() {
  if [ -n "$(core_mirror)" ]; then
    curl -fsSL -m 30 "$(core_mirror)$1" 2>/dev/null && return
  fi
  curl -fsSL -m 30 "$1"
}

select_asset() {
  grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' |
    sed 's/^[^"]*"browser_download_url"[^"]*"//; s/"$//' |
    grep -E "/mihomo-$1(-[^/]*)?(\.gz)?$" |
    grep -vE '\.(sha256|txt|zip|xz|deb|rpm|apk)$' | head -n 1
}

# 从资源文件名取版本：mihomo-android-arm64-v8-alpha-smart-0cc66a1-ebpf.gz → alpha-smart-0cc66a1-ebpf
release_version() {
  name=${1##*/}; name=${name%.gz}
  name=${name#mihomo-"$2"}; name=${name#-v8}; name=${name#-}
  printf '%s' "$name"
}

installed_version() {
  [ -x "$BIN" ] || return 0
  "$BIN" -v 2>/dev/null | head -n 1 | sed 's/.*Mihomo Meta \([^ ]*\).*/\1/'
}

# 查最新 release：设置 tag、url、version；失败时输出 JSON 错误并返回 1
resolve_release() {
  command -v curl >/dev/null 2>&1 || { echo '{"ok":false,"error":"缺少 curl，请安装提供 curl 的模块后重试"}'; return 1; }
  asset=$(abi_asset) || { echo '{"ok":false,"error":"不支持的架构"}'; return 1; }
  ensure_dirs
  metadata=$(mktemp "$RUN_DIR/release.XXXXXX") || return 1
  latest_json >"$metadata" || { rm -f "$metadata"; echo '{"ok":false,"error":"获取 release 信息失败"}'; return 1; }
  tag=$(sed -n 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/p' "$metadata" | head -n 1)
  url=$(select_asset "$asset" <"$metadata")
  rm -f "$metadata"
  if [ -z "$url" ]; then
    printf '{"ok":false,"error":"release %s 中没有 %s 架构的内核"}\n' "$(json_escape "$tag")" "$asset"
    return 1
  fi
  version=$(release_version "$url" "$asset")
}

# 只查版本，不下载内核
check() {
  resolve_release || return 1
  current=$(installed_version)
  update=true
  [ -n "$current" ] && [ "$current" = "$version" ] && update=false
  printf '{"ok":true,"latest":"%s","tag":"%s","current":"%s","update_available":%s}\n' \
    "$(json_escape "$version")" "$(json_escape "$tag")" "$(json_escape "$current")" "$update"
}

check_core() {
  core_version=$("$1" -v 2>&1) || return 1
  printf '%s\n' "$core_version" | grep -q ' android '
}

download() {
  # $1 为 force 时即使版本相同也重新下载
  resolve_release || return 1
  current=$(installed_version)
  if [ "${1:-}" != force ] && [ -n "$version" ] && [ "$current" = "$version" ]; then
    printf '{"ok":true,"unchanged":true,"version":"%s","tag":"%s"}\n' "$(json_escape "$current")" "$(json_escape "$tag")"
    return 0
  fi
  mirror=$(core_mirror)
  dl="$url"
  [ -n "$mirror" ] && dl="${mirror}${url}"
  ensure_dirs
  tmp=$(mktemp "$RUN_DIR/mihomo.XXXXXX") || return 1
  if ! curl -fSL -m 600 -o "$tmp" "$dl"; then
    if [ -n "$mirror" ]; then
      curl -fSL -m 600 -o "$tmp" "$url" || { rm -f "$tmp"; echo '{"ok":false,"error":"下载失败"}'; return 1; }
    else
      rm -f "$tmp"
      echo '{"ok":false,"error":"下载失败"}'
      return 1
    fi
  fi
  case "$url" in
    *.gz)
      mv "$tmp" "$tmp.gz"
      gunzip -f "$tmp.gz" || { rm -f "$tmp" "$tmp.gz"; echo '{"ok":false,"error":"解压失败"}'; return 1; }
      ;;
  esac
  chmod 755 "$tmp"
  if ! check_core "$tmp"; then
    rm -f "$tmp"
    echo '{"ok":false,"error":"需要可运行的 Android 内核；Linux 内核不支持 Android 包名绕过"}'
    return 1
  fi
  lock_backend || { rm -f "$tmp"; echo '{"ok":false,"error":"后台忙，未替换内核"}'; return 1; }
  trap unlock_backend EXIT
  if [ -f "$BIN" ]; then
    cp -f "$BIN" "$BIN_PREV.tmp" && mv -f "$BIN_PREV.tmp" "$BIN_PREV" || { rm -f "$tmp"; echo '{"ok":false,"error":"备份旧内核失败"}'; return 1; }
  fi
  mv -f "$tmp" "$BIN" || { rm -f "$tmp"; echo '{"ok":false,"error":"安装内核失败"}'; return 1; }
  ver=$("$BIN" -v 2>/dev/null | head -n 1 | sed 's/.*Mihomo Meta \([^ ]*\).*/\1/')
  printf '{"ok":true,"version":"%s","tag":"%s"}\n' "$(json_escape "$ver")" "$(json_escape "$tag")"
}

info() {
  if [ -x "$BIN" ]; then
    ver=$("$BIN" -v 2>/dev/null | head -n 1)
    prev=""
    [ -f "$BIN_PREV" ] && prev="yes"
    printf '{"ok":true,"installed":true,"version":"%s","can_rollback":"%s"}\n' \
      "$(json_escape "$ver")" "$prev"
  else
    printf '{"ok":true,"installed":false}\n'
  fi
}

rollback() {
  lock_backend || { echo '{"ok":false,"error":"后台忙"}'; return 1; }
  trap unlock_backend EXIT
  if [ -f "$BIN_PREV" ]; then
    if ! check_core "$BIN_PREV"; then
      echo '{"ok":false,"error":"旧版本不是可运行的 Android 内核，不能回滚"}'
      return 1
    fi
    cp -f "$BIN" "$BIN_PREV.tmp" && mv -f "$BIN_PREV" "$BIN" &&
      mv -f "$BIN_PREV.tmp" "$BIN_PREV" || { echo '{"ok":false,"error":"内核回滚失败，请检查可用空间和文件权限"}'; return 1; }
    chmod 755 "$BIN"
    echo '{"ok":true}'
  else
    echo '{"ok":false,"error":"没有可回滚的旧版本"}'
    return 1
  fi
}

case "$1" in
  check)    check ;;
  download) download "$2" ;;
  info)     info ;;
  rollback) rollback ;;
  settings)
    # $2 repo $3 tag $4 mirror（空字符串用 - 占位传入）
    repo=$2; tag=$3; mirror=$4
    [ "$repo" = "-" ] && repo="liuran001/mihomo"
    [ "$tag" = "-" ] && tag=""
    [ "$mirror" = "-" ] && mirror=""
    if ! printf '%s\n' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ||
       [ "$(printf '%s' "$repo$tag$mirror" | tr -d '\r\n')" != "$repo$tag$mirror" ]; then
      echo '{"ok":false,"error":"下载设置格式无效"}'
      exit 1
    fi
    case "$mirror" in ''|https://*|http://*) ;; *) echo '{"ok":false,"error":"镜像地址必须使用 http:// 或 https://"}'; exit 1 ;; esac
    lock_backend || { echo '{"ok":false,"error":"后台忙"}'; exit 1; }
    target=$RUN_DIR/core-settings.$$.tmp
    trap 'rm -f "$target" "$target.edit"; unlock_backend' EXIT
    if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$target" || exit 1; else : >"$target"; fi
    settings_put "$target" core_repo "$repo" && settings_put "$target" core_tag "$tag" &&
      settings_put "$target" core_mirror "$mirror" && mv -f "$target" "$SETTINGS" || { echo '{"ok":false,"error":"保存下载设置失败"}'; exit 1; }
    echo '{"ok":true}'
    ;;
  get_settings)
    printf '{"ok":true,"repo":"%s","tag":"%s","mirror":"%s"}\n' \
      "$(json_escape "$(core_repo)")" "$(json_escape "$(core_tag)")" "$(json_escape "$(core_mirror)")"
    ;;
  *) echo "用法: $0 {download|info|rollback|settings|get_settings}" >&2; exit 2 ;;
esac
