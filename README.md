# mihomo-frontends

mihomo（[liuran001/mihomo](https://github.com/liuran001/mihomo)，smart + eBPF 分支）核心 + 各平台前端封装。

```
shared/   平台无关的资源（配置模板等）
magisk/   Magisk / KernelSU 模块封装（KSU WebUI 管理界面）
luci/     OpenWrt LuCI 应用（luci-app-mihomo-ebpf）
```

## Magisk / KernelSU 模块（`magisk/`）

在 KernelSU / Magisk（带 WebUI 的分支）里刷入模块 zip，然后在模块列表点「WebUI」打开管理界面。

- **真实 Compose Miuix**：`magisk/webui` 是独立 Kotlin/Wasm + Compose Multiplatform 工程，使用 `top.yukonga.miuix.kmp:miuix-ui` 组件库，而非 CSS 仿制。发布包的 `webroot/` 完全来自该工程的 production distribution，不再混入旧 `magisk/webroot/`。
- **WebView 与离线字体**：需要支持 **WasmGC 的现代 Android System WebView**，只有传统 WebAssembly 支持并不足够；建议更新 WebView 和模块管理器。不提供旧 HTML 界面回退。界面与常用中文字体子集及 `FONT-LICENSE.txt` 随包分发；动态应用名、节点名中的生僻字或 emoji 超出子集时，Compose 仍可能请求在线备用字体，离线可能显示缺字。内核、订阅等下载仍需网络。
- **数据与模块分离**：内核、配置、备份、运行状态放 `/data/adb/mihomo`，模块目录只放脚本与 WebUI；更新模块不丢数据。
- **内核按需下载**：模块 zip 包含 WebUI 的 wasm、字体等二进制资源，但不含 mihomo 核心。打开 WebUI「内核」页，按设备架构（arm64 / x86_64）从 GitHub release 下载，支持镜像前缀与版本回滚。
- **安装预设**：首次刷入时写入默认设置（开机自启、GitHub 下载镜像 `https://ghfast.top/`、默认共享网卡），并检查内核版本、BTF 与 curl，不满足时在安装日志中提示。已有 `settings.ini` 的键不会被覆盖。
- **首次引导（5 步）**：没有配置时自动进入。① 检测本机（机型、Android/内核版本、eBPF/BTF/cgroup2、IPv6 出口、内存、当前网络）并一键下载内核；② 选择来源：订阅链接（下载后自动识别是完整 Clash/mihomo 配置还是节点订阅）或直接粘贴 YAML；③ 本机优化：列出每一项调整，必要项（eBPF 入站、关闭 TUN、DNS 与 53 端口接管、本机控制器）不可取消，推荐项可逐项取消；④ 运行偏好（自启、共享、立即启动）；⑤ 校验 → 备份并写入 → 保存设置 → 启动，逐步显示结果。可在「设置 → 重新运行向导」再次执行。
- **导入配置并按本机优化**：配置引擎（`webui/bridge/config.js`，基于 `yaml` 库）在 WebView 内解析 YAML，保留注释、锚点与合并键。优化项包括：生成或规范唯一的块格式 eBPF listener（保留原 local/shared 设置，自动选择 ipcidr 中国 IP 规则集做内核直连）；关闭 TUN；移除 `tproxy-port`、`routing-mark`、`interface-name` 等路由器专用字段；控制器改为只监听 `127.0.0.1` 并生成密钥；关闭 `allow-lan`；启用 DNS 并添加 `DST-PORT,53` 接管；无 IPv6 出口时关闭 IPv6；按规则是否使用 `PROCESS-NAME`/`UID` 决定进程查找；为 GEO 规则设置 jsDelivr 下载镜像，低于 6 GB 内存时使用省内存加载；降低日志级别、开启 TCP 并发、记住节点选择与域名嗅探。优化结果再经 `policy-yaml.awk` 渲染校验，可重复执行且结果稳定。
- **内核配置（对齐 LuCI）**：「设置 → 内核配置」按字段编辑 `config.yaml`：基础（运行模式、混合端口、局域网、监听地址、IPv6、日志、进程查找、TCP 并发、统一延迟、嗅探、记住节点、GEO 加载方式）、控制器与面板（地址、密钥、面板目录与下载地址、GeoIP/GeoSite/MMDB 地址、自动更新）、DNS（启用、监听、模式、AAAA、FakeIP 段、引导/默认/代理节点/直连服务器、FakeIP 过滤）、eBPF（协议、UDP 超时、内核直连规则集、FakeIP ICMP、TUN 共存、本机与共享的数据面/DNS/IPv6/私网直连、强制进入的地址段、直连端口、按 MAC/来源地址过滤），以及订阅与规则集的增删改（新订阅沿用已有锚点并加入引用全部订阅的策略组；被规则引用的规则集不能删除）。共享网卡、包名绕过与本机 DNS 模式仍由「设置」页策略生成，不在此重复。修改累积后统一「校验 → 写入」，可选择是否重启。
- **Tailscale（网页登录）**：「设置 → Tailscale」添加内核内置的 tailscale 出站（tsnet），填设备名即可，auth key 可留空。添加时在 DNS 接管规则之后加入 `100.64.0.0/10`、`fd7a:115c:a1e0::/48` 两条规则，并把这两个网段加入 eBPF 的 `bypass-exclude`。新内核直接提供状态、登录链接和退出接口：读取状态不启动 tsnet、不等待启动锁、不扫描 WireGuard peers；「网页登录 / 立即连接」才启动，登录中每 3 秒查询状态，隐藏暂停、关闭弹窗或离页停止。退出只登出该出站，不重启整个代理。旧内核才回退到日志获取链接、测速唤醒和删除状态目录后重启的旧流程。登录状态保存在数据目录的 `tailscale/`，重启无需重新登录；删除出站会清理规则和组成员，仍有 `ts://名称` DNS 引用时拒绝删除。
- **大配置写入**：超过单条命令参数上限（Base64 120000 字节）的配置会分段写入 `run/stage.b64` 后再校验/应用，支持最大 4 MB。
- **列表性能**：应用列表在打开选择器时才读取，图标按可见项加载、限并发并使用有界缓存，滚动时暂停解码；代理组按可见节点行加载，刷新保留列表。首次界面使用约 1.8 MB 的常用中文字体子集，不再包含完整 CJK 字体。`magisk/webui/subset-font.py` 可从许可文件所列源字体复现子集，需要 Python/fonttools。
- **网页管理读取**：基础设置、会话和 Tailscale 分开加载，Tailscale 慢请求不再锁住刷新与端口等设置；会话请求最多等待 10 秒。Tailscale 页面每次只读取、解析一次配置，不再生成订阅和规则集等无关表单。账号以运行中内核返回的本机节点所属用户为准，未启动或无实时状态时才显示状态文件中的当前登录资料；它不是浏览器当前登录账号，修改 auth key 也不会自动切换已注册设备的身份。
- **同源面板代理**：通过鉴权的 WebUI 使用 `/clash/` 中转 zashboard 页面、控制器 API 与 WebSocket；控制器可继续只监听 `127.0.0.1`。后台注入控制器密钥，不将主/操作 Cookie 或 Tailnet 身份头传给控制器。退出登录或会话失效后，已连接的面板 WebSocket 最多 5 秒断开。没有启用密码的访问仍按网页管理既有免密策略处理。
- **增强设备控制**：仅手机模块管理器内的「网页管理」可启用，TCP 回环访问不算模块管理器。必须先设置主访问密码，启用后强制主密码访问，可再设独立操作密码（解锁 15 分钟）；Tailnet 账号免密不能代替主密码验证。支持按按钮读取最近短信、电量，保存热点名称/WPA2 密码/频段并切换系统网络共享，执行单次限时 root 命令，以及内置屏幕查看与控制。普通浏览器不能启用增强功能或修改独立密码；清除主密码会联动停用增强功能。
- **内置屏幕服务**：模块自带 scrcpy 5.0.1 与播放器，默认无需安装 Node、ADB 或 ws-scrcpy 服务，所有页面/视频/控制均通过已鉴权的 WebUI 中转；设备端只使用本地 Unix 通道，不新增 TCP 监听。进入「设备控制」允许屏幕入口，打开屏幕页并点击「开始连接」才启动编码器。支持触控拖动、导航/音量/电源键、旋转、主动粘贴文字和全屏；画质默认 1280 / 24 fps / 2 Mbps，无音频、不保持亮屏。一次一个会话，最长 15 分钟；隐藏/关页立停，操作锁定/主会话失效最多 5 秒断开，网络失联最多约 20 秒回收，不自动重连。HTTPS/回环优先 WebCodecs，普通局域网 HTTP 使用 MediaSource 兼容播放；需要支持 H.264 的现代浏览器。
- **屏幕兼容模式与安全边界**：已有 ws-scrcpy 可选「外部服务」，绑定 `127.0.0.1`，设置 `WS_SCRCPY_PATHNAME=/enhanced/scrcpy/`；此模式只代理，不接管第三方进程。热点桥接使用 Android 11/API 30+ 系统接口，OEM 权限拒绝/超时会明确报错，不能保证所有 ROM 可用。录屏受系统编码器、SELinux 与受保护内容限制。增强操作具备设备管理权限，独立密码不是任意 root 代码的安全沙箱；允许公网来源时强烈建议仅在局域网或 Tailscale 使用。
- **写配置必先校验**：`mihomo -t` 通过后备份旧配置、原子替换、重启；启动失败自动回滚。备份保留最近 10 份，可一键恢复。
- **开机自启**：概览显示状态，「设置」页独立开关；关闭自启不影响当前手动启动的服务。启动不再依赖公网 ping。
- **网络共享代理**：「设置」页控制热点、USB、蓝牙共享是否进入 eBPF；默认关闭，只代理本机。开启后填写实际下联接口（默认 `ap0,wlan1,rndis0,usb0,bt-pan`），不要把正在上网的 `wlan0` 当成热点接口。
- **包名绕过**：一行一个 Android 包名，通过 `local.exclude-package` 排除应用 UID，DNS 使用 `respect_policy`。共享 UID 的应用会一起绕过；须使用 Android 版核心，不能用 Linux 版替代。
- **Wi-Fi / SSID 策略**：不限制、仅指定 SSID 时代理、指定 SSID 时暂停三种模式，SSID 一行一个且精确匹配。未连接 Wi-Fi 时「仅指定」暂停、「指定时暂停」允许。后台检测网络变化并暂停/恢复，手动停止后不会被轮询意外拉起。
- **源配置与运行配置分离**：编辑的是 `config.yaml`；模块生成 `/data/adb/mihomo/run/config.yaml` 叠加设备策略，启动前校验。当前支持一个显式块格式的 eBPF listener（向导默认格式）；多 listener、listener 内锚点/合并键等结构会明确报错。设置页管理本机/共享模式、接口、包名和本机 DNS 策略，不会静默忽略开关。
- **Miuix 界面规范**：所有页面使用大标题 `TopAppBar`（随滚动折叠）+ 回弹列表，设置项统一为 `SmallTitle` 分组的卡片与 `BasicComponent` / `SwitchPreference` / `ArrowPreference` / `WindowDropdownPreference` 行；选择与编辑使用 `WindowBottomSheet` / `WindowDialog`，未保存修改时底部出现「撤销 / 保存」条。底部导航为首页 / 代理 / 设置，其余页面以子页压栈，支持系统返回键。浅色与深色主题跟随系统。
- **设置交互**：共享网卡在底部弹窗中勾选，显示类型、是否在线与推荐标记；应用绕过提供名称/包名搜索、用户/系统/全部/已选分类与图标；Wi-Fi 条件可一键加入当前 SSID。刷新状态不覆盖未保存草稿，保存后回读校验。
- **性能**：首页仅在可见且服务运行时每 2 秒读取轻量流量摘要，出口/订阅元数据/eBPF 维护摘要约每 30 秒读取；不为概览遍历全部连接、节点、规则或 BPF map。详细 eBPF 诊断仅手动触发。连接页每 5 秒刷新、打开详情/隐藏时暂停，列表只组合可见行；离页停止周期请求。增强信息不后台轮询，设备命令有并发/时间/输出上限；图标有界缓存与限并发，子策略使用与主策略相同的图标来源。大屏使用固定侧栏与限制宽度的内容区。

升级这套低开销 WebUI 时请**同时更新模块和内核**：旧内核缺少 `/connections/summary`、`/overview`、`/ebpf/summary` 时提示升级，不回退到高频全量查询。策略守护仍保留默认 5 秒的服务/SSID 条件检查，Wi-Fi 条件关闭时不探测 Wi-Fi；读取首页状态只读缓存，不重复启动 `cmd wifi` / `dumpsys`。Tailscale 自身维持组网所需的网络活动不受 WebUI 隐藏影响，不能承诺整机零耗电。

LuCI 概览也使用上述摘要接口；页面隐藏时停止轮询与实时订阅，离页后移除监听器。详见 `luci/README.md` 的资源开销说明。

功能对照 LuCI 版：概览、设备设置、代理切换与测速、连接管理、内核配置（基础/控制器/DNS/eBPF/订阅/规则集）、Tailscale 网页登录、配置文件（校验/备份/回滚）、内核管理、首次引导与导入优化、日志。规则列表与策略组的逐条编辑仍需直接改 YAML 或使用 zashboard。

### 构建模块 zip

从仓库根目录执行。默认先在 `magisk/webui` 调用自带 Gradle Wrapper 的 `wasmJsBrowserDistribution`，再打包。需要 **JDK 17**（`JAVA_HOME` 或 `PATH`）、**Go**（版本见 `magisk/webd/go.mod`）和 **Android SDK Platform/API 30+ 与 Build Tools/d8**（`ANDROID_HOME` 或 `ANDROID_SDK_ROOT`），后者编译随包携带的按需热点桥接。无需全局安装 Gradle，首次构建需联网下载依赖。Shell 打包还需要 `zip` 与 `gzip`。

打包时从官方发布获取固定版本 scrcpy server 与 JMuxer 2.1.4，校验代码中固定的 SHA-256 后缓存至 `magisk/scrcpy-assets/out/`；缓存有效时不重新下载。安装包包含资源和各自许可证，设备运行时不下载这些依赖。屏幕服务每次启动再校验 server 文件，资源损坏会拒绝启动。

```sh
sh magisk/build.sh           # POSIX shell + zip
pwsh -File magisk/build.ps1  # Windows / PowerShell 7，无需 zip 命令
```

产物均为仓库根目录 `dist/mihomo-ebpf-magisk-<版本>.zip`。脚本校验 `magisk/webui/build/dist/wasmJs/productionExecutable` 的入口 HTML/JS、桥接、模板、字体许可、非空 wasm 和离线中文字体，再将该目录完整映射到 ZIP 的 `webroot/`；旧 `magisk/webroot/` 不会被读取、覆盖或混入，Gradle 工程和测试代码也不会随包进入。字体、wasm 及其他 WebUI 资源逐字节复制；PowerShell 只对模块的 `.sh`、`.awk` 和 `module.prop` 做 UTF-8 无 BOM/LF 规范化，ZIP 路径使用正斜杠。Shell 构建应使用 LF 检出的模块脚本。

打包阶段生成静态资源的同名 `.gz`，网页管理直接流式发送已预压文件；不会在手机首次访问时执行高压缩或缓存整套 Wasm。没有预压或预压过期时发送原文件。包内另含 arm64/x86_64 `mihomo-webd` 和 `bin/device-control.jar`；设备桥接只在操作时短时启动，不是常驻 Android 服务。

仅当已有对应源码的 production distribution 时，才显式跳过构建：

```sh
sh magisk/build.sh --skip-webui-build
pwsh -File magisk/build.ps1 -SkipWebUiBuild
```

跳过构建仍会校验产物，但不会检查其与当前源码是否一致，也不会更新模板；缺失或不完整时直接失败，不回退到旧页面。请勿手动把整个 `magisk/` 或旧 `magisk/webroot/` 压缩发布。脚本先创建临时包，成功后替换目标 ZIP；清理仅限根 `dist/` 下自身创建的临时文件/目录，PowerShell 在删除前校验绝对路径边界。

CI：push 或打 v* tag 会同时构建 Magisk zip 与 LuCI apk，tag 构建自动发 Release（见 `.github/workflows/build.yml`）。仅 Magisk job 安装 Java 17、配置 Gradle 缓存与 Wrapper 校验，显式构建 Wasm distribution 后以跳过构建选项打包；LuCI 的构建流程保持独立。

模板是单一来源：`shared/template.yaml` 是唯一维护副本，LuCI 通过 `luci/scripts/sync-template.sh` 同步，Magisk 通过 WebUI Gradle 的 `wasmJsProcessResources` 收入产物。

### 结构

```
magisk/
├── module.prop          # 模块声明
├── customize.sh         # 安装时校验架构与内核能力，写入默认设置
├── service.sh           # 开机意愿和 SSID 监控
├── post-fs-data.sh      # 建运行目录
├── scripts/
│   ├── common.sh        # 路径、settings.ini、工具函数
│   ├── mihomo.sh        # 进程管理（start/stop/restart/status/enable/disable）
│   ├── policy.sh        # 持久化设备设置、SSID 轮询和策略应用
│   ├── policy-lib.sh    # 运行配置生成、进程就绪检测和回滚
│   ├── core.sh          # 内核下载/信息/回滚/下载设置
│   ├── apply.sh         # 配置校验→备份→替换→重启，失败回滚（支持分段暂存）
│   ├── host.sh          # 本机探测、远程配置下载、大配置分段暂存
│   └── backup.sh        # 备份列表/读取/删除/恢复
├── webui/               # 独立 Compose Miuix Kotlin/Wasm 工程
│   ├── gradlew / gradlew.bat / gradle/wrapper/
│   ├── build.gradle.kts
│   ├── bridge/backend.js  # KSU bridge 与 shell/控制器接口
│   ├── bridge/config.js   # 配置引擎：字段清单、补丁、导入分析、本机优化
│   ├── bridge/vendor/     # yaml 2.9.1（ISC）浏览器打包
│   ├── src/               # Kotlin 界面、启动页与离线字体
│   └── build/dist/wasmJs/productionExecutable/
│                          # 全量映射到发布 ZIP 的 webroot/
└── webroot/             # 旧版 HTML/JS，仅保留源码，不参与发布
```

模块 WebUI 优先使用异步 `ksu.spawn` 执行脚本，旧管理器才退回 `ksu.exec`；控制器请求先尝试直连，失败才用 root shell 的 `curl`，短时间缓存直连失败结果。外部浏览器通过已鉴权的同源 webd 接口访问，面板不必对外暴露控制器。需要设备提供 `curl`；缺失时请先安装可信的 curl 工具模块。向导默认仅在 `127.0.0.1` 开放控制器。

内核下载优先正式 release，无正式 release 时使用最新发布的 prerelease；显式指定 tag 时不回退。只选择 Android 架构资产。模块 ZIP 不含核心，可在 WebUI 下载，也可手动将带 `with_ebpf` 的 Android 可执行文件放到 `/data/adb/mihomo/mihomo` 并设置权限 `0755`。

## 内核要求

- 内核二进制：liuran001/mihomo 的 smart + eBPF 分支构建产物（`mihomo-android-arm64[-v8]-*.gz` / `mihomo-android-amd64-*.gz`），需要启用 `with_ebpf`。
- Android 设备：内核需启用 eBPF（cgroup BPF、sockmap 等，Android 11+ 的 GKI 内核一般都满足）。
- 透明代理走 eBPF（cgroup + packet_rewrite），不需要 iptables TPROXY 规则。

### 回归测试

```sh
node --test magisk/tests/frontend.test.js magisk/tests/bridge.test.js magisk/tests/onboarding.test.js magisk/tests/config.test.js magisk/tests/login.test.js magisk/tests/screen.test.js
sh magisk/tests/core.test.sh
sh magisk/tests/backend.sh
sh magisk/tests/backend-process.sh
sh magisk/tests/backend-readiness.sh
sh magisk/tests/backend-status.sh
sh magisk/tests/tailscale.sh
sh magisk/tests/host-webui.sh
(cd magisk/webd && go vet ./... && go test -race ./...)
```

`config.test.js` 覆盖配置引擎：模板逐字节往返、字段读写与校验、订阅/规则集增删、导入识别、本机优化（含跳过、幂等、多 listener 合并），并把优化结果交给 `policy-yaml.awk` 渲染确认模块能接管。

本地预览 WebUI（模拟后台，含配置引擎）：先构建 `wasmJsBrowserDistribution`，再运行 `node magisk/tests/preview-server.cjs`，打开 `http://127.0.0.1:8790/`；加 `?fresh=1` 模拟首次安装进入引导。

`magisk/tests/fixtures/android.yaml` 是不含订阅的 AVD 验证配置，规则为 `MATCH,REJECT`，仅用于观察流量是否被接管，不能当日常配置。实测时请先备份已有 `/data/adb/mihomo` 数据，验证结束后恢复正常配置。

**验证边界**：Compose production、JavaScript 回归、webd 竞态测试及模块脚本回归通过。在新建的 Android 15/API 35 独立模拟器上，真实验证电量、注入的测试短信、热点配置/启停、限时终端、内置 scrcpy 视频与主页键，以及隐藏/关页/锁定/退出后的进程回收；没有使用用户手机、真实短信或登录凭证。宽窄屏 Compose 设置页另有模拟后台测试。真实 Tailnet 账号切换、不同 OEM 的权限兼容、实际热点联网及整机功耗仍需硬件验证；详细证据及辅助功能树限制分阶段记录于 `magisk/tests/validation.md`。

配置写入单条命令的 base64 上限为 120000 字节，超过时分段暂存后写入，最大 4 MB。测试覆盖范围与限制见 `magisk/tests/validation.md`；后台设置和 YAML 格式约定见 `magisk/tests/backend-contract.md`。
