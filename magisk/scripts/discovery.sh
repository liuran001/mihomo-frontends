#!/system/bin/sh
. "${0%/*}/common.sh"
. "$SCRIPTS/policy-lib.sh"

discovery_cleanup() {
  [ -n "${discovery_tmp:-}" ] || return 0
  rm -f "$discovery_tmp"/*
  rmdir "$discovery_tmp" 2>/dev/null
}

discovery_fail() {
  json_error "$1"
  exit 1
}

package_query() {
  package_provider=$1
  package_scope=$2
  package_output=$3
  for package_uids in yes no; do
    if [ "$package_provider" = pm ]; then set -- pm list packages; else set -- cmd package list packages; fi
    [ "$package_scope" != system ] || set -- "$@" -s
    [ "$package_uids" != yes ] || set -- "$@" -U
    touch "$discovery_tmp/packages.raw" "$discovery_tmp/packages.err" 2>/dev/null && chmod 666 "$discovery_tmp/packages.raw" "$discovery_tmp/packages.err" 2>/dev/null || true
    if tool timeout 12 "$@" >"$discovery_tmp/packages.raw" 2>"$discovery_tmp/packages.err" &&
      tool awk -v mode=normalize -v scope="$package_scope" -f "$SCRIPTS/discovery-apps.awk" \
        "$discovery_tmp/packages.raw" >"$package_output"; then
      return 0
    fi
  done
  return 1
}

discovery_apps() {
  for package_provider in pm cmd; do
    if package_query "$package_provider" all "$discovery_tmp/all" &&
      package_query "$package_provider" system "$discovery_tmp/system"; then
      tool awk -v mode=json -f "$SCRIPTS/discovery-apps.awk" \
        scope=system "$discovery_tmp/system" scope=all "$discovery_tmp/all"
      return $?
    fi
  done
  discovery_fail '无法完整读取 Package Manager 应用及系统应用列表（pm/cmd 不可用、超时或输出不支持）'
}

discovery_interfaces() {
  network_root=${MIHOMO_DISCOVERY_SYS_NET:-/sys/class/net}
  [ -d "$network_root" ] && [ -r "$network_root" ] || discovery_fail '无法读取 /sys/class/net'
  discovery_ssid=$(current_ssid)
  routes_known=1
  for route_family in 4 6; do
    if ! tool timeout 5 ip "-$route_family" route show table all >"$discovery_tmp/route$route_family" 2>/dev/null; then
      routes_known=0
      : >"$discovery_tmp/route$route_family"
    fi
  done
  tool awk -f "$SCRIPTS/discovery-routes.awk" "$discovery_tmp/route4" "$discovery_tmp/route6" >"$discovery_tmp/upstream" || discovery_fail '无法解析上游路由'
  [ -z "$discovery_ssid" ] || printf '%s\n' wlan0 >>"$discovery_tmp/upstream"
  : >"$discovery_tmp/interfaces"
  for interface_path in "$network_root"/*; do
    [ -d "$interface_path" ] || continue
    interface_name=${interface_path##*/}
    case "$interface_name" in ''|*[!a-zA-Z0-9_.-]*) continue ;; esac
    [ "${#interface_name}" -le 15 ] || continue
    case "$interface_name" in
      lo|tun*|tap*|utun*|ip6tnl*|ip6gre*|sit*|ipip*|gre*|gretap*|erspan*|vti*|veth*|ifb*|dummy*|wg*|tailscale*|zt*|clash*|mihomo*|p2p*|aware*|nan*) continue ;;
    esac
    interface_type=$(cat "$interface_path/type" 2>/dev/null)
    case "$interface_type" in ''|1) ;; *) continue ;; esac
    interface_state=$(cat "$interface_path/operstate" 2>/dev/null)
    case "$interface_state" in up|down) ;; *) interface_state=unknown ;; esac
    interface_kind=other
    interface_suggested=0
    case "$interface_name" in
      ap[0-9]*|ap_br_*|softap*|wlan[1-9]*) interface_kind=wifi; interface_suggested=1 ;;
      wlan*|wifi*) interface_kind=wifi ;;
      rndis*|usb*) interface_kind=usb; interface_suggested=1 ;;
      bt-pan*|bnep*) interface_kind=bluetooth; interface_suggested=1 ;;
    esac
    [ "$routes_known" = 1 ] || interface_suggested=0
    printf '%s\t%s\t%s\t%s\n' "$interface_name" "$interface_kind" "$interface_state" "$interface_suggested" >>"$discovery_tmp/interfaces"
  done
  printf '{"ok":true,"interfaces":'
  tool awk -f "$SCRIPTS/discovery-interfaces.awk" scope=upstream "$discovery_tmp/upstream" scope=interfaces "$discovery_tmp/interfaces"
  printf ',"current_ssid":"%s"}\n' "$(json_escape "$discovery_ssid")"
}

