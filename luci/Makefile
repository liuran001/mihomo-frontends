# 在 OpenWrt 源码树或 SDK 中构建（需要已安装 luci feed）：
#   把本目录放到 package/ 或 feeds/luci/applications/ 下，然后 make package/luci-app-mihomo-ebpf/compile
# 不用 SDK 时可运行 scripts/build-apk.sh（apk mkpkg 直接打包，版本号与依赖都从这里读取）
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mihomo-ebpf
PKG_VERSION:=1.0.0
PKG_RELEASE:=26110701

LUCI_TITLE:=LuCI support for mihomo (liuran001 eBPF fork)
LUCI_DESCRIPTION:=状态、代理、连接、订阅、规则、设置、配置文件、日志、内核管理与首次向导
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-socket +yq +curl +ca-bundle +ip-full
LUCI_PKGARCH:=all

define Package/luci-app-mihomo-ebpf/conffiles
/etc/config/mihomo
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
