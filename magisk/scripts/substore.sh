#!/system/bin/sh
# Sub-Store：订阅管理。可以使用已有的 Sub-Store 服务，或在本机运行（按需下载 node 与 Sub-Store）。
#   substore.sh status                    {"ok":true,"mode":...,"installed":{...},"running":bool,...}
#   substore.sh set MODE PORT LAN B64URL  MODE 为 off|local|remote；LAN 为 0|1；URL 为已有服务的后端地址（remote 时）
#   substore.sh install [all|node|backend|frontend]   下载或更新（使用「内核版本」里的下载镜像）
#   substore.sh start|stop|restart
#   substore.sh reset-path                重新生成后端路径（旧的订阅链接失效）
#   substore.sh list                      列出 Sub-Store 里的订阅与组合订阅（原样输出两段 JSON）
#   substore.sh uninstall                 停止并删除下载的程序（保留数据）
#   substore.sh boot                      开机时由 service.sh 调用：本机模式且已安装时启动
. "${0%/*}/common.sh"

SS_DIR=$DATA/substore
SS_NODE=$SS_DIR/node
SS_BUNDLE=$SS_DIR/sub-store.bundle.js
SS_FRONT=$SS_DIR/frontend
SS_DATA=$SS_DIR/data
SS_CONF=$SS_DIR/substore.ini
SS_PID=$RUN_DIR/substore.pid
SS_LOG=$RUN_DIR/substore.log
NODE_REPO=lanyi233/node-android-build
NODE_MAJOR=24
BACKEND_REPO=sub-store-org/Sub-Store
FRONTEND_REPO=sub-store-org/Sub-Store-Front-End

fail() { json_error "$1"; exit 1; }

conf() { setting_get "$1" "$2" "$SS_CONF"; }
conf_put() { mkdir -p "$SS_DIR" && chmod 700 "$SS_DIR" && settings_put "$SS_CONF" "$1" "$2"; }

ss_mode() { conf mode off; }
ss_port() { conf port 3001; }
ss_lan() { conf lan 0; }
ss_url() { conf url ''; }

# 后端路径：只有知道它的人才能访问接口（合并模式下前端在根路径，接口在 /路径 下）
ss_path() {
  path=$(conf path '')
  if [ -z "$path" ]; then
    path=$(tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24)
    [ "${#path}" -eq 24 ] || path=$(date +%s%N | md5sum | cut -c1-24)
    conf_put path "$path" >/dev/null 2>&1
  fi
  printf '%s' "$path"
}

node_arch() {
  case "$(uname -m)" in
    aarch64|arm64|armv8*) echo arm64 ;;
    armv7*|armv6*|arm) echo arm ;;
    x86_64|amd64) echo x64 ;;
    i686|i386|x86) echo ia32 ;;
    *) return 1 ;;
  esac
}

ss_matches() {
  [ -n "$2" ] && [ "$(process_ticks "$1")" = "$2" ] || return 1
  executable=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  case "$executable" in "$SS_NODE"|"$SS_NODE (deleted)") return 0 ;; esac
  return 1
}

ss_alive() {
  [ -f "$SS_PID" ] || return 1
  read -r ss_pid ss_ticks extra <"$SS_PID" || return 1
  [ -z "$extra" ] && ss_matches "$ss_pid" "$ss_ticks"
}

installed_node() { [ -x "$SS_NODE" ]; }
installed_backend() { [ -s "$SS_BUNDLE" ]; }
installed_frontend() { [ -f "$SS_FRONT/index.html" ]; }

