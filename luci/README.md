# luci-app-mihomo-ebpf

为 liuran001/mihomo（smart + eBPF 分支）编写的轻量 LuCI 应用。设计见 `docs/superpowers/specs/`，四批实现计划与验证记录见 `docs/superpowers/plans/`，验收说明见 `验收说明.md`。

页面（LuCI → 服务 → Mihomo）：概览、代理、连接、订阅、规则、设置、配置文件、内核、设置向导、日志。所有写入都先经 `mihomo-ebpf -t` 校验，备份后替换并重启，启动失败时自动回滚。

开箱即用：装好软件包后打开「设置向导」，三步完成——下载适配本机架构的内核（校验 sha256）→ 用内置模板填订阅生成配置，或从链接下载、导入已有配置（可自动补全 eBPF 入站、DNS、控制器与 zashboard）→ 启动并设为开机自启。之后在「内核」页检查更新、更新或回滚内核。

Tailscale：「设置 → Tailscale」可以添加内核内置的 tailscale 出站（auth key 可留空），自动加入 Tailnet 网段规则并让 eBPF 不把它们当作私网放行；
「网页登录」优先使用内核 `/tailscale/NAME/login`，仅旧内核返回 404 时才订阅日志、测速唤醒 tsnet；登录弹窗隐藏时暂停状态轮询，关闭后停止订阅。账号代表设备注册属主，运行中实时身份缺失或需要登录时不回退到旧账号；未启动才显示磁盘当前资料。「退出登录」停止服务、删除状态目录再启动。

## 资源开销

概览仅请求 `/connections/summary`、`/overview`、`/ebpf/summary`，不再每两秒拉取全部连接或定期展开所有节点与 BPF map。流量摘要每两秒读取，订阅/出口/eBPF 维护摘要每 30 秒读取；Map 占用仅按「详细诊断」时扫描，订阅卡片显示节点总数，不为计算可用数量扫描全部节点。旧内核缺摘要接口时提示升级，不自动回退到高开销查询。

轮询同一任务不重叠；隐藏标签页暂停，切出页面停止并清除监听器。连接与日志 WebSocket 隐藏时断开、恢复可见时重连；系统日志页不保留实时日志订阅。HTTP 超时覆盖响应体读取。规则、代理、订阅页只在可见时刷新它们实际需要的完整数据，不在后台无限刷新。

这些检查和前端单元测试验证的是请求数量与生命周期；没有在实体路由器上测量功率、CPU 或内存峰值。

## 安装

```sh
sh scripts/build-apk.sh                                  # Linux/WSL 里运行，输出 dist/luci-app-mihomo-ebpf-<版本>.apk
scp dist/luci-app-mihomo-ebpf-*.apk root@192.168.77.1:/tmp/
ssh root@192.168.77.1 'apk add --allow-untrusted /tmp/luci-app-mihomo-ebpf-*.apk'
```

包未签名，所以要 `--allow-untrusted`。依赖（`yq`、`curl`、`ca-bundle`、`ip-full`、ucode 模块）由 apk 从软件源安装。
安装与升级脚本只清理 LuCI 缓存并让 rpcd 重新加载插件（`killall -HUP rpcd`，已登录的 LuCI 不受影响），不启动也不停止服务；卸载前停止并禁用服务，`/etc/mihomo` 与内核保留。

**从 `deploy.sh` 部署过的路由器第一次装软件包时**：apk 不覆盖 `/etc` 下已有且不属于任何包的文件，新的 init 脚本会写成 `/etc/init.d/mihomo.apk-new`。确认后 `mv /etc/init.d/mihomo.apk-new /etc/init.d/mihomo` 即可（替换脚本不影响正在运行的服务）；之后的升级不再有这个问题。

打包不依赖 OpenWrt SDK，需要 apk-tools 3：没有时先运行 `sh scripts/setup-apk-tools.sh`（在 WSL 里编译到 `~/.cache/mh-tools`）。
`Makefile` 按 OpenWrt SDK 的 `luci.mk` 写成，版本号也从这里读取；还没有在 SDK 里实际构建过。

## 测试

```sh
node tests/frontend/run.js                       # 前端单元测试与语法检查（电脑上）
sh tests/run-local.sh [test_xxx.uc ...]          # 后端测试，在 WSL（archlinux）里运行，不需要路由器
sh tests/package/install-test.sh dist/xxx.apk    # 软件包安装测试（WSL），在临时根目录里安装、检查、卸载
./tests/run-backend.sh                           # 后端测试，同步到路由器 /tmp/mlt 执行（需先部署）
ssh root@192.168.77.1 'sh -s' < tests/backend/rpc-smoke.sh   # rpcd 插件冒烟测试（路由器上，只读或在校验阶段就被拒绝的调用）
```

`run-local.sh` 首次运行会在 WSL 的 `~/.cache/mh-tools` 编译 ucode、yq 与 mihomo（`MH_SKIP_SETUP=1` 跳过检查）；测试会清掉从 Windows 继承的 `http_proxy` 等变量，与路由器上的 rpcd 环境一致。
路由器上的后端测试另起一个 mihomo 实例（控制器 127.0.0.1:19090，mixed-port 17890），不影响正在运行的服务；
测试目录放在 `/root/mlt-home`（与 `/etc/mihomo` 同在 ext4 分区上），这样跨文件系统的问题能在测试中暴露。

## 开发部署

```sh
./deploy.sh root@192.168.77.1
```

直接复制 `root/` 下的文件，不经过软件包，只用于开发调试；装过软件包的路由器不要再用它（文件会与 apk 数据库不一致）。
脚本按需安装 `yq` 等依赖，清理 LuCI 缓存；后端文件有变化时重启 rpcd（已登录的 LuCI 会话需要重新登录）。可用环境变量 `SSH` 指定 ssh 命令。

## 本地预览

```sh
SSH=ssh ROUTER=root@192.168.77.1 node tests/preview/server.js            # 只读，http://localhost:8377/
PORT=8378 MIHOMO_PREVIEW_WRITE=1 node tests/preview/server.js           # 放行写方法
```

预览服务只监听 127.0.0.1，在电脑上用路由器的 LuCI 前端运行时渲染本插件页面，不需要在浏览器里登录 LuCI：
本插件的前端文件直接读仓库（改完刷新即可），其他 `/luci-static` 文件转发到路由器；rpc 经一条常驻 ssh 连接转发到路由器上的 ubus，
只放行 ACL 中 `luci.mihomo` 的方法，写方法默认只放行「校验」。页面顶部的「切换深浅色」切换 aurora 主题的深色模式。

路由器不在线时可以用离线样例：

```sh
sh tests/preview/snapshot.sh                                           # WSL 里运行一次：真实插件读脱敏样例 tests/fixtures/full.yaml，写 tests/preview/.cache/rpc.json
PORT=8380 MIHOMO_PREVIEW_MOCK=1 node tests/preview/server.js           # http://localhost:8380/，页面地址加 ?fresh=1 模拟全新安装
```

离线模式下 LuCI 前端读 `tests/preview/.cache/www`（从固件包的 `./www/luci-static` 解出），rpc 与控制器（REST 与 WebSocket，127.0.0.1:8379）由 `tests/preview/mock.js` 回答：
配置相关的数据来自快照，状态、设备、节点、连接、日志等是随机样例；写操作一律返回成功，不改任何文件。
