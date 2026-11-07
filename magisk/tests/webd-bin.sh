# 脚本测试用的 mihomo-webd：优先 $MIHOMO_WEBD_BIN（CI 或交叉编译好的 Linux 程序），否则用 go 现场构建。
# 用法：. tests/webd-bin.sh; install_webd 模块目录（需要先设置 ROOT 为 magisk 目录）
install_webd() {
  mkdir -p "$1/bin"
  if [ -n "${MIHOMO_WEBD_BIN:-}" ]; then
    cp "$MIHOMO_WEBD_BIN" "$1/bin/mihomo-webd"
  elif command -v go >/dev/null 2>&1; then
    (cd "$ROOT/webd" && CGO_ENABLED=0 go build -o "$1/bin/mihomo-webd" .) || exit 1
  else
    echo '缺少 mihomo-webd：设置 MIHOMO_WEBD_BIN 或安装 go' >&2
    exit 1
  fi
  chmod 755 "$1/bin/mihomo-webd"
}