status() {
  running=false; ss_alive && running=true
  node=false; installed_node && node=true
  backend=false; installed_backend && backend=true
  frontend=false; installed_frontend && frontend=true
  printf '{"ok":true,"mode":"%s","port":%s,"lan":%s,"url":"%s","path":"%s","arch":"%s","running":%s,' \
    "$(json_escape "$(ss_mode)")" "$(ss_port)" "$([ "$(ss_lan)" = 1 ] && echo true || echo false)" \
    "$(json_escape "$(ss_url)")" "$(json_escape "$(ss_path)")" "$(node_arch || echo unknown)" "$running"
  printf '"installed":{"node":%s,"backend":%s,"frontend":%s},' "$node" "$backend" "$frontend"
  printf '"versions":{"node":"%s","backend":"%s","frontend":"%s"}}\n' \
    "$(json_escape "$(cat "$SS_DIR/node.version" 2>/dev/null)")" \
    "$(json_escape "$(cat "$SS_DIR/backend.version" 2>/dev/null)")" \
    "$(json_escape "$(cat "$SS_DIR/frontend.version" 2>/dev/null)")"
}

# ---------- 下载 ----------

github_api() {
  mirror=$(core_mirror)
  if [ -n "$mirror" ]; then
    curl -fsSL -m 30 "$mirror$1" 2>/dev/null && return
  fi
  curl -fsSL -m 30 "$1"
}

fetch_file() {
  mirror=$(core_mirror)
  if [ -n "$mirror" ] && curl -fSL -m 900 -o "$2" "$mirror$1" 2>>"$SS_LOG"; then return 0; fi
  curl -fSL -m 900 -o "$2" "$1" 2>>"$SS_LOG"
}

release_tag() {
  github_api "https://api.github.com/repos/$1/releases/latest" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'
}

install_node() {
  arch=$(node_arch) || { echo "不支持的处理器架构：$(uname -m)" >&2; return 1; }
  release=$(github_api "https://api.github.com/repos/$NODE_REPO/releases/tags/node-android-$arch-$NODE_MAJOR") || { echo '无法获取 node 版本列表（GitHub API 不可达，可在「内核版本」里设置下载镜像）' >&2; return 1; }
  # 资源名 node-android-<arch>-<版本>.tar.xz，取版本号最大的
  url=$(printf '%s\n' "$release" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*node-android-'"$arch"'-[0-9.]*\.tar\.xz"' |
    sed 's/.*"\(https[^"]*\)"$/\1/' |
    awk -F'-' '{ version=$NF; sub(/\.tar\.xz$/, "", version); split(version, part, "."); printf "%06d%06d%06d %s\n", part[1], part[2], part[3], $0 }' |
    sort | tail -n 1 | cut -d' ' -f2)
  [ -n "$url" ] || { echo "没有找到 $arch 架构的 node $NODE_MAJOR 构建" >&2; return 1; }
  version=${url##*-}; version=${version%.tar.xz}
  work=$SS_DIR/.node.$$
  rm -rf "$work"; mkdir -p "$work" || return 1
  fetch_file "$url" "$work/node.tar.xz" || { rm -rf "$work"; echo '下载 node 失败' >&2; return 1; }
  (cd "$work" && { tool xz -dc node.tar.xz 2>/dev/null || tool unxz -c node.tar.xz; } | tool tar -x) || { rm -rf "$work"; echo '解压 node 失败（需要 xz 与 tar）' >&2; return 1; }
  binary=$(find "$work" -type f -name node | head -n 1)
  [ -n "$binary" ] || { rm -rf "$work"; echo '压缩包里没有 node' >&2; return 1; }
  chmod 755 "$binary"
  "$binary" -v >/dev/null 2>&1 || { rm -rf "$work"; echo 'node 无法在本机运行' >&2; return 1; }
  mv -f "$binary" "$SS_NODE" && printf '%s\n' "$version" >"$SS_DIR/node.version"
  rm -rf "$work"
}

install_backend() {
  tag=$(release_tag "$BACKEND_REPO")
  fetch_file "https://github.com/$BACKEND_REPO/releases/latest/download/sub-store.bundle.js" "$SS_BUNDLE.new" || { rm -f "$SS_BUNDLE.new"; echo '下载 Sub-Store 后端失败' >&2; return 1; }
  [ "$(wc -c <"$SS_BUNDLE.new")" -gt 100000 ] || { rm -f "$SS_BUNDLE.new"; echo 'Sub-Store 后端文件不完整' >&2; return 1; }
  mv -f "$SS_BUNDLE.new" "$SS_BUNDLE" && printf '%s\n' "${tag:-latest}" >"$SS_DIR/backend.version"
}

install_frontend() {
  tag=$(release_tag "$FRONTEND_REPO")
  work=$SS_DIR/.front.$$
  rm -rf "$work"; mkdir -p "$work" || return 1
  fetch_file "https://github.com/$FRONTEND_REPO/releases/latest/download/dist.zip" "$work/dist.zip" || { rm -rf "$work"; echo '下载 Sub-Store 前端失败' >&2; return 1; }
  tool unzip -q -o "$work/dist.zip" -d "$work/out" || { rm -rf "$work"; echo '解压 Sub-Store 前端失败' >&2; return 1; }
  index=$(find "$work/out" -type f -name index.html | head -n 1)
  [ -n "$index" ] || { rm -rf "$work"; echo '前端压缩包里没有 index.html' >&2; return 1; }
  rm -rf "$SS_FRONT.old"; [ -d "$SS_FRONT" ] && mv "$SS_FRONT" "$SS_FRONT.old"
  mv "${index%/index.html}" "$SS_FRONT" && rm -rf "$SS_FRONT.old" && printf '%s\n' "${tag:-latest}" >"$SS_DIR/frontend.version"
  rm -rf "$work"
}

install() {
  command -v curl >/dev/null 2>&1 || fail '缺少 curl'
  mkdir -p "$SS_DIR" "$SS_DATA" && chmod 700 "$SS_DIR" || fail '无法创建 Sub-Store 目录'
  what=${1:-all}
  was_running=false; ss_alive && was_running=true
  case "$what" in
    all)
      # 已有的 node 不重复下载（体积较大），单独更新时再下载
      if ! installed_node; then error=$(install_node 2>&1) || fail "$error"; fi
      error=$(install_backend 2>&1) || fail "$error"
      error=$(install_frontend 2>&1) || fail "$error"
      ;;
    node) error=$(install_node 2>&1) || fail "$error" ;;
    backend) error=$(install_backend 2>&1) || fail "$error" ;;
    frontend) error=$(install_frontend 2>&1) || fail "$error" ;;
    *) fail '参数无效' ;;
  esac
  if [ "$was_running" = true ] || [ "$(ss_mode)" = local ]; then
    ss_stop
    error=$(ss_start 2>&1) || fail "已下载，但启动失败：$error"
  fi
  status
}

