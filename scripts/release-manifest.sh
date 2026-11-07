#!/bin/sh
# 发布时生成 update.json（模块与 LuCI 检查更新用，也是 Magisk/KernelSU 的 updateJson）与 changelog.md。
# 用法：sh scripts/release-manifest.sh <标签> <owner/repo> <产物目录> <输出目录>
set -eu
TAG=$1 REPO=$2 ART=$3 OUT=$4
cd "$(dirname "$0")/.."
command -v python3 >/dev/null 2>&1 || { echo "缺少 python3" >&2; exit 1; }
set -- $(sh scripts/check-version.sh "$TAG")
VERSION=$1 CODE=$2 PKGVER=$3
BASE="https://github.com/$REPO/releases/download/$TAG"

one() {
	n=$(find "$ART" -type f -name "$1" | wc -l)
	[ "$n" -eq 1 ] || { echo "产物 $1 应有且只有一个，实际 $n 个" >&2; exit 1; }
	find "$ART" -type f -name "$1"
}
ZIP=$(one "*-magisk-$VERSION.zip")
APK=$(one "luci-app-mihomo-ebpf-$PKGVER.apk")
IPK=$(one "luci-app-mihomo-ebpf_${PKGVER}_all.ipk")
sha() { sha256sum "$1" | cut -d' ' -f1; }

mkdir -p "$OUT"
# 每个字段一行：模块用 sed 逐行读取
python3 - "$VERSION" "$CODE" "$BASE" "$PKGVER" \
	"$(basename "$ZIP")" "$(sha "$ZIP")" "$(basename "$APK")" "$(sha "$APK")" "$(basename "$IPK")" "$(sha "$IPK")" >"$OUT/update.json" <<'PY'
import json, sys
version, code, base, pkgver, zip_, zipsha, apk, apksha, ipk, ipksha = sys.argv[1:]
print(json.dumps({
    'version': version,
    'versionCode': int(code),
    'zipUrl': base + '/' + zip_,
    'changelog': base + '/changelog.md',
    'zipSha256': zipsha,
    'luci': {
        'version': pkgver,
        'apk': {'name': apk, 'url': base + '/' + apk, 'sha256': apksha},
        'ipk': {'name': ipk, 'url': base + '/' + ipk, 'sha256': ipksha},
    },
}, indent=2, ensure_ascii=False))
PY

# 更新说明：上一个版本标签以来的提交标题；没有上一个标签时只列最近的提交
prev=$(git describe --tags --abbrev=0 --match 'V*' "$TAG^" 2>/dev/null || true)
{
	echo "## $VERSION"
	echo
	if [ -n "$prev" ]; then
		git log --no-merges --pretty='- %s' "$prev..$TAG"
	else
		echo '首个正式版本。最近的改动：'
		echo
		git log --no-merges --pretty='- %s' -n 30 "$TAG"
	fi
	echo
	echo '### 安装'
	echo
	echo "- Magisk / KernelSU / APatch：刷入 \`$(basename "$ZIP")\`；已安装时可在模块网页「设置 › 模块更新」一键升级"
	echo "- 一键安装 / 更新（OpenWrt）：\`wget -qO- https://github.com/$REPO/releases/latest/download/install.sh | sh\`；Android 在 Termux 里：\`curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | su -c sh\`"
	echo "- OpenWrt 25.12 及以后（apk）：\`apk add --allow-untrusted $(basename "$APK")\`"
	echo "- OpenWrt 24.10（opkg）：\`opkg install $(basename "$IPK")\`；23.05 及更早不支持"
	echo '- 已安装的 LuCI 插件可在「内核」页一键升级'
} >"$OUT/changelog.md"
