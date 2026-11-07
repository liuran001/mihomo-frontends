#!/system/bin/sh
# 本机信息探测与远程配置下载。只读，不改动配置与策略。
#   host.sh probe          输出 JSON：架构、SDK、内存、eBPF/BTF、IPv6、上游/共享网卡
#   host.sh fetch URL UA   下载远程配置到 run/import.yaml，输出 {"ok":true,"size":N}
#   host.sh stage N B64    把第 N 段 base64 追加到暂存文件（N=0 时清空），供大配置分段写入
#   host.sh read-config    输出 config.yaml 的 base64（单行）
#   host.sh import-read    输出 fetch 下载内容的 base64 并删除下载文件
#   host.sh validate SRC   用内核 -t 校验配置；SRC 为 base64 或 --staged（暂存文件，用后删除）
#   host.sh logs N         输出最近 N 行内核日志与 logcat 中的 mihomo 日志
#   host.sh controller     输出配置中的 external-controller、secret、external-ui 行（原样）
#   host.sh netcheck       在本机测各平台连通性（有 mixed-port/port 时经内核代理，与本机应用同一路由），输出毫秒
#   host.sh exitip         在本机查询国内、海外出口 IP，输出两个服务的原始 JSON（字符串）
#   host.sh api METHOD URL [BODY]
#                          请求本机控制器，密钥由环境变量 MIHOMO_SECRET 传入；输出响应体与 __MIHOMO_HTTP__:状态码
# 网页管理（mihomo-webd）只能调用这些脚本子命令，不能执行任意 shell。
. "${0%/*}/common.sh"
. "$SCRIPTS/policy-lib.sh"

STAGE=$RUN_DIR/stage.b64
IMPORT=$RUN_DIR/import.yaml
MAX_IMPORT=4194304
NL='
'

fail() { json_error "$1"; exit 1; }

json_bool() { if "$@"; then printf true; else printf false; fi; }

has_btf() { [ -r /sys/kernel/btf/vmlinux ]; }

has_cgroup2() {
  awk '$3=="cgroup2"{found=1} END{exit !found}' /proc/mounts 2>/dev/null
}

has_bpf_fs() {
  awk '$3=="bpf"{found=1} END{exit !found}' /proc/mounts 2>/dev/null
}

kernel_at_least() {
  # $1 major $2 minor
  release=$(uname -r 2>/dev/null)
  major=${release%%.*}
  rest=${release#*.}
  minor=${rest%%[!0-9]*}
  case "$major$minor" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$1" ] || { [ "$major" -eq "$1" ] && [ "$minor" -ge "$2" ]; }
}

# Android 使用策略路由，默认路由分散在多张表里；用 route get 取实际出口。
# 只有源地址为全局单播（2000::/3）时才认为有可用的 IPv6 出口。
ipv6_upstream() {
  source=$(tool timeout 3 ip -6 route get 2001:4860:4860::8888 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')
  case "$source" in [23]???:*|[23]??:*|[23]?:*|[23]:*) return 0 ;; *) return 1 ;; esac
}

ipv4_upstream() {
  tool timeout 3 ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}'
}

mem_mb() {
  awk '/^MemTotal:/{printf "%d", $2/1024; exit}' /proc/meminfo 2>/dev/null
}

prop() { getprop "$1" 2>/dev/null | tr -d '\r\n"\\'; }

