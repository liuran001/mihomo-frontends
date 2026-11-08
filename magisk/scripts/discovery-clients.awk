# 共享出去的设备：ip neigh show 的邻居表，按 MAC 合并 IPv4/IPv6，补上 DHCP 租约里的主机名。
# 输入依次为：scope=wanted（候选网卡名，一行一个）、scope=upstream（默认出口网卡）、
# scope=leases（dnsmasq 租约：到期 MAC IP 主机名 …，可能为空）、scope=neigh（ip neigh show）。
function esc(text, out, pos, char) {
    out=""
    for (pos=1; pos<=length(text); pos++) {
        char=substr(text,pos,1)
        if (char=="\\") out=out "\\\\"
        else if (char=="\"") out=out "\\\""
        else if (char ~ /[\001-\037]/) out=out " "
        else out=out char
    }
    return out
}
function tethered(name) {
    if (name in upstream) return 0
    if (name in wanted) return 1
    return name ~ /^(ap[0-9]|ap_br_|softap|swlan|wlan[1-9]|rndis|usb|ncm|bt-pan|bnep)/
}
scope=="wanted" { if ($1!="") wanted[$1]=1; next }
scope=="upstream" { if ($1!="") upstream[$1]=1; next }
scope=="leases" { if (NF>=4 && $4!="*") hostname[tolower($2)]=$4; next }
scope=="neigh" {
    dev=""; mac=""
    for (pos=2; pos<NF; pos++) {
        if ($pos=="dev") dev=$(pos+1)
        if ($pos=="lladdr") mac=tolower($(pos+1))
    }
    state=$NF
    if (dev=="" || mac=="" || state=="FAILED" || state=="INCOMPLETE" || state=="NOARP" || state=="PERMANENT") next
    if (mac !~ /^([0-9a-f][0-9a-f]:){5}[0-9a-f][0-9a-f]$/ || mac=="00:00:00:00:00:00") next
    if (!tethered(dev)) next
    if (!(mac in iface)) { order[++count]=mac; iface[mac]=dev; best[mac]=state }
    if (state=="REACHABLE") best[mac]=state
    if ($1 ~ /:/) {
        if ($1 !~ /^fe80:/ && index(" " ipv6[mac] " ", " " $1 " ")==0) ipv6[mac]=(ipv6[mac]=="" ? $1 : ipv6[mac] " " $1)
    } else if (ipv4[mac]=="") ipv4[mac]=$1
    next
}
END {
    printf "["
    for (number=1; number<=count; number++) {
        mac=order[number]
        printf "%s{\"mac\":\"%s\",\"iface\":\"%s\",\"ipv4\":\"%s\",\"ipv6\":[", (number>1?",":""), mac, esc(iface[mac]), esc(ipv4[mac])
        total=split(ipv6[mac], list, " ")
        for (item=1; item<=total; item++) printf "%s\"%s\"", (item>1?",":""), esc(list[item])
        printf "],\"name\":\"%s\",\"state\":\"%s\"}", esc(hostname[mac]), esc(best[mac])
    }
    printf "]"
}
