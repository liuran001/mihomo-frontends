#!/bin/sh
# host.sh 新增子命令（网页管理只能调用脚本子命令）与 webui.sh 的设置流程。
set -eu

ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/module/scripts" "$TEST_DIR/module/bin" "$TEST_DIR/bin" "$TEST_DIR/data/run"
for script in "$ROOT"/scripts/*.sh "$ROOT"/scripts/policy-*.awk; do
  tr -d '\r' <"$script" >"$TEST_DIR/module/scripts/${script##*/}"
done
export MODDIR=$TEST_DIR/module
export SCRIPTS=$MODDIR/scripts
export MIHOMO_DATA=$TEST_DIR/data
export TEST_DIR
export PATH=$TEST_DIR/bin:$PATH
export ASH_STANDALONE=0
DATA=$MIHOMO_DATA
passed=0

check() {
  if "$@"; then passed=$((passed+1)); else echo "FAIL: $*" >&2; exit 1; fi
}
contains() { grep -Fq -- "$2" "$1"; }
b64() { printf '%s' "$1" | base64 | tr -d '\r\n'; }
host() { sh "$SCRIPTS/host.sh" "$@" >"$TEST_DIR/out" 2>"$TEST_DIR/err"; }

printf 'mixed-port: 7890\nexternal-controller: 127.0.0.1:9090\nsecret: "s"\n' >"$DATA/config.yaml"

# read-config：单行 base64，内容可还原
host read-config
check test "$(base64 -d <"$TEST_DIR/out")" = "$(cat "$DATA/config.yaml")"
check test "$(wc -l <"$TEST_DIR/out" | tr -d ' ')" = 0

# controller：原样输出两行
host controller
check test "$(cat "$TEST_DIR/out")" = 'external-controller: 127.0.0.1:9090
secret: "s"'

# validate：内核以 -d DATA -f 临时文件 -t 运行，临时文件随后删除
cat >"$DATA/mihomo" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"$TEST_DIR/mihomo-args"
cp "$4" "$TEST_DIR/validated"
grep -q bad "$4" && { echo 'parse error' >&2; exit 1; }
echo 'test is successful'
EOF
chmod +x "$DATA/mihomo"
host validate "$(b64 'port: 1')"
check contains "$TEST_DIR/out" 'test is successful'
check test "$(cat "$TEST_DIR/validated")" = 'port: 1'
check test "$(sed -n 1p "$TEST_DIR/mihomo-args")" = -d
check test "$(sed -n 5p "$TEST_DIR/mihomo-args")" = -t
check test -z "$(ls "$DATA/run" | grep validate || true)"
if host validate "$(b64 'bad: 1')"; then check false; fi
check contains "$TEST_DIR/err" 'parse error'
if host validate 'not base64!'; then check false; fi
# --staged：读取暂存文件后删除
sh "$SCRIPTS/host.sh" stage 0 "$(b64 'staged: 1')" >/dev/null
host validate --staged
check test "$(cat "$TEST_DIR/validated")" = 'staged: 1'
check test ! -e "$DATA/run/stage.b64"

# logs：行数受限
printf 'l1\nl2\nl3\n' >"$DATA/run/mihomo.log"
host logs 2
check test "$(head -n 2 "$TEST_DIR/out")" = 'l2
l3'
if host logs 0; then check false; fi
if host logs '2;id'; then check false; fi

# import-read：读后删除
printf 'proxies: []\n' >"$DATA/run/import.yaml"
host import-read
check test "$(base64 -d <"$TEST_DIR/out")" = 'proxies: []'
check test ! -e "$DATA/run/import.yaml"
if host import-read; then check false; fi

# api：只请求本机，密钥来自环境变量，body 作为 JSON 发送
cat >"$TEST_DIR/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"$TEST_DIR/curl-args"
EOF
chmod +x "$TEST_DIR/bin/curl"
MIHOMO_SECRET="a'b" host api PUT 'http://127.0.0.1:9090/proxies/x' '{"name":"y"}'
check contains "$TEST_DIR/curl-args" "Authorization: Bearer a'b"
check contains "$TEST_DIR/curl-args" '--data-binary'
check contains "$TEST_DIR/curl-args" '{"name":"y"}'
check contains "$TEST_DIR/curl-args" 'http://127.0.0.1:9090/proxies/x'
host api GET 'http://127.0.0.1:9090/version'
check test -z "$(grep -F -- '--data-binary' "$TEST_DIR/curl-args" || true)"
if host api GET 'http://evil.example/version'; then check false; fi
if host api POST2 'http://127.0.0.1:9090/version'; then check false; fi

# icon：只下载 http(s)，输出 base64
cat >"$TEST_DIR/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"$TEST_DIR/curl-args"
while [ "$#" -gt 0 ]; do [ "$1" = -o ] && { printf 'PNGDATA' >"$2"; break; }; shift; done
EOF
chmod +x "$TEST_DIR/bin/curl"
host icon 'https://cdn.example/a.png'
check test "$(base64 -d <"$TEST_DIR/out")" = PNGDATA
check contains "$TEST_DIR/curl-args" '--max-filesize'
check test -z "$(ls "$DATA/run" | grep icon || true)"
if host icon 'file:///etc/passwd'; then check false; fi
if host icon; then check false; fi

# webui.sh：设置与密码经 mihomo-webd 子命令保存；未启用时不启动服务
cat >"$MODDIR/bin/mihomo-webd" <<'EOF'
#!/bin/sh
cmd=$1; shift
printf '%s ' "$cmd" "$@" >>"$TEST_DIR/webd-calls"; echo >>"$TEST_DIR/webd-calls"
case "$cmd" in
  get) printf '{"ok":true,"enabled":false,"port":9099,"addrs":[]}\n' ;;
  set|passwd) printf '{"ok":true}\n' ;;
  enabled) exit 1 ;;
esac
EOF
chmod +x "$MODDIR/bin/mihomo-webd"
sh "$SCRIPTS/webui.sh" status >"$TEST_DIR/out"
check contains "$TEST_DIR/out" '"installed":true,"running":false,"settings":{"ok":true,"enabled":false'
sh "$SCRIPTS/webui.sh" set "$(b64 '{"enabled":false}')" >"$TEST_DIR/out"
check contains "$TEST_DIR/webd-calls" "set -c $DATA/webui.json"
check contains "$TEST_DIR/out" '"running":false'
sh "$SCRIPTS/webui.sh" passwd "$(b64 'secret-pass')" >"$TEST_DIR/out"
check contains "$TEST_DIR/webd-calls" "passwd -c $DATA/webui.json"
if sh "$SCRIPTS/webui.sh" set >/dev/null; then check false; fi
rm "$MODDIR/bin/mihomo-webd"
sh "$SCRIPTS/webui.sh" status >"$TEST_DIR/out"
check contains "$TEST_DIR/out" '"installed":false'

echo "host-webui: $passed checks passed"