# ---------- 运行 ----------

ss_stop() {
  if ss_alive; then
    kill "$ss_pid" 2>/dev/null
    wait_count=0
    while ss_matches "$ss_pid" "$ss_ticks"; do
      [ "$wait_count" -ge 25 ] && { kill -9 "$ss_pid" 2>/dev/null; sleep 1; break; }
      wait_count=$((wait_count + 1))
      sleep 0.2 2>/dev/null || sleep 1
    done
  fi
  rm -f "$SS_PID"
}

ss_start() {
  ss_alive && return 0
  installed_node && installed_backend || { echo '还没有下载 Sub-Store' >&2; return 1; }
  ensure_dirs && mkdir -p "$SS_DATA" || return 1
  ss_path >/dev/null
  [ -f "$SS_LOG" ] && [ "$(wc -c <"$SS_LOG")" -gt 1048576 ] && mv -f "$SS_LOG" "$SS_LOG.1"
  # 在子 shell 里用 exec 永久改 0–2：若写成 ( … ) >/dev/null &，busybox ash 会把调用方的 0–2 备份到 10 以上并一直
  # 持有到子 shell 结束，而子 shell 要等常驻进程退出，调用方（ksu.exec、网页服务 api/run）就一直读不到输出结束
  (
    exec </dev/null >/dev/null 2>&1
    close_inherited_fds
    trap '' HUP
    tool setsid sh "$SCRIPTS/substore.sh" launch </dev/null >>"$SS_LOG" 2>&1
  ) &
  wait_count=0
  while [ "$wait_count" -lt 75 ]; do
    sleep 0.2 2>/dev/null || sleep 1
    if ss_alive && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$(ss_port)/$(ss_path)/api/utils/env" 2>/dev/null; then return 0; fi
    wait_count=$((wait_count + 1))
  done
  ss_alive && return 0
  echo "Sub-Store 未能启动：$(tail -n 3 "$SS_LOG" 2>/dev/null | tr '\n' ' ')" >&2
  return 1
}

