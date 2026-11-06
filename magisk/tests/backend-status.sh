#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/scripts" "$TEST_DIR/data/run" "$TEST_DIR/bin"
for script in common.sh policy-lib.sh mihomo.sh policy.sh; do
  tr -d '\r' <"$ROOT/scripts/$script" >"$TEST_DIR/scripts/$script"
done
export MODDIR=$TEST_DIR
export SCRIPTS=$TEST_DIR/scripts
export MIHOMO_DATA=$TEST_DIR/data
export TEST_DIR
export PATH=$TEST_DIR/bin:$PATH
printf 'wifi_mode=off\n' >"$MIHOMO_DATA/settings.ini"
printf 'description=original\n' >"$MODDIR/module.prop"
cat >"$TEST_DIR/bin/cmd" <<'EOF'
#!/bin/sh
touch "$TEST_DIR/wifi-probed"
exit 1
EOF
cp "$TEST_DIR/bin/cmd" "$TEST_DIR/bin/dumpsys"
chmod +x "$TEST_DIR/bin/cmd" "$TEST_DIR/bin/dumpsys"
exec 9>"$MIHOMO_DATA/run/backend.lock"
flock -n 9
for script in 'mihomo.sh status' 'policy.sh get'; do
  set -- $script
  timeout 2 sh "$SCRIPTS/$1" "$2" >"$TEST_DIR/result"
  grep -q '"ok":true' "$TEST_DIR/result"
  grep -q '"allowed":true' "$TEST_DIR/result"
done
test ! -e "$TEST_DIR/wifi-probed"
test "$(cat "$MODDIR/module.prop")" = 'description=original'
printf 'wifi_mode=only\nwifi_ssids_b64=VGVzdA==\n' >"$MIHOMO_DATA/settings.ini"
for script in 'mihomo.sh status' 'policy.sh get'; do
  set -- $script
  timeout 2 sh "$SCRIPTS/$1" "$2" >"$TEST_DIR/result"
  grep -q '"allowed":null' "$TEST_DIR/result"
done
printf 'only\nVGVzdA==\ntrue\n+VGVzdA==\n' >"$MIHOMO_DATA/run/policy-status"
for script in 'mihomo.sh status' 'policy.sh get'; do
  set -- $script
  timeout 2 sh "$SCRIPTS/$1" "$2" >"$TEST_DIR/result"
  grep -q '"allowed":true' "$TEST_DIR/result"
  grep -q '"current_ssid":"Test"' "$TEST_DIR/result"
done
test ! -e "$TEST_DIR/wifi-probed"
echo 'PASS: status reads bypass the held write lock and do not probe Wi-Fi or write module state'
