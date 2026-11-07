#!/bin/sh
# 后端测试入口（在路由器上运行）：sh /tmp/mlt/backend/main.sh [test_xxx.uc ...]
# 本机运行时由 tests/local/main.sh 设置 MLT_HOME、UCODE、UCODE_ARGS 与各 MIHOMO_LUCI_* 路径
T=/tmp/mlt
B=$T/backend
# HOME 与正式环境一样放在 ext4 上（/etc/mihomo 所在的文件系统），RUN 在 tmpfs 上：两者不同文件系统，能测出跨文件系统 rename 的问题
H=${MLT_HOME:-/root/mlt-home}
# UCI 用独立目录，发布地址指向本地目录：测试不会改动 /etc/config，也不访问网络
export MIHOMO_LUCI_HOME=$H MIHOMO_LUCI_RUN=$T/run MIHOMO_LUCI_INIT=$B/fake-init.sh \
	MIHOMO_LUCI_SERVICE=mihomo-luci-test MIHOMO_LUCI_START_TIMEOUT=8 \
	MIHOMO_LUCI_UCI_DIR=$T/uci MIHOMO_LUCI_RELEASE_BASE=file://$T/release/ \
	MIHOMO_LUCI_SUBSTORE_DIR=$H/substore MIHOMO_LUCI_NODE=$T/no-node MIHOMO_LUCI_SUBSTORE_INIT=$T/no-substore-init \
	MIHOMO_LUCI_SUBSTORE_INSTALLER=$T/no-substore-install \
	MIHOMO_LUCI_VERSION_FILE=$T/run/plugin-version MIHOMO_LUCI_APK=$T/release/apk MIHOMO_LUCI_OPKG=$T/no-opkg \
	MIHOMO_LUCI_PLUGIN_MANIFEST=file://$T/release/update.json MIHOMO_LUCI_PLUGIN_BASE=file://$T/release/ \
	MIHOMO_LUCI_PLUGIN_INSTALL=$T/release/fake-install MIHOMO_LUCI_PLUGIN_UPGRADER=$T/no-plugin-upgrade
chmod 755 $B/fake-init.sh $B/fake-mihomo.sh
tests="$*"
[ -n "$tests" ] || tests=$(cd $B && ls test_*.uc)
fail=0
for t in $tests; do
	$B/fake-init.sh stop
	rm -rf $H $T/run $T/uci $T/release $T/core-bin $T/www
	mkdir -p $H $T/run $T/uci
	cp $T/fixtures/run.yaml $H/config.yaml
	chmod 600 $H/config.yaml
	# 内核管理测试会替换内核：把 BIN 指到测试目录，用假内核
	case $t in
		test_core.uc) bin="MIHOMO_LUCI_BIN=$T/core-bin/mihomo-ebpf" ;;
		*) bin= ;;
	esac
	# 模板含 GEOSITE/GEOIP 规则，mihomo -t 需要数据文件：用符号链接借用正式目录（本机为 MLT_GEO）里的，避免下载与写闪存
	if [ $t = test_setup.uc ]; then
		for f in "${MLT_GEO:-/etc/mihomo}"/*; do
			case $(basename "$f" | tr A-Z a-z) in
				geosite.dat|geoip.dat|geoip.metadb|country.mmdb) ln -s "$f" $H/ ;;
			esac
		done
	fi
	echo "### $t"
	env $bin ${UCODE:-ucode} $UCODE_ARGS -L $B $B/$t || fail=1
	[ -z "$bin" ] || env $bin $B/fake-init.sh stop
done
$B/fake-init.sh stop
rm -rf $H $T/uci $T/release $T/core-bin $T/www
if [ $fail = 0 ]; then echo "ALL PASSED"; else echo "SOME FAILED"; exit 1; fi