launch() {
  launch_ticks=$(process_ticks "$$")
  [ -n "$launch_ticks" ] && atomic_text "$SS_PID" "$$ $launch_ticks" || exit 1
  host=127.0.0.1; [ "$(ss_lan)" = 1 ] && host=0.0.0.0
  export SUB_STORE_BACKEND_API_HOST=$host
  export SUB_STORE_BACKEND_API_PORT=$(ss_port)
  export SUB_STORE_BACKEND_MERGE=true
  export SUB_STORE_FRONTEND_BACKEND_PATH=/$(ss_path)
  export SUB_STORE_DATA_BASE_PATH=$SS_DATA
  installed_frontend && export SUB_STORE_FRONTEND_PATH=$SS_FRONT
  cd "$SS_DATA" || exit 1
  exec "$SS_NODE" "$SS_BUNDLE"
}

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

set_conf() {
  [ "$#" -eq 4 ] || fail '参数无效'
  case "$1" in off|local|remote) ;; *) fail '模式无效' ;; esac
  valid_port "$2" || fail '端口须为 1024–65535'
  case "$3" in 0|1) ;; *) fail '局域网开关无效' ;; esac
  url=
  if [ "$4" != - ]; then
    url=$(printf '%s' "$4" | base64 -d 2>/dev/null) || fail '地址不是 base64'
  fi
  case "$url" in ''|http://*|https://*) ;; *) fail '地址必须以 http:// 或 https:// 开头' ;; esac
  case "$url" in *[[:space:]]*|*'"'*) fail '地址不能含空白或引号' ;; esac
  [ "$1" = remote ] && [ -z "$url" ] && fail '请填写 Sub-Store 后端地址'
  old_port=$(ss_port); old_lan=$(ss_lan)
  conf_put mode "$1" && conf_put port "$2" && conf_put lan "$3" && conf_put url "${url%/}" || fail '保存失败'
  if [ "$1" = local ]; then
    if ss_alive && { [ "$old_port" != "$2" ] || [ "$old_lan" != "$3" ]; }; then ss_stop; fi
    if installed_node && installed_backend; then error=$(ss_start 2>&1) || fail "$error"; fi
  else
    ss_stop
  fi
  status
}

# 当前模式下的后端地址（不带结尾 /）
api_base() {
  case "$(ss_mode)" in
    local) printf 'http://127.0.0.1:%s/%s' "$(ss_port)" "$(ss_path)" ;;
    remote) ss_url ;;
    *) return 1 ;;
  esac
}

list() {
  base=$(api_base) || fail '没有启用 Sub-Store'
  subs=$(curl -fsS -m 15 "$base/api/subs" 2>&1) || fail "读取订阅失败：$subs"
  collections=$(curl -fsS -m 15 "$base/api/collections" 2>/dev/null) || collections=null
  printf '%s\n%s\n' "$subs" "$collections"
}

case "$1" in
  status) status ;;
  set) shift; set_conf "$@" ;;
  install) install "$2" ;;
  start) error=$(ss_start 2>&1) || fail "$error"; status ;;
  stop) ss_stop; status ;;
  restart) ss_stop; error=$(ss_start 2>&1) || fail "$error"; status ;;
  reset-path) conf_put path '' >/dev/null; ss_path >/dev/null; ss_alive && { ss_stop; ss_start >/dev/null 2>&1; }; status ;;
  list) list ;;
  uninstall) ss_stop; rm -rf "$SS_NODE" "$SS_BUNDLE" "$SS_FRONT" "$SS_DIR"/*.version; conf_put mode off; status ;;
  launch) launch ;;
  boot) [ "$(ss_mode)" = local ] && module_enabled && installed_node && installed_backend && ss_start ;;
  *) fail '用法: substore.sh status|set|install|start|stop|restart|reset-path|list|uninstall|boot' ;;
esac