probe() {
  release=$(uname -r 2>/dev/null)
  machine=$(uname -m 2>/dev/null)
  sdk=$(prop ro.build.version.sdk)
  case "$sdk" in ''|*[!0-9]*) sdk=0 ;; esac
  cpus=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
  case "$cpus" in ''|*[!0-9]*) cpus=0 ;; esac
  memory=$(mem_mb)
  case "$memory" in ''|*[!0-9]*) memory=0 ;; esac
  upstream=$(ipv4_upstream)
  case "$upstream" in *[!a-zA-Z0-9_.-]*) upstream='' ;; esac
  core_ok=false
  if [ -x "$BIN" ] && "$BIN" -v 2>/dev/null | grep -q ' android '; then core_ok=true; fi
  root_impl=unknown
  if [ -d /data/adb/ksu ]; then root_impl=kernelsu
  elif [ -d /data/adb/ap ]; then root_impl=apatch
  elif [ -d /data/adb/magisk ]; then root_impl=magisk
  fi
  printf '{"ok":true,"abi":"%s","kernel":"%s","sdk":%s,"android":"%s","model":"%s","cpus":%s,"mem_mb":%s,' \
    "$(json_escape "$machine")" "$(json_escape "$release")" "$sdk" "$(json_escape "$(prop ro.build.version.release)")" \
    "$(json_escape "$(prop ro.product.model)")" "$cpus" "$memory"
  printf '"btf":%s,"cgroup2":%s,"bpffs":%s,"kernel_ok":%s,"ipv6":%s,"upstream":"%s","ssid":"%s","core":%s,"root":"%s","mirror":"%s","has_config":%s}\n' \
    "$(json_bool has_btf)" "$(json_bool has_cgroup2)" "$(json_bool has_bpf_fs)" "$(json_bool kernel_at_least 5 10)" \
    "$(json_bool ipv6_upstream)" "$upstream" "$(json_escape "$(current_ssid_quiet)")" "$core_ok" "$root_impl" \
    "$(json_escape "$(core_mirror)")" "$(json_bool test -s "$CONFIG")"
}

current_ssid_quiet() { current_ssid 2>/dev/null; }

fetch() {
  url=$1
  agent=${2:-clash.meta}
  case "$url" in http://*|https://*) ;; *) fail '只支持 http(s) 链接' ;; esac
  case "$url$agent" in *'
'*|*"$(printf '\r')"*) fail '链接不能含换行' ;; esac
  [ "${#url}" -le 4096 ] && [ "${#agent}" -le 256 ] || fail '链接或 UA 过长'
  command -v curl >/dev/null 2>&1 || fail '缺少 curl，无法下载'
  ensure_dirs || fail '无法创建数据目录'
  tmp=$RUN_DIR/import.$$.tmp
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --compressed -m 60 --max-filesize "$MAX_IMPORT" -A "$agent" -o "$tmp" -- "$url" 2>"$tmp.err" || {
    detail=$(tail -n 1 "$tmp.err" 2>/dev/null); rm -f "$tmp.err"
    fail "下载失败：${detail:-网络错误}"
  }
  rm -f "$tmp.err"
  [ -s "$tmp" ] || fail '下载内容为空'
  size=$(wc -c <"$tmp" | tr -d ' ')
  [ "$size" -le "$MAX_IMPORT" ] || fail '下载内容超过 4 MB'
  mv -f "$tmp" "$IMPORT" || fail '保存下载内容失败'
  trap - EXIT
  printf '{"ok":true,"size":%s}\n' "$size"
}

stage() {
  index=$1
  chunk=$2
  case "$index" in ''|*[!0-9]*) fail '分段序号无效' ;; esac
  case "$chunk" in ''|*[!a-zA-Z0-9+/=]*) fail '分段内容不是 base64' ;; esac
  [ "${#chunk}" -le 100000 ] || fail '分段过大'
  ensure_dirs || fail '无法创建数据目录'
  if [ "$index" = 0 ]; then : >"$STAGE" || fail '无法创建暂存文件'; fi
  [ -f "$STAGE" ] || fail '暂存文件丢失，请重试'
  printf '%s' "$chunk" >>"$STAGE" || fail '写入暂存文件失败'
  size=$(wc -c <"$STAGE" | tr -d ' ')
  [ "$size" -le $((MAX_IMPORT * 2)) ] || { rm -f "$STAGE"; fail '配置超过 4 MB'; }
  printf '{"ok":true,"size":%s}\n' "$size"
}

b64_file() {
  base64 -w 0 "$1" 2>/dev/null || base64 "$1" | tr -d '\n'
}

read_config() {
  [ -s "$CONFIG" ] || { echo '配置文件不存在' >&2; exit 1; }
  b64_file "$CONFIG"
}

