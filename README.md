# mihomo eBPF

把 [mihomo](https://github.com/liuran001/mihomo)（smart + eBPF 版）装到手机和路由器上，用网页就能管理。透明代理走 eBPF，不用 TUN，也不用 iptables。

- **Android**：Magisk / KernelSU / APatch 模块
- **OpenWrt**：LuCI 插件 `luci-app-mihomo-ebpf`

安装包在 [Releases](https://github.com/liuran001/mihomo-frontends/releases/latest) 里下载。

## 一键安装 / 更新

OpenWrt（SSH 登录后）：

```sh
curl -fsSL https://github.com/liuran001/mihomo-frontends/releases/latest/download/install.sh | sh
```

Android（Termux 里，需要 root）：

```sh
curl -fsSL https://github.com/liuran001/mihomo-frontends/releases/latest/download/install.sh | su -c sh
```

脚本会自动判断设备，装好或更新到最新版；已是最新时什么也不做。国内网络连不上 GitHub 时，换成走镜像：

```sh
curl -fsSL https://ghfast.top/https://github.com/liuran001/mihomo-frontends/releases/latest/download/install.sh | MIRROR=https://ghfast.top/ sh
```

## Android 模块

1. 在 Magisk / KernelSU / APatch 里刷入 `mihomo-ebpf-magisk-*.zip`。
2. 在模块列表里打开模块的 WebUI，按向导下载内核、填订阅，就能用了。

能做的事：

- 切换节点、测速、看连接和日志
- 改订阅、DNS、分流等常用设置，保存前会先检查，出错会自动还原
- 指定某些应用不走代理，按 Wi-Fi 自动开关代理
- 让热点、USB 共享出去的设备也走代理
- 在电脑浏览器里管理手机（可设密码，也支持 Tailscale）
- 模块和内核都能在网页里一键更新，模块更新完立即生效，不用重启手机

要求：arm64、armv7 或 x86_64 设备，Android 11 以上，内核支持 eBPF（大多数 GKI 设备都可以）；需要较新的 Android System WebView。

## OpenWrt 插件

支持 OpenWrt 24.10 及以后（23.05 及更早不支持）。推荐用上面的一键脚本，也可以手动安装：

```sh
apk add --allow-untrusted luci-app-mihomo-ebpf-*.apk    # 25.12 及以后
opkg update && opkg install luci-app-mihomo-ebpf_*_all.ipk    # 24.10
```

装好后在 LuCI 的「服务 › Mihomo」里按向导完成设置。内核和插件都能在「内核」页一键更新。

## 常见问题

- **下载很慢或失败**：在「内核」页设置下载镜像（默认 `https://ghfast.top/`），也可以先开代理再更新。
- **改坏了配置**：在「配置文件」页里有自动备份，可以一键恢复。

## 开发

构建与测试说明见 [`luci/README.md`](luci/README.md) 和 `magisk/tests/`，打包脚本在 `magisk/build.sh`、`luci/scripts/`。

## 许可

本仓库代码使用 [MIT](LICENSE) 许可。随包分发的第三方组件各自的许可见模块里的 `THIRD-PARTY-LICENSES.txt`。