# 共享出去的设备（热点、USB、蓝牙）：邻居表 + DHCP 租约主机名，与 VPN 热点应用的做法相同
discovery_clients() {
  policy_load || discovery_fail '策略文件损坏'
  printf '%s\n' "$policy_interfaces" | tr ',' '\n' >"$discovery_tmp/wanted"
  tool timeout 5 ip -4 route show table all >"$discovery_tmp/route4" 2>/dev/null || : >"$discovery_tmp/route4"
  tool timeout 5 ip -6 route show table all >"$discovery_tmp/route6" 2>/dev/null || : >"$discovery_tmp/route6"
  tool awk -f "$SCRIPTS/discovery-routes.awk" "$discovery_tmp/route4" "$discovery_tmp/route6" >"$discovery_tmp/upstream" 2>/dev/null || : >"$discovery_tmp/upstream"
  # 连着 Wi-Fi 时 wlan0 是上游；热点开在 wlan1/ap0 等网卡上
  [ -z "$(current_ssid)" ] || printf '%s\n' wlan0 >>"$discovery_tmp/upstream"
  : >"$discovery_tmp/leases"
  for lease_file in ${MIHOMO_DISCOVERY_LEASES:-/data/misc/dhcp/dnsmasq.leases /data/vendor/dhcp/dnsmasq.leases}; do
    [ -r "$lease_file" ] && cat "$lease_file" >>"$discovery_tmp/leases" 2>/dev/null
  done
  tool timeout 5 ip neigh show >"$discovery_tmp/neigh" 2>/dev/null || discovery_fail '无法读取邻居表（ip neigh）'
  printf '{"ok":true,"tethering":%s,"clients":' "$([ "$policy_tethering" = 1 ] && echo true || echo false)"
  tool awk -f "$SCRIPTS/discovery-clients.awk" scope=wanted "$discovery_tmp/wanted" scope=upstream "$discovery_tmp/upstream" \
    scope=leases "$discovery_tmp/leases" scope=neigh "$discovery_tmp/neigh" || discovery_fail '无法解析邻居表'
  printf '}\n'
}

case "${1:-}" in apps|interfaces|clients) ;; *) discovery_fail '用法: discovery.sh apps|interfaces|clients' ;; esac
mkdir -p "$RUN_DIR" || discovery_fail '无法建立临时目录'
tmp_base=${MIHOMO_DISCOVERY_TMP_DIR:-}
if [ -z "$tmp_base" ] && [ -d /data/local/tmp ] && [ -w /data/local/tmp ]; then tmp_base=/data/local/tmp; fi
tmp_base=${tmp_base:-$RUN_DIR}
discovery_tmp=$(tool mktemp -d "$tmp_base/discovery.XXXXXX") || discovery_fail '无法创建 discovery 临时目录'
chmod 777 "$discovery_tmp" 2>/dev/null || true
trap discovery_cleanup EXIT
trap 'exit 1' HUP INT TERM
case "$1" in
  apps) discovery_apps ;;
  interfaces) discovery_interfaces ;;
  clients) discovery_clients ;;
esac