import_read() {
  [ -s "$IMPORT" ] || { echo '没有下载内容' >&2; exit 1; }
  b64_file "$IMPORT"; status=$?
  rm -f "$IMPORT"
  exit $status
}

validate() {
  [ -x "$BIN" ] || { echo '内核未安装' >&2; exit 1; }
  ensure_dirs || exit 1
  tmp=$(mktemp "$RUN_DIR/validate.XXXXXX") || exit 1
  trap 'rm -f "$tmp"' EXIT
  if [ "$1" = --staged ]; then
    [ -s "$STAGE" ] || { echo '暂存文件丢失，请重试' >&2; exit 1; }
    base64 -d <"$STAGE" >"$tmp"; status=$?
    rm -f "$STAGE"
  else
    case "$1" in ''|*[!a-zA-Z0-9+/=]*) echo '配置不是 base64' >&2; exit 1 ;; esac
    printf '%s' "$1" | base64 -d >"$tmp"; status=$?
  fi
  [ "$status" = 0 ] || { echo '配置 base64 解码失败' >&2; exit 1; }
  "$BIN" -d "$DATA" -f "$tmp" -t
}

logs() {
  case "$1" in ''|*[!0-9]*) fail '行数无效' ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 10000 ] || fail '行数须为 1–10000'
  tail -n "$1" "$LOG_FILE" 2>/dev/null
  logcat -d -s 'mihomo:*' 2>/dev/null | tail -n 50
  exit 0
}

# 诊断信息：设备、root 管理器、模块、内核、网络与最近日志。脱敏在网页端统一处理。
diag() {
  section() { printf '\n== %s ==\n' "$1"; }
  prop() { getprop "$1" 2>/dev/null; }
  section 设备
  printf '型号: %s %s (%s)\n' "$(prop ro.product.brand)" "$(prop ro.product.model)" "$(prop ro.product.device)"
  printf 'Android: %s (SDK %s)  ROM: %s\n' "$(prop ro.build.version.release)" "$(prop ro.build.version.sdk)" "$(prop ro.build.display.id)"
  printf 'ABI: %s  Linux: %s\n' "$(prop ro.product.cpu.abi)" "$(uname -r 2>/dev/null)"
  printf 'SELinux: %s\n' "$(getenforce 2>/dev/null)"
  section Root
  if [ -x /data/adb/ksud ]; then printf 'KernelSU: %s\n' "$(/data/adb/ksud -V 2>/dev/null | head -n 1)"; fi
  if [ -x /data/adb/apd ]; then printf 'APatch: %s\n' "$(/data/adb/apd -V 2>/dev/null | head -n 1)"; fi
  if command -v magisk >/dev/null 2>&1; then printf 'Magisk: %s (%s)\n' "$(magisk -v 2>/dev/null)" "$(magisk -V 2>/dev/null)"; fi
  section 模块
  grep -E '^(version|versionCode)=' "$MODDIR/module.prop" 2>/dev/null
  [ -e "$MODDIR/disable" ] && echo '模块已在管理器中禁用'
  grep -vE '^(wifi_ssids|bypass_packages)(_b64)?=' "$SETTINGS" 2>/dev/null | head -n 60
  section 内核
  if [ -x "$BIN" ]; then "$BIN" -v 2>/dev/null | head -n 2; else echo '未安装'; fi
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      printf '运行中 PID %s，内存 %s\n' "$pid" "$(grep -E '^VmRSS' "/proc/$pid/status" 2>/dev/null | tr -s ' \t' ' ')"
    else
      echo '未运行（PID 文件残留）'
    fi
  else
    echo '未运行'
  fi
  section 网络
  ip -o addr show 2>/dev/null | awk '{print $2, $3, $4}' | head -n 40
  echo '-- ip rule'
  ip rule show 2>/dev/null | head -n 40
  echo '-- 默认路由'
  ip route show table all 2>/dev/null | grep -E '^default' | head -n 10
  section 最近日志
  tail -n "$1" "$LOG_FILE" 2>/dev/null
  logcat -d -s 'mihomo:*' 2>/dev/null | tail -n 30
  exit 0
}

# 策略组图标：浏览器因跨域读不到时由这里下载，输出单行 base64（最多 256 KB）
icon() {
  url=$1
  case "$url" in http://*|https://*) ;; *) echo '只支持 http(s) 链接' >&2; exit 2 ;; esac
  case "$url" in *"$NL"*|*"$(printf '\r')"*) echo '链接不能含换行' >&2; exit 2 ;; esac
  [ "${#url}" -le 2048 ] || { echo '链接过长' >&2; exit 2; }
  command -v curl >/dev/null 2>&1 || { echo '缺少 curl' >&2; exit 127; }
  ensure_dirs || exit 1
  tmp=$(mktemp "$RUN_DIR/icon.XXXXXX") || exit 1
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --disable --globoff -m 10 --max-filesize 262144 -o "$tmp" -- "$url" || exit 1
  [ -s "$tmp" ] || { echo '图标为空' >&2; exit 1; }
  b64_file "$tmp"
}

controller_lines() {
  grep -E '^(external-controller|secret|external-ui):' "$CONFIG" 2>/dev/null
}

api() {
  method=$1 url=$2
  case "$method" in GET|PUT|POST|PATCH|DELETE) ;; *) echo '请求方法无效' >&2; exit 2 ;; esac
  case "$url" in http://127.0.0.1:[0-9]*|http://localhost:[0-9]*|'http://[::1]:'[0-9]*) ;; *) echo '控制器地址必须是本机' >&2; exit 2 ;; esac
  case "$url" in *"$NL"*|*"$(printf '\r')"*) echo '地址不能含换行' >&2; exit 2 ;; esac
  if [ -x /system/bin/curl ]; then curl_bin=/system/bin/curl; else curl_bin=$(command -v curl 2>/dev/null); fi
  if [ -z "$curl_bin" ] || [ ! -x "$curl_bin" ]; then
    echo '未找到可执行的 curl：/system/bin/curl 不可用，PATH 中也未找到；请安装 curl 模块' >&2
    exit 127
  fi
  if [ "$#" -ge 3 ]; then
    body=$3
    set -- --header 'Content-Type: application/json' --data-binary "$body"
  else
    set --
  fi
  timeout=${MIHOMO_API_TIMEOUT:-8}
  case "$timeout" in ''|*[!0-9]*) timeout=8 ;; esac
  [ "$timeout" -ge 1 ] && [ "$timeout" -le 90 ] || timeout=8
  exec "$curl_bin" --disable --silent --show-error --globoff --noproxy '*' --connect-timeout 3 --max-time "$timeout" \
    --request "$method" --header "Authorization: Bearer ${MIHOMO_SECRET:-}" \
    --write-out '\n__MIHOMO_HTTP__:%{http_code}' --url "$url" "$@"
}

case "${1:-}" in
  read-config) read_config ;;
  import-read) import_read ;;
  validate) [ "$#" -eq 2 ] || fail '参数无效'; validate "$2" ;;
  logs) logs "${2:-200}" ;;
  diag) diag 150 ;;
  controller) controller_lines ;;
  icon) [ "$#" -eq 2 ] || { echo '参数无效' >&2; exit 2; }; icon "$2" ;;
  api) [ "$#" -eq 3 ] || [ "$#" -eq 4 ] || { echo '参数无效' >&2; exit 2; }; shift; api "$@" ;;
  probe) probe ;;
  # 连通性检测与出口 IP 在 mihomo-webd 里（webd/netcheck.go）
  netcheck|exitip) exec "$MODDIR/bin/mihomo-webd" net -data "$DATA" "$1" ;;
  fetch) [ "$#" -ge 2 ] || fail '缺少链接'; fetch "$2" "${3:-}" ;;
  stage) [ "$#" -eq 3 ] || fail '参数无效'; stage "$2" "$3" ;;
  *) fail '用法: host.sh probe|netcheck|exitip|fetch|stage|read-config|import-read|validate|logs|diag|controller|icon|api' ;;
esac
