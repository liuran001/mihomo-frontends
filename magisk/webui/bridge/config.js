// 配置引擎：在 WebView 内解析/修改 mihomo YAML，保留注释与锚点。
// 依赖 vendor/yaml.min.js 暴露的 globalThis.YAML。对外暴露 globalThis.mihomoConfig（纯函数，无 I/O）。
// 字段清单参照 LuCI（luci/root/usr/share/ucode/mihomo/forms.uc），并去掉由模块策略接管的字段：
//   listener.mode / local.dns-mode / local.exclude-package / shared.interface 由「设置」页的共享与绕过策略生成。
(function (root) {
  'use strict';

  const Y = root.YAML;
  const PARSE = { merge: true, uniqueKeys: true, prettyErrors: false, strict: false };
  const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false, indentSeq: true };
  const MAX_LIST = 1024;
  const ZASHBOARD = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';
  const GEOX = {
    geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
    geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
    mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb',
  };
  const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];

  // ---------- 基础工具 ----------

  // YAML 错误的行列（从 1 开始）：优先用 linePos，没有时按字符偏移计算
  function position(text, error) {
    if (error.linePos && error.linePos[0]) return error.linePos[0];
    const offset = Array.isArray(error.pos) && Number.isInteger(error.pos[0]) ? Math.min(error.pos[0], text.length) : -1;
    if (offset < 0) return { line: 0, col: 0 };
    const before = text.slice(0, offset);
    return { line: before.split('\n').length, col: offset - before.lastIndexOf('\n') };
  }

  function parse(content) {
    const text = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
    if (!text.trim()) throw new Error('配置为空');
    const doc = Y.parseDocument(text, PARSE);
    if (doc.errors.length) {
      const error = doc.errors[0];
      const where = position(text, error);
      const line = where.line ? '第 ' + where.line + ' 行：' : '';
      throw new Error('YAML 解析失败，' + line + String(error.message).split('\n')[0]);
    }
    if (!Y.isMap(doc.contents)) throw new Error('配置顶层必须是 YAML 映射');
    return doc;
  }

  // 编辑器实时校验：列出 YAML 错误与警告（行、列从 1 开始），不抛异常
  function lint(content) {
    const text = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
    const doc = Y.parseDocument(text, PARSE);
    const describe = (item, level) => {
      const where = position(text, item);
      return { level, message: String(item.message).split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''), line: where.line, col: where.col };
    };
    const problems = doc.errors.map((item) => describe(item, 'error')).concat(doc.warnings.map((item) => describe(item, 'warning')));
    if (!doc.errors.length && text.trim() && !Y.isMap(doc.contents)) problems.push({ level: 'error', message: '配置顶层必须是 YAML 映射', line: 1, col: 1 });
    return { ok: true, problems: problems.slice(0, 20) };
  }

  function dump(doc) {
    return doc.toString(STRINGIFY);
  }

  function plain(doc) {
    return doc.toJS({ maxAliasCount: -1 }) || {};
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function getPath(object, path) {
    let current = object;
    for (const key of path) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  }

  function nodeAt(doc, path) {
    return path.length ? doc.getIn(path, true) : doc.contents;
  }

  // 写入时若中间映射不存在则逐级创建（块风格）。
  function setIn(doc, path, value) {
    for (let index = 1; index < path.length; index++) {
      const parent = path.slice(0, index);
      const node = nodeAt(doc, parent);
      if (node === undefined || node === null || (Y.isScalar(node) && node.value == null)) {
        doc.setIn(parent, doc.createNode({}));
      } else if (!Y.isMap(node) && !Y.isSeq(node)) {
        throw new Error(parent.join('.') + ' 不是映射，无法写入子字段');
      }
    }
    const node = doc.createNode(value);
    if (Y.isCollection(node)) node.flow = Array.isArray(value) && value.length > 0 && value.length <= 6 &&
      value.every((item) => typeof item !== 'object' && String(item).length <= 24);
    doc.setIn(path, node);
  }

  function isMergeKey(key) {
    if (!Y.isScalar(key)) return false;
    const value = key.value;
    return value === '<<' || (typeof value === 'symbol' && value.description === '<<');
  }

  function deleteIn(doc, path) {
    if (nodeAt(doc, path) !== undefined) doc.deleteIn(path);
  }

  function randomHex(bytes) {
    const buffer = new Uint8Array(bytes);
    (root.crypto || globalThis.crypto).getRandomValues(buffer);
    return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  // ---------- 校验 ----------

  const check = {
    port(value, zero) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < (zero ? 0 : 1) || number > 65535) throw new Error('端口须为 ' + (zero ? 0 : 1) + '–65535');
      return number;
    },
    int(value, min, max) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < min || number > max) throw new Error('须为 ' + min + '–' + max + ' 的整数');
      return number;
    },
    url(value) {
      const text = String(value).trim();
      if (!/^https?:\/\/[^/?#\s]+/.test(text) || /\s/.test(text) || text.length > 2048) throw new Error('须为 http(s) 链接');
      return text;
    },
    listen(value) {
      const text = String(value).trim();
      if (!/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.*-]*):\d{1,5}$/.test(text)) throw new Error('格式须为 地址:端口，例如 127.0.0.1:9090');
      check.port(text.slice(text.lastIndexOf(':') + 1));
      return text;
    },
    name(value) {
      const text = String(value).trim();
      if (!text || text.length > 64 || /[/,\\\n\r]/.test(text) || text.startsWith('.')) throw new Error('名称须为 1–64 个字符，不能含 / , \\ 或以 . 开头');
      return text;
    },
    cidr(value) {
      const text = String(value).trim();
      if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(text)) throw new Error('无效的 CIDR：' + text);
      return text;
    },
    mac(value) {
      const text = String(value).trim().toLowerCase().replace(/-/g, ':');
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text)) throw new Error('无效的 MAC：' + value);
      return text;
    },
    text(value, max) {
      const text = String(value);
      if (text.length > (max || 256) || /[\n\r\0]/.test(text)) throw new Error('文本过长或含换行');
      return text;
    },
  };

  function listValue(value, item, limit) {
    const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const result = [];
    for (const raw of items) {
      const text = String(raw).trim();
      if (!text) continue;
      const checked = item ? item(text) : check.text(text);
      if (!result.includes(checked)) result.push(checked);
    }
    if (result.length > (limit || MAX_LIST)) throw new Error('最多 ' + (limit || MAX_LIST) + ' 项');
    return result;
  }

  // ---------- 字段清单（对齐 LuCI） ----------
  // type: bool | enum | int | text | secret | url | listen | list
  // path 以 L 开头时相对 eBPF listener。

  const L = '@listener';
  const SECTIONS = [
    {
      id: 'basic', title: '基础', summary: '端口、运行模式与日志',
      fields: [
        { path: ['mode'], label: '运行模式', summary: '规则：按规则分流；全局：全部走 GLOBAL 组选中的节点；直连：全部不走代理', type: 'enum', options: [['rule', '规则'], ['global', '全局'], ['direct', '直连']], def: 'rule' },
        { path: ['mixed-port'], label: '混合端口', summary: '给其它应用手动设置的 HTTP/SOCKS5 代理端口；透明代理不需要，0 为关闭', type: 'int', min: 0, max: 65535 },
        { path: ['allow-lan'], label: '允许局域网连接', summary: '公共 Wi-Fi 下建议关闭', type: 'bool', def: false },
        { path: ['bind-address'], label: '监听地址', summary: '允许局域网连接时监听的地址，* 为全部网卡', type: 'text', placeholder: '*' },
        { path: ['ipv6'], label: 'IPv6', summary: '关闭后内核不处理 IPv6 连接与解析', type: 'bool', def: true },
        { path: ['log-level'], label: '日志级别', summary: '调试会产生大量日志并更耗电，排查问题时再打开', type: 'enum', options: [['silent', '静默'], ['error', '错误'], ['warning', '警告'], ['info', '信息'], ['debug', '调试']], def: 'info' },
        { path: ['find-process-mode'], label: '识别连接来自哪个应用', summary: '规则里按应用分流时需要；关闭更省电', type: 'enum', options: [['always', '总是'], ['strict', '按需'], ['off', '关闭']], def: 'strict' },
        { path: ['tcp-concurrent'], label: 'TCP 并发连接', summary: '同时连接域名解析出的多个 IP，用最快的那个', type: 'bool', def: false },
        { path: ['unified-delay'], label: '统一延迟', summary: '测速时扣除握手耗时，不同协议的节点延迟更可比', type: 'bool', def: false },
        { path: ['sniffer', 'enable'], label: '域名嗅探', summary: '从 TLS/HTTP 握手里读出域名，让按 IP 进来的连接也能按域名规则分流', type: 'bool', def: false },
        { path: ['profile', 'store-selected'], label: '记住手动选择的节点', summary: '重启后恢复上次在代理页手动选择的节点', type: 'bool', def: false },
        { path: ['geodata-loader'], label: 'GEO 数据加载方式', summary: '内存紧张的设备选省内存', type: 'enum', options: [['standard', '标准'], ['memconservative', '省内存']], def: 'standard' },
      ],
    },
    {
      id: 'controller', title: '面板与数据文件', summary: '面板访问地址与密钥、GEO 数据下载',
      fields: [
        { path: ['external-controller'], label: '控制器地址', summary: '面板和本页面通过它管理内核；只在本机用时保持 127.0.0.1', type: 'listen', required: true },
        { path: ['secret'], label: '控制器密钥', summary: '控制器与面板的访问密码；网页管理与 zashboard 都会用到', type: 'secret' },
        { path: ['external-ui'], label: '面板目录', summary: '面板文件存放目录，内核在 http://控制器地址/ui/ 提供面板', type: 'text', placeholder: './dashboard' },
        { path: ['external-ui-url'], label: '面板下载地址', summary: '面板目录为空时内核从这里下载面板；留空则使用 zashboard', type: 'url' },
        { path: ['geox-url', 'geoip'], label: 'GeoIP 下载地址', summary: 'GEOIP 规则使用的数据文件', type: 'url' },
        { path: ['geox-url', 'geosite'], label: 'GeoSite 下载地址', summary: 'GEOSITE 规则使用的数据文件', type: 'url' },
        { path: ['geox-url', 'mmdb'], label: 'MMDB 下载地址', summary: 'GeoIP 的 MaxMind 格式数据', type: 'url' },
        { path: ['geo-auto-update'], label: '自动更新 GEO 数据', summary: '按周期重新下载上面三个数据文件', type: 'bool', def: false },
      ],
    },
    {
      id: 'dns', title: 'DNS', summary: '域名怎样解析、用哪些服务器',
      fields: [
        { path: ['dns', 'enable'], label: '启用 DNS', summary: '由内核接管 DNS 解析；透明代理与 FakeIP 都依赖它', type: 'bool', def: false },
        { path: ['dns', 'listen'], label: '监听地址', summary: '内核 DNS 服务监听地址，eBPF 劫持的 DNS 会转到这里', type: 'listen', placeholder: '127.0.0.1:1053' },
        { path: ['dns', 'enhanced-mode'], label: '模式', summary: 'fake-ip：返回假地址，连接时才按域名分流，速度快；redir-host：返回真实地址，兼容性好', type: 'enum', options: [['redir-host', 'redir-host'], ['fake-ip', 'fake-ip'], ['normal', 'normal']], def: 'redir-host' },
        { path: ['dns', 'ipv6'], label: '返回 IPv6 地址（AAAA）', summary: '关闭后对 AAAA 查询返回空，避免没有 IPv6 出口时连接变慢', type: 'bool', def: false },
        { path: ['dns', 'fake-ip-range'], label: 'FakeIP 地址段（IPv4）', summary: 'fake-ip 模式分配假地址用的网段，不要和局域网冲突', type: 'text', placeholder: '198.18.0.1/16' },
        { path: ['dns', 'default-nameserver'], label: '引导服务器', summary: '用于解析其它 DNS 服务器的域名', type: 'list', limit: 32 },
        { path: ['dns', 'nameserver'], label: '默认服务器', summary: '未被下面两项覆盖的域名用这里的服务器解析', type: 'list', limit: 32 },
        { path: ['dns', 'proxy-server-nameserver'], label: '代理节点域名的服务器', summary: '只用于解析代理节点自身的域名，避免依赖代理才能解析', type: 'list', limit: 32 },
        { path: ['dns', 'direct-nameserver'], label: '直连域名的服务器', summary: '命中直连规则的域名用这里的服务器解析，通常填国内 DNS', type: 'list', limit: 32 },
        { path: ['dns', 'fake-ip-filter'], label: '不使用 FakeIP 的域名', summary: '这些域名始终返回真实地址（如局域网、NTP、游戏联机）', type: 'list', limit: 1024 },
      ],
    },
    {
      id: 'ebpf', title: '透明代理', summary: '哪些流量交给 mihomo、怎样接管',
      fields: [
        { path: [L, 'network'], label: '协议', summary: '透明代理接管的协议；只代理 TCP 时 UDP 直接走系统网络', type: 'enum', options: [['tcp,udp', 'TCP + UDP'], ['tcp', '仅 TCP'], ['udp', '仅 UDP']], def: 'tcp,udp', joined: true },
        { path: [L, 'udp-timeout'], label: 'UDP 会话超时（秒）', summary: 'UDP 会话空闲多久后释放', type: 'int', min: 5, max: 86400, placeholder: '300' },
        { path: [L, 'bypass-rule-set'], label: '直接放行的地址规则集', summary: '命中这些规则集的目标在内核层直接放行、不进 mihomo，更省电（适合国内 IP 列表）', type: 'list', ruleSets: 'ipcidr', limit: 32 },
        { path: [L, 'fakeip-icmp'], label: 'ping 假地址时回应', summary: '开启后 ping 域名（FakeIP 地址）会立即收到回复，避免一些应用误判断网；本机需选 tc 接管方式或开启共享', type: 'enum', options: [['off', '关闭'], ['reply', '本地应答']], def: 'off' },
        { path: [L, 'bypass-tun-direct'], label: '与其它 VPN 共存', summary: '其它 VPN 应用的流量不再被接管，两者可同时使用', type: 'bool', def: true },
        { path: [L, 'local', 'data-plane'], label: '本机接管方式', summary: '本机应用的流量怎样交给 mihomo。不确定就用 cgroup（兼容最好）；需要 ping 通域名时选 tc（内核 5.7+）', type: 'enum', options: [['cgroup', 'cgroup（推荐）'], ['tc', 'tc（需内核 5.7+）']], def: 'cgroup' },
        { path: [L, 'local', 'ipv6'], label: '本机 IPv6 也走代理', summary: '关闭后本机的 IPv6 连接直接上网', type: 'bool', def: true },
        { path: [L, 'local', 'bypass-private-address'], label: '局域网地址不走代理', summary: '访问 192.168.x.x 等局域网地址（含 Tailscale 的 100.64.0.0/10）时直接连接', type: 'bool', def: true },
        { path: [L, 'local', 'bypass-exclude'], label: '例外：这些地址仍走 mihomo', summary: '即使属于局域网地址，这些网段仍交给 mihomo（例如 Tailscale 的 100.64.0.0/10）', type: 'list', item: 'cidr', limit: 256 },
        { path: [L, 'local', 'bypass-port'], label: '这些端口不走代理', summary: '访问这些目标端口时直接连接', type: 'list', item: 'port', limit: 256 },
        { path: [L, 'shared', 'data-plane'], label: '共享设备接管方式', summary: '热点、USB 共享设备的流量怎样交给 mihomo。默认 packet_rewrite；热点能上网却不走代理时试试 socket_assign（内核 5.7+）', type: 'enum', options: [['packet_rewrite', 'packet_rewrite（推荐）'], ['socket_assign', 'socket_assign（需内核 5.7+）']], def: 'packet_rewrite' },
        { path: [L, 'shared', 'dns-mode'], label: '共享设备的 DNS', summary: '接管：设备的域名查询都交给 mihomo（推荐，分流才准）；按规则：由分流规则决定；不处理：设备自己查询', type: 'enum', options: [['hijack', '接管（推荐）'], ['respect_policy', '按规则'], ['off', '不处理']], def: 'hijack' },
        { path: [L, 'shared', 'ipv6'], label: '共享设备的 IPv6 也走代理', summary: '关闭后共享设备的 IPv6 连接直接上网', type: 'bool', def: true },
        { path: [L, 'shared', 'bypass-private-address'], label: '局域网地址不走代理', summary: '共享设备访问局域网地址时直接连接', type: 'bool', def: true },
        { path: [L, 'shared', 'include-mac-address'], label: '只代理这些设备（MAC）', summary: '填了以后只有这些设备走代理', type: 'list', item: 'mac', limit: 256 },
        { path: [L, 'shared', 'exclude-mac-address'], label: '不代理这些设备（MAC）', summary: '这些设备的流量不走代理', type: 'list', item: 'mac', limit: 256 },
        { path: [L, 'shared', 'include-source-cidr'], label: '只代理这些来源地址', summary: '填了以后只有这些来源地址走代理', type: 'list', item: 'cidr', limit: 256 },
        { path: [L, 'shared', 'exclude-source-cidr'], label: '不代理这些来源地址', summary: '来自这些地址的流量不走代理', type: 'list', item: 'cidr', limit: 256 },
      ],
    },
  ];

  const PROVIDER_FIELDS = [
    { key: ['url'], label: '订阅链接', type: 'url', required: true },
    { key: ['interval'], label: '更新间隔（秒）', type: 'int', min: 0, max: 31536000, placeholder: '3600' },
    { key: ['header', 'User-Agent'], label: 'User-Agent', type: 'text', list: true, placeholder: 'clash.meta' },
    { key: ['override', 'additional-prefix'], label: '节点名前缀', type: 'text' },
    { key: ['health-check', 'enable'], label: '健康检查', type: 'bool', def: false },
    { key: ['health-check', 'url'], label: '测速地址', type: 'url' },
    { key: ['health-check', 'interval'], label: '测速间隔（秒）', type: 'int', min: 0, max: 86400 },
    { key: ['health-check', 'timeout'], label: '超时（毫秒）', type: 'int', min: 1, max: 60000 },
  ];

  const RULE_PROVIDER_FIELDS = [
    { key: ['behavior'], label: '类型', type: 'enum', options: [['domain', '域名'], ['ipcidr', 'IP 段'], ['classical', '经典']], def: 'domain' },
    { key: ['format'], label: '格式', type: 'enum', options: [['mrs', 'mrs'], ['yaml', 'yaml'], ['text', 'text']], def: 'yaml' },
    { key: ['url'], label: '链接', type: 'url', required: true },
    { key: ['interval'], label: '更新间隔（秒）', type: 'int', min: 0, max: 31536000, placeholder: '86400' },
    { key: ['proxy'], label: '下载经由', type: 'policy', def: 'DIRECT' },
  ];

  // Tailscale 出站（与 LuCI TS_FIELDS 对齐）。advertise-routes 需要内核在 -t 校验时跳过 tsnet 启动（liuran001/mihomo 935b0887 起）。
  const TAILSCALE_FIELDS = [
    { key: ['hostname'], label: '设备名', summary: '在 Tailnet 中显示的名称', type: 'text', required: true, pattern: /^[A-Za-z0-9-]{1,63}$/, hint: '只能包含字母、数字与 -' },
    { key: ['auth-key'], label: 'Auth key', summary: '留空时用网页登录', type: 'secret' },
    { key: ['udp'], label: '转发 UDP', type: 'bool', def: false },
    { key: ['accept-routes'], label: '接受子网路由', type: 'bool', def: false },
    { key: ['exit-node'], label: '出口节点', summary: '节点名或 IP，留空不使用', type: 'text' },
    { key: ['advertise-routes'], label: '通告子网路由', summary: '让 Tailnet 里的设备经本机访问这些网段（如家里的局域网）；需在 Tailscale 后台批准', type: 'list', item: 'cidr', limit: 64 },
  ];
  // 网页管理经内核 tailscale serve 发布到本机 Tailnet 地址（unix socket 只有 root 能连接，身份头可信）
  const WEBUI_SERVE_TARGET = 'unix:run/webui.sock';
  const WEBUI_SERVE_PORT = 80;

  function webuiServe(item) {
    return Array.isArray(item.serve) && item.serve.some((entry) => isObject(entry) && entry.target === WEBUI_SERVE_TARGET);
  }

  // 用户自己的 serve 转发（不含网页管理那一条）：Tailnet 里访问 http://设备名:port/ 转到 target
  function userServe(item) {
    return (Array.isArray(item.serve) ? item.serve : [])
      .filter((entry) => isObject(entry) && entry.target !== WEBUI_SERVE_TARGET)
      .map((entry) => ({ port: Number(entry.port) || 0, target: typeof entry.target === 'string' ? entry.target : '' }));
  }

  const SERVE_HTTP = /^http:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/?$/;
  const SERVE_UNIX = /^unix:(\/\/)?[^\s]+$/;

  function normalizeServe(list, webui) {
    if (!Array.isArray(list) || list.length > 32) throw new Error('serve 必须是最多 32 项的列表');
    const seen = new Set(webui ? [WEBUI_SERVE_PORT] : []);
    return list.map((entry) => {
      if (!isObject(entry)) throw new Error('serve 项无效');
      const port = entry.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数');
      if (seen.has(port)) throw new Error(port === WEBUI_SERVE_PORT && webui ? '80 端口已用于网页管理' : '端口重复：' + port);
      seen.add(port);
      const target = typeof entry.target === 'string' ? entry.target.trim() : '';
      const http = SERVE_HTTP.exec(target);
      if (http && Number(http[3]) >= 1 && Number(http[3]) <= 65535) return { port, target: target.replace(/\/$/, '') };
      if (SERVE_UNIX.test(target)) return { port, target };
      throw new Error('转发目标须为 http://IP:端口 或 unix:路径：' + (target || '(空)'));
    });
  }
  const TAILSCALE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

  function tailscaleList(data) {
    return (Array.isArray(data.proxies) ? data.proxies : []).filter((item) => isObject(item) && item.type === 'tailscale');
  }

  function ebpfIndex(data) {
    const listeners = Array.isArray(data.listeners) ? data.listeners : [];
    return listeners.findIndex((item) => isObject(item) && item.type === 'ebpf');
  }

  function resolvePath(data, path) {
    if (path[0] !== L) return path;
    const index = ebpfIndex(data);
    if (index < 0) return null;
    return ['listeners', index].concat(path.slice(1));
  }

  function displayValue(field, value) {
    if (field.joined && Array.isArray(value)) return value.join(',');
    return value;
  }

  function fieldState(field, data, raw, extra) {
    const path = resolvePath(data, field.path || field.key);
    const value = path ? getPath(data, path) : undefined;
    const state = {
      id: (field.path || field.key).join('.'), path: field.path || field.key, label: field.label, type: field.type,
      summary: field.summary || '', placeholder: field.placeholder || '', required: !!field.required,
      options: field.options ? field.options.map(([id, title]) => ({ id, title })) : undefined,
      value: value === undefined ? null : displayValue(field, value), def: field.def === undefined ? null : field.def,
      available: !!path, min: field.min, max: field.max,
    };
    if (field.type === 'list' && field.ruleSets) {
      state.choices = Object.entries(isObject(data['rule-providers']) ? data['rule-providers'] : {})
        .filter(([, item]) => isObject(item) && item.behavior === field.ruleSets).map(([name]) => name);
    }
    if (field.type === 'policy') state.choices = (extra && extra.policies) || BUILTIN_POLICIES;
    if (field.type === 'secret' && typeof state.value === 'string' && state.value) state.masked = true;
    void raw;
    return state;
  }

  function policies(data) {
    const groups = Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : [];
    const proxies = Array.isArray(data.proxies) ? data.proxies : [];
    return BUILTIN_POLICIES.concat(groups.concat(proxies).filter(isObject).map((item) => String(item.name || '')).filter(Boolean));
  }

  function schema(content) {
    const doc = parse(content);
    const data = plain(doc);
    const extra = { policies: policies(data) };
    const sections = SECTIONS.map((section) => ({
      id: section.id, title: section.title, summary: section.summary,
      available: section.id !== 'ebpf' || ebpfIndex(data) >= 0,
      fields: section.fields.map((field) => fieldState(field, data, null, extra)),
    }));
    const providers = Object.entries(isObject(data['proxy-providers']) ? data['proxy-providers'] : {}).map(([name, item]) => ({
      name, type: isObject(item) ? String(item.type || '') : '', editable: isObject(item) && item.type === 'http',
      fields: PROVIDER_FIELDS.map((field) => ({ ...fieldState(field, isObject(item) ? item : {}, null, extra), id: field.key.join('.'), path: field.key })),
    }));
    const ruleProviders = Object.entries(isObject(data['rule-providers']) ? data['rule-providers'] : {}).map(([name, item]) => ({
      name, type: isObject(item) ? String(item.type || '') : '', editable: isObject(item) && item.type === 'http',
      used: (Array.isArray(data.rules) ? data.rules : []).some((rule) => typeof rule === 'string' && ruleUses(rule, name)),
      fields: RULE_PROVIDER_FIELDS.map((field) => ({ ...fieldState(field, isObject(item) ? item : {}, null, extra), id: field.key.join('.'), path: field.key })),
    }));
    return { ok: true, sections, providers, ruleProviders, ...tailscaleSchema(data), providerFields: PROVIDER_FIELDS.map((field) => fieldState(field, {}, null, extra)),
      ruleProviderFields: RULE_PROVIDER_FIELDS.map((field) => fieldState(field, {}, null, extra)), nodes: nodeSchema(doc, data), groups: groupSchema(doc, data), rules: ruleSchema(data), summary: summarize(doc, data) };
  }

  function tailscaleSchema(data) {
    const tailscale = tailscaleList(data).map((item) => ({
      name: String(item.name || ''), type: 'tailscale', editable: true, stateDir: typeof item['state-dir'] === 'string' ? item['state-dir'] : '',
      used: !!item['auth-key'], webui: webuiServe(item), serve: userServe(item),
      fields: TAILSCALE_FIELDS.map((field) => ({ ...fieldState(field, item, null, null), id: field.key.join('.'), path: field.key })),
    }));
    return { ok: true, tailscale, tailscaleFields: TAILSCALE_FIELDS.map((field) => fieldState(field, {}, null, null)) };
  }

  function tailscale(content) {
    return tailscaleSchema(plain(parse(content)));
  }

  function ruleUses(rule, name) {
    return rule.split(',').map((part) => part.trim().replace(/^\(+|\)+$/g, '')).includes(name) && /RULE-SET/.test(rule);
  }

  function findField(path) {
    const id = path.join('.');
    for (const section of SECTIONS) for (const field of section.fields) if (field.path.join('.') === id) return field;
    return null;
  }

  function normalizeValue(field, value) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return null;
    switch (field.type) {
      case 'bool':
        if (typeof value !== 'boolean') throw new Error(field.label + ' 必须为开或关');
        return value;
      case 'enum': {
        const id = String(value);
        if (!field.options.some(([option]) => option === id)) throw new Error(field.label + ' 取值无效');
        return field.joined ? id.split(',') : id;
      }
      case 'int':
        try { return check.int(value, field.min, field.max); } catch (error) { throw new Error(field.label + ' ' + error.message); }
      case 'url':
        try { return check.url(value); } catch (error) { throw new Error(field.label + ' ' + error.message); }
      case 'listen':
        try { return check.listen(value); } catch (error) { throw new Error(field.label + ' ' + error.message); }
      case 'secret': {
        const text = String(value);
        if (/\s/.test(text) || text.length > 128) throw new Error(field.label + ' 不能含空白，且不超过 128 字符');
        return text;
      }
      case 'policy':
        return check.text(value, 128);
      case 'list': {
        const item = field.item === 'cidr' ? check.cidr : field.item === 'mac' ? check.mac
          : field.item === 'port' ? (text) => check.port(text) : (text) => check.text(text, 256);
        try { return listValue(value, item, field.limit); } catch (error) { throw new Error(field.label + '：' + error.message); }
      }
      default:
        if (field.list) return [check.text(value, 256)];
        try { return check.text(value, 256); } catch (error) { throw new Error(field.label + ' ' + error.message); }
    }
  }

  // ---------- 修改 ----------
  // ops: [{op:'set', path:[...], value}] 由 SECTIONS 字段约束；
  //      {op:'provider.set', name, values:{'url':..}} / {op:'provider.add', name, values} / {op:'provider.delete', name}
  //      {op:'ruleProvider.set|add|delete', ...}
  //      {op:'proxy.add', nodes:[...], groups:[...]} / {op:'proxy.set', name, data, groups} / {op:'proxy.delete', name}
  //      {op:'group.add', data} / {op:'group.set', name, data} / {op:'group.delete', name} / {op:'group.move', name, to}
  //      {op:'rules.set', items:[{k}|{k,v}|{v}]}（k 为原下标）

  function patch(content, ops) {
    if (!Array.isArray(ops) || !ops.length) throw new Error('没有要保存的修改');
    if (ops.length > 256) throw new Error('一次修改过多');
    const doc = parse(content);
    for (const op of ops) {
      if (!isObject(op)) throw new Error('修改项无效');
      const data = plain(doc);
      if (op.op === 'set') applySet(doc, data, op);
      else if (/^(provider|ruleProvider)\.(set|add|delete)$/.test(op.op)) applyCollection(doc, data, op);
      else if (/^tailscale\.(set|add|delete|webui|serve)$/.test(op.op)) applyTailscale(doc, data, op);
      else if (/^proxy\.(set|add|delete)$/.test(op.op)) applyProxy(doc, data, op);
      else if (/^group\.(set|add|delete|move)$/.test(op.op)) applyGroup(doc, data, op);
      else if (op.op === 'rules.set') applyRules(doc, data, op);
      else throw new Error('不支持的修改：' + op.op);
    }
    const output = dump(doc);
    parse(output);
    return { ok: true, content: output };
  }

  function applySet(doc, data, op) {
    if (!Array.isArray(op.path)) throw new Error('字段路径无效');
    const field = findField(op.path);
    if (!field) throw new Error('不支持修改字段：' + op.path.join('.'));
    const path = resolvePath(data, field.path);
    if (!path) throw new Error('配置里没有 eBPF listener，请先执行「本机优化」');
    const value = normalizeValue(field, op.value);
    if (value === null) {
      if (field.required) throw new Error(field.label + ' 不能为空');
      deleteIn(doc, path);
    } else {
      if (field.ruleSets) {
        const sets = isObject(data['rule-providers']) ? data['rule-providers'] : {};
        for (const name of value) if (!isObject(sets[name])) throw new Error('规则集不存在：' + name);
      }
      setIn(doc, path, value);
    }
  }

  function collectionInfo(kind) {
    return kind === 'provider'
      ? { key: 'proxy-providers', fields: PROVIDER_FIELDS, dir: './proxy_provider/', title: '订阅' }
      : { key: 'rule-providers', fields: RULE_PROVIDER_FIELDS, dir: './rule_provider/', title: '规则集' };
  }

  function providerAnchor(doc, key) {
    const map = doc.get(key, true);
    if (!Y.isMap(map)) return null;
    for (const pair of map.items) {
      if (!Y.isMap(pair.value)) continue;
      for (const inner of pair.value.items) {
        if (isMergeKey(inner.key) && Y.isAlias(inner.value)) return inner.value.source;
      }
    }
    return null;
  }

  function applyCollection(doc, data, op) {
    const [kind, action] = op.op.split('.');
    const info = collectionInfo(kind);
    const name = check.name(op.name);
    const items = isObject(data[info.key]) ? data[info.key] : {};
    if (action === 'delete') {
      if (!(name in items)) throw new Error(info.title + '不存在：' + name);
      if (kind === 'ruleProvider' && (Array.isArray(data.rules) ? data.rules : []).some((rule) => typeof rule === 'string' && ruleUses(rule, name))) {
        throw new Error('规则仍在引用规则集 ' + name + '，请先在配置原文中删除相关规则');
      }
      doc.deleteIn([info.key, name]);
      if (kind === 'provider') unlinkProvider(doc, data, name);
      return;
    }
    if (action === 'add' && name in items) throw new Error(info.title + '已存在：' + name);
    if (action === 'set' && !(name in items)) throw new Error(info.title + '不存在：' + name);
    if (action === 'set' && items[name].type !== 'http') throw new Error('只能编辑 http 类型的' + info.title);
    const values = isObject(op.values) ? op.values : {};
    if (action === 'add') {
      const anchor = kind === 'provider' ? providerAnchor(doc, info.key) : null;
      const node = doc.createNode({});
      if (anchor) node.items.push(doc.createPair(new Y.Scalar(Symbol.for('<<')), new Y.Alias(anchor)));
      if (!anchor || kind !== 'provider') node.set('type', 'http');
      if (!Y.isMap(doc.get(info.key, true))) doc.set(info.key, doc.createNode({}));
      doc.get(info.key, true).set(name, node);
      if (kind === 'provider') {
        if (!anchor) {
          node.set('interval', 3600);
          node.set('health-check', doc.createNode({ enable: true, url: 'https://cp.cloudflare.com', interval: 300, timeout: 5000 }));
        }
        node.set('path', info.dir + name + '.yaml');
        if (op.join !== false) joinProvider(doc, data, name);
      }
    }
    for (const field of info.fields) {
      const id = field.key.join('.');
      if (!(id in values)) continue;
      const value = normalizeValue(field, values[id]);
      const path = [info.key, name].concat(field.key);
      if (value === null) {
        if (field.required) throw new Error(field.label + ' 不能为空');
        deleteIn(doc, path);
      } else setIn(doc, path, value);
    }
    if (kind === 'ruleProvider') {
      const item = plain(doc)[info.key][name];
      if (item.behavior === 'classical' && item.format === 'mrs') throw new Error('mrs 格式不支持 classical 类型');
      if (!item.behavior) setIn(doc, [info.key, name, 'behavior'], 'domain');
      const extension = item.format === 'mrs' ? '.mrs' : item.format === 'text' ? '.list' : '.yaml';
      setIn(doc, [info.key, name, 'path'], info.dir + name + extension);
    }
    const final = plain(doc)[info.key][name];
    if (!final.url) throw new Error('链接不能为空');
  }

  // 新订阅加入「引用了全部订阅」的策略组（与 LuCI join_groups 一致）。
  function joinProvider(doc, data, name) {
    const all = Object.keys(isObject(data['proxy-providers']) ? data['proxy-providers'] : {});
    if (!all.length) return;
    visitUseLists(doc, (seq) => {
      const names = seq.items.map((item) => (Y.isScalar(item) ? String(item.value) : ''));
      if (all.every((provider) => names.includes(provider)) && !names.includes(name)) seq.add(doc.createNode(name));
    });
  }

  function unlinkProvider(doc, data, name) {
    visitUseLists(doc, (seq) => {
      seq.items = seq.items.filter((item) => !(Y.isScalar(item) && String(item.value) === name));
    });
    void data;
  }

  function visitUseLists(doc, visit) {
    const seen = new Set();
    Y.visit(doc, {
      Pair(_, pair) {
        if (Y.isScalar(pair.key) && pair.key.value === 'use' && Y.isSeq(pair.value) && !seen.has(pair.value)) {
          seen.add(pair.value);
          visit(pair.value);
        }
      },
    });
  }

  // ---------- Tailscale ----------
  // add：追加出站，在开头的 DST-PORT 规则（DNS 接管）之后插入 Tailnet 地址段规则，并让 eBPF 不在内核直连这些地址。
  // delete：同时删掉指向它的规则与策略组成员；没有其它 Tailscale 出站时撤回 bypass-exclude。

  function ruleTarget(rule) {
    const parts = String(rule).split(',').map((part) => part.trim());
    while (parts.length > 2 && /^(no-resolve|src)$/i.test(parts[parts.length - 1])) parts.pop();
    return parts[parts.length - 1];
  }

  function tailnetRules(name) {
    return ['IP-CIDR,100.64.0.0/10,' + name + ',no-resolve', 'IP-CIDR6,fd7a:115c:a1e0::/48,' + name + ',no-resolve'];
  }

  function tailnetExclude(doc, data, present) {
    const index = ebpfIndex(data);
    if (index < 0) return;
    const listener = data.listeners[index];
    for (const role of ['local', 'shared']) {
      if (!isObject(listener[role])) continue;
      const current = Array.isArray(listener[role]['bypass-exclude']) ? listener[role]['bypass-exclude'] : [];
      const next = present ? current.concat(TAILNET_CIDRS.filter((cidr) => !current.includes(cidr))) : current.filter((cidr) => !TAILNET_CIDRS.includes(cidr));
      if (next.length === current.length && next.every((value, position) => value === current[position])) continue;
      const path = ['listeners', index, role, 'bypass-exclude'];
      if (next.length) setIn(doc, path, next); else deleteIn(doc, path);
    }
  }

  function applyTailscale(doc, data, op) {
    const action = op.op.split('.')[1];
    const name = String(op.name == null ? '' : op.name).trim();
    const values = isObject(op.values) ? op.values : {};
    const existing = tailscaleList(data);
    if (action === 'add') {
      if (!TAILSCALE_NAME.test(name)) throw new Error('名称只能包含字母、数字、_ . -，最长 64 个字符');
      if (policies(data).includes(name) || (isObject(data['proxy-providers']) && name in data['proxy-providers'])) throw new Error('名称已被占用：' + name);
      if (data.proxies != null && !Array.isArray(data.proxies)) throw new Error('proxies 不是列表，请在配置原文中修改');
      if (data.rules != null && !Array.isArray(data.rules)) throw new Error('rules 不是列表，请在配置原文中修改');
      if (!Y.isSeq(doc.get('proxies', true))) doc.set('proxies', doc.createNode([]));
      const node = doc.createNode({ name, type: 'tailscale', udp: true });
      node.flow = false;
      doc.get('proxies', true).add(node);
      if (!Y.isSeq(doc.get('rules', true))) doc.set('rules', doc.createNode([]));
      const rules = doc.get('rules', true);
      let position = 0;
      while (position < rules.items.length && Y.isScalar(rules.items[position]) && /^DST-PORT\s*,/i.test(String(rules.items[position].value).trim())) position++;
      rules.items.splice(position, 0, ...tailnetRules(name).map((rule) => doc.createNode(rule)));
      tailnetExclude(doc, plain(doc), true);
    } else if (!existing.some((item) => item.name === name)) {
      throw new Error('Tailscale 出站不存在：' + name);
    } else if (action === 'delete') {
      const usesDns = (value) => typeof value === 'string' ? value === 'ts://' + name || value.startsWith('ts://' + name + '#')
        : Array.isArray(value) ? value.some(usesDns) : isObject(value) ? Object.values(value).some(usesDns) : false;
      if (usesDns(data.dns)) throw new Error('DNS 仍在使用 ts://' + name + '，请先在配置原文中删除');
      const proxies = doc.get('proxies', true);
      proxies.items = proxies.items.filter((node) => !(Y.isMap(node) && node.get('name') === name));
      const rules = doc.get('rules', true);
      if (Y.isSeq(rules)) rules.items = rules.items.filter((node) => !(Y.isScalar(node) && ruleTarget(node.value) === name));
      const seen = new Set();
      Y.visit(doc, {
        Pair(_, pair) {
          if (!Y.isScalar(pair.key) || pair.key.value !== 'proxies' || !Y.isSeq(pair.value) || seen.has(pair.value) || pair.value === proxies) return;
          seen.add(pair.value);
          const before = pair.value.items.length;
          pair.value.items = pair.value.items.filter((item) => !(Y.isScalar(item) && String(item.value) === name));
          if (before && !pair.value.items.length) throw new Error('有策略组只包含 ' + name + '，请先在配置原文中给它换一个出站');
        },
      });
      if (existing.length === 1) tailnetExclude(doc, plain(doc), false);
      return;
    }
    const index = plain(doc).proxies.findIndex((item) => isObject(item) && item.type === 'tailscale' && item.name === name);
    if (action === 'serve') {
      // 替换用户的 serve 转发，保留网页管理那一条
      const current = plain(doc).proxies[index];
      const webui = (Array.isArray(current.serve) ? current.serve : []).filter((entry) => isObject(entry) && entry.target === WEBUI_SERVE_TARGET);
      const list = webui.concat(normalizeServe(op.serve, webui.length > 0));
      if (list.length) setIn(doc, ['proxies', index, 'serve'], list); else deleteIn(doc, ['proxies', index, 'serve']);
      return;
    }
    if (action === 'webui') {
      // 只有一个出站发布网页管理：开启时先从其它出站上撤掉
      if (typeof op.enable !== 'boolean') throw new Error('enable 必须为布尔值');
      plain(doc).proxies.forEach((item, position) => {
        if (!isObject(item) || item.type !== 'tailscale' || !Array.isArray(item.serve)) return;
        if (position === index && op.enable) return;
        const rest = item.serve.filter((entry) => !(isObject(entry) && entry.target === WEBUI_SERVE_TARGET));
        if (rest.length === item.serve.length) return;
        if (rest.length) setIn(doc, ['proxies', position, 'serve'], rest); else deleteIn(doc, ['proxies', position, 'serve']);
      });
      if (op.enable) {
        const current = plain(doc).proxies[index];
        const serve = Array.isArray(current.serve) ? current.serve : [];
        if (serve.some((entry) => isObject(entry) && Number(entry.port) === WEBUI_SERVE_PORT && entry.target !== WEBUI_SERVE_TARGET)) {
          throw new Error(name + ' 的 serve 已占用 80 端口，请在配置原文中调整');
        }
        if (!serve.some((entry) => isObject(entry) && entry.target === WEBUI_SERVE_TARGET)) {
          setIn(doc, ['proxies', index, 'serve'], serve.concat([{ port: WEBUI_SERVE_PORT, target: WEBUI_SERVE_TARGET }]));
        }
      }
      return;
    }
    for (const field of TAILSCALE_FIELDS) {
      const id = field.key.join('.');
      if (!(id in values)) continue;
      const value = normalizeValue(field, values[id]);
      const path = ['proxies', index].concat(field.key);
      if (value === null) {
        if (field.required) throw new Error(field.label + ' 不能为空');
        deleteIn(doc, path);
      } else {
        if (field.pattern && !field.pattern.test(value)) throw new Error(field.label + field.hint);
        setIn(doc, path, value);
      }
    }
    if (!plain(doc).proxies[index].hostname) throw new Error('设备名不能为空');
  }

  // ---------- 单个节点 ----------
  // 与 LuCI forms.uc 的 proxy.add / proxy.set / proxy.delete 语义一致：
  // 改名时同步策略组成员、规则出站、前置代理、规则集/订阅/入站的 proxy 与 DNS 的 #名称；删除前检查引用。

  // 表单支持的类型（与 shared/proxylink.js 的 PROTOCOLS 一致）；其他类型只列出、可删除
  const NODE_TYPES = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'socks5', 'http', 'wireguard'];
  const MAX_NODES = 256;
  const NODE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

  function nodeName(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 128 || /[,\x00-\x1f\x7f]/.test(value)) return null;
    return value;
  }

  function resolved(doc, node) {
    return Y.isAlias(node) ? node.resolve(doc) : node;
  }

  function ownKey(map, key) {
    return Y.isMap(map) && map.items.some((pair) => Y.isScalar(pair.key) && pair.key.value === key);
  }

  function hasMerge(map) {
    return Y.isMap(map) && map.items.some((pair) => isMergeKey(pair.key));
  }

  // 合并键引用的映射（<<: *a 或 <<: [*a, *b]）
  function mergeSources(doc, map) {
    const out = [];
    for (const pair of Y.isMap(map) ? map.items : []) {
      if (!isMergeKey(pair.key)) continue;
      const values = Y.isSeq(pair.value) ? pair.value.items : [pair.value];
      for (const value of values) {
        const source = resolved(doc, value);
        if (Y.isMap(source)) out.push(source);
      }
    }
    return out;
  }

  function seqItem(doc, key, index) {
    const seq = doc.get(key, true);
    return Y.isSeq(seq) ? resolved(doc, seq.items[index]) : null;
  }

  function nodeLock(doc, item, index) {
    item = isObject(item) ? item : {};
    if (item.type === 'tailscale') return 'Tailscale 出站请在 Tailscale 页管理';
    if (item.type === 'dns') return '内置的 DNS 出站，用于接管 53 端口';
    if (hasMerge(seqItem(doc, 'proxies', index))) return '使用了锚点合并（<<），请在配置原文中编辑';
    if (!NODE_TYPES.includes(item.type)) return '表单暂不支持 ' + (item.type || '?') + ' 类型，请在配置原文中编辑';
    return null;
  }

  // 策略组：auto 为自动包含全部节点（include-all / include-all-proxies）；editable 为能否直接改成员（经锚点继承的不能）
  function nodeGroups(doc, data) {
    const list = Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : [];
    return list.map((group, index) => {
      group = isObject(group) ? group : {};
      const map = seqItem(doc, 'proxy-groups', index);
      const explicit = ownKey(map, 'proxies');
      const auto = group['include-all'] === true || group['include-all-proxies'] === true;
      return {
        index, name: String(group.name || ''), type: String(group.type || ''), auto, explicit,
        editable: explicit || !hasMerge(map),
        members: Array.isArray(group.proxies) ? group.proxies.map(String) : [],
        others: (Array.isArray(group.use) && group.use.length > 0) || auto || group['include-all-providers'] === true,
      };
    });
  }

  // 策略组里实际存放成员的列表（含锚点里的，去重）
  function groupSeqs(doc) {
    const seqs = new Set();
    const groups = doc.get('proxy-groups', true);
    for (const item of Y.isSeq(groups) ? groups.items : []) {
      const map = resolved(doc, item);
      if (!Y.isMap(map)) continue;
      for (const source of [map].concat(mergeSources(doc, map))) {
        const seq = source.get('proxies', true);
        if (Y.isSeq(seq)) { seqs.add(seq); break; }
      }
    }
    return Array.from(seqs);
  }

  function scalarIs(node, name) {
    return Y.isScalar(node) && String(node.value) === name;
  }

  function nodeSchema(doc, data) {
    if (data.proxies != null && !Array.isArray(data.proxies)) return { unsupported: 'proxies 不是列表，请在配置原文中编辑' };
    const groups = nodeGroups(doc, data);
    const list = (Array.isArray(data.proxies) ? data.proxies : []).map((item, index) => {
      const node = isObject(item) ? item : {};
      const lock = nodeLock(doc, node, index);
      const entry = {
        name: String(node.name || ''), type: String(node.type || ''), server: node.server == null ? '' : String(node.server),
        port: node.port == null ? '' : String(node.port), lock: lock || '',
        groups: groups.filter((group) => group.members.includes(String(node.name || ''))).map((group) => group.name),
      };
      if (!lock) entry.data = node;
      return entry;
    });
    return {
      list, types: NODE_TYPES, policies: policies(data),
      groups: groups.map((group) => ({ name: group.name, type: group.type, auto: group.auto, editable: group.editable })),
    };
  }

  function nodes(content) {
    const doc = parse(content);
    return { ok: true, ...nodeSchema(doc, plain(doc)) };
  }

  // 节点字段的通用校验：键名、字符串长度、列表与嵌套深度有上限；协议细节由保存前的 mihomo -t 校验
  function nodeValue(value, depth) {
    if (typeof value === 'string') return value.length <= 4096 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) ? value : undefined;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (depth >= 4) return undefined;
    if (Array.isArray(value)) {
      if (value.length > 64) return undefined;
      const out = [];
      for (const entry of value) {
        const checked = nodeValue(entry, depth + 1);
        if (checked === undefined) return undefined;
        out.push(checked);
      }
      return out;
    }
    if (isObject(value)) {
      const keys = Object.keys(value);
      if (keys.length > 64) return undefined;
      const out = {};
      for (const key of keys) {
        if (!NODE_KEY.test(key)) return undefined;
        const checked = nodeValue(value[key], depth + 1);
        if (checked === undefined) return undefined;
        out[key] = checked;
      }
      return out;
    }
    return undefined;
  }

  function checkNode(item) {
    if (!isObject(item)) throw new Error('节点无效');
    const name = nodeName(item.name);
    if (name === null) throw new Error('节点名称无效：不能为空、首尾不能有空格、不能包含英文逗号，最长 128 个字符');
    if (!NODE_TYPES.includes(item.type)) throw new Error('节点「' + name + '」的类型不支持：' + (item.type || ''));
    if (typeof item.server !== 'string' || !item.server || item.server.length > 255 || /\s/.test(item.server)) throw new Error('节点「' + name + '」的服务器地址无效');
    let port;
    try { port = check.port(item.port); } catch (error) { throw new Error('节点「' + name + '」的端口无效'); }
    const value = nodeValue(item, 0);
    if (value === undefined) throw new Error('节点「' + name + '」包含无效的字段');
    // 名称与类型放在最前面，便于阅读
    value.port = port;
    const out = { name, type: item.type };
    for (const [key, entry] of Object.entries(value)) if (key !== 'name' && key !== 'type') out[key] = entry;
    return out;
  }

  function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
    if (isObject(a) || isObject(b)) {
      if (!isObject(a) || !isObject(b)) return false;
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
    }
    return a === b;
  }

  function nodeIndex(data, name) {
    return (Array.isArray(data.proxies) ? data.proxies : []).findIndex((item) => isObject(item) && item.name === name);
  }

  // 被占用的名称：节点、策略组、内置策略与订阅
  function takenNames(data) {
    return policies(data).concat(Object.keys(isObject(data['proxy-providers']) ? data['proxy-providers'] : {}));
  }

  function dnsHit(value, name) {
    if (typeof value === 'string') return value.endsWith('#' + name);
    if (Array.isArray(value)) return value.some((entry) => dnsHit(entry, name));
    if (isObject(value)) return Object.values(value).some((entry) => dnsHit(entry, name));
    return false;
  }

  // 指向 name 的引用（中文说明）
  function policyRefs(data, name) {
    const refs = [];
    const each = (value) => (Array.isArray(value) ? value : []).filter(isObject);
    (Array.isArray(data.rules) ? data.rules : []).forEach((rule, index) => {
      if (typeof rule === 'string' && ruleTarget(rule) === name) refs.push('规则第 ' + (index + 1) + ' 条');
    });
    for (const item of each(data.proxies)) if (item['dialer-proxy'] === name) refs.push('节点 ' + item.name + ' 的前置代理');
    for (const item of each(data['proxy-groups'])) if (item['dialer-proxy'] === name) refs.push('策略组 ' + item.name + ' 的前置代理');
    for (const [key, item] of Object.entries(isObject(data['rule-providers']) ? data['rule-providers'] : {})) {
      if (isObject(item) && item.proxy === name) refs.push('规则集 ' + key + ' 的下载方式');
    }
    for (const [key, item] of Object.entries(isObject(data['proxy-providers']) ? data['proxy-providers'] : {})) {
      if (isObject(item) && (item.proxy === name || (isObject(item.override) && item.override['dialer-proxy'] === name))) refs.push('订阅 ' + key);
    }
    for (const item of each(data.listeners)) if (item.proxy === name) refs.push('入站 ' + (item.name || item.type) + ' 的出站');
    if (dnsHit(data.dns, name)) refs.push('DNS 服务器');
    return refs;
  }

  // 规则字符串的出站改名（AND/OR 等逻辑规则的出站同样是最后一段）
  function ruleRetarget(rule, name) {
    const parts = String(rule).split(',').map((part) => part.trim());
    let index = parts.length - 1;
    while (index > 1 && /^(no-resolve|src)$/i.test(parts[index])) index--;
    parts[index] = name;
    return parts.join(',');
  }

  // 改名：只改标量的值，保留注释与格式
  function renameRefs(doc, old, name) {
    for (const seq of groupSeqs(doc)) for (const item of seq.items) if (scalarIs(item, old)) item.value = name;
    const rules = doc.get('rules', true);
    for (const item of Y.isSeq(rules) ? rules.items : []) {
      if (Y.isScalar(item) && typeof item.value === 'string' && ruleTarget(item.value) === old) item.value = ruleRetarget(item.value, name);
    }
    Y.visit(doc, {
      Pair(_, pair) {
        if (Y.isScalar(pair.key) && (pair.key.value === 'dialer-proxy' || pair.key.value === 'proxy') && scalarIs(pair.value, old)) pair.value.value = name;
      },
    });
    const dns = doc.get('dns', true);
    if (dns) {
      Y.visit(dns, {
        Scalar(_, node) {
          if (typeof node.value === 'string' && node.value.endsWith('#' + old)) node.value = node.value.slice(0, -old.length) + name;
        },
      });
    }
  }

  // 按勾选的策略组调整成员：groups 为希望包含 name 的策略组；自动包含全部节点的组不改。
  // 加入时追加到 proxies 末尾（组里还没有时新建）；移出时组里不能因此没有任何出站
  function applyMembership(doc, name, groups, joinOnly) {
    if (groups == null) return;
    if (!Array.isArray(groups)) throw new Error('策略组列表无效');
    const all = nodeGroups(doc, plain(doc));
    for (const group of groups) {
      if (typeof group !== 'string' || !all.some((entry) => entry.name === group)) throw new Error('策略组不存在：' + group);
    }
    for (const group of all) {
      if (group.auto) continue;
      const want = groups.includes(group.name);
      const current = group.members.includes(name);
      if (want === current || (joinOnly && !want)) continue;
      if (!group.editable) throw new Error('策略组「' + group.name + '」的成员继承自锚点，请在配置原文中编辑');
      const map = seqItem(doc, 'proxy-groups', group.index);
      if (want) {
        const seq = map.get('proxies', true);
        if (Y.isSeq(seq)) seq.add(doc.createNode(name));
        else setIn(doc, ['proxy-groups', group.index, 'proxies'], [name]);
      } else {
        const left = group.members.filter((member) => member !== name);
        if (!left.length && !group.others) throw new Error('策略组「' + group.name + '」只剩这个节点，移出后没有可用出站');
        const seq = map.get('proxies', true);
        seq.items = seq.items.filter((item) => !scalarIs(item, name));
        if (!seq.items.length) map.delete('proxies');
      }
    }
  }

  function applyProxy(doc, data, op) {
    const action = op.op.split('.')[1];
    if (data.proxies != null && !Array.isArray(data.proxies)) throw new Error('proxies 不是列表，请在配置原文中编辑');
    if (action === 'add') {
      const list = op.nodes;
      if (!Array.isArray(list) || !list.length || list.length > MAX_NODES) throw new Error('一次添加 1–' + MAX_NODES + ' 个节点');
      if ((Array.isArray(data.proxies) ? data.proxies.length : 0) + list.length > 4096) throw new Error('节点过多');
      const taken = new Set(takenNames(data));
      const add = list.map((item) => {
        const node = checkNode(item);
        if (taken.has(node.name)) throw new Error('名称已被占用：' + node.name);
        taken.add(node.name);
        return node;
      });
      if (!Y.isSeq(doc.get('proxies', true))) doc.set('proxies', doc.createNode([]));
      const seq = doc.get('proxies', true);
      seq.flow = false;
      for (const node of add) seq.add(doc.createNode(node));
      for (const node of add) applyMembership(doc, node.name, op.groups, true);
      return;
    }
    const index = nodeIndex(data, op.name);
    if (typeof op.name !== 'string' || index < 0) throw new Error('节点不存在：' + (op.name || ''));
    const current = data.proxies[index];
    if (action === 'delete') {
      if (current.type === 'tailscale' || current.type === 'dns') throw new Error(nodeLock(doc, current, index));
      const refs = policyRefs(data, op.name);
      if (refs.length) throw new Error('节点「' + op.name + '」正在被使用：' + refs.join('、') + '。请先改成别的出站');
      dropMember(doc, data, op.name);
      doc.get('proxies', true).delete(index);
      return;
    }
    if (action !== 'set') throw new Error('不支持的修改：' + op.op);
    const lock = nodeLock(doc, current, index);
    if (lock) throw new Error(lock);
    const node = checkNode(op.data);
    if (node.name !== op.name) {
      if (takenNames(data).includes(node.name)) throw new Error('名称已被占用：' + node.name);
      renameRefs(doc, op.name, node.name);
    }
    if (!sameValue(current, node)) doc.get('proxies', true).set(index, doc.createNode(node));
    applyMembership(doc, node.name, op.groups, false);
  }

  // 分享链接解析与节点表单（shared/proxylink.js）
  function linkLib() {
    const lib = root.mihomoProxyLink;
    if (!lib) throw new Error('节点解析模块未加载，请重新安装完整模块');
    return lib;
  }

  function nodeParse(text, taken) {
    const lib = linkLib();
    const result = lib.parseText(String(text || ''), Array.isArray(taken) ? taken.map(String) : []);
    return { ok: true, nodes: result.nodes.map((node) => ({ node, summary: lib.summary(node) })), errors: result.errors };
  }

  // 某类型的表单：字段说明 + 当前值（输入框文字；布尔为 true/false）
  function nodeForm(type, node) {
    const lib = linkLib();
    const fields = lib.fields(type).map(formField);
    const values = lib.formValues(isObject(node) ? node : {}, type);
    const known = new Set(lib.fields(type).map((field) => field.key.split('.')[0]));
    const extra = isObject(node) ? Object.keys(node).filter((key) => !known.has(key) && key !== 'type') : [];
    return { ok: true, types: lib.PROTOCOLS.map((item) => ({ id: item.type, title: item.label })), fields, values, extra };
  }

  function nodeBuild(base, type, values) {
    const result = linkLib().buildNode(isObject(base) ? base : {}, String(type || ''), isObject(values) ? values : {});
    if (result.error) throw new Error(result.error);
    return { ok: true, node: result.node, summary: linkLib().summary(result.node) };
  }

  // ---------- 策略组 ----------
  // 与 LuCI forms.uc 的 group.add / group.set / group.delete / group.move 语义一致：
  // 改名时同步规则、其他组的成员与前置代理等引用；删除前检查引用与锚点继承；经锚点继承的字段不能在表单里删除。

  // 与 shared/proxylink.js 的 GROUP_TYPES 一致；relay 已被内核移除
  const GROUP_TYPES = ['select', 'smart', 'url-test', 'fallback', 'load-balance'];
  const MAX_GROUPS = 512;

  function groupList(data) {
    return Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : [];
  }

  function groupIndex(data, name) {
    return groupList(data).findIndex((item) => isObject(item) && item.name === name);
  }

  // 通过 <<: *锚点 继承第 index 个组的其他组
  function groupHeirs(doc, data, index) {
    const map = seqItem(doc, 'proxy-groups', index);
    const seq = doc.get('proxy-groups', true);
    const out = [];
    (Y.isSeq(seq) ? seq.items : []).forEach((item, i) => {
      if (i !== index && mergeSources(doc, resolved(doc, item)).includes(map)) out.push(String((groupList(data)[i] || {}).name || ''));
    });
    return out;
  }

  // 继承自锚点（而非组里直接写）的字段
  function groupInherited(map, value) {
    return hasMerge(map) ? Object.keys(value).filter((key) => !ownKey(map, key)) : [];
  }

  function groupLock(doc, item, index) {
    if (!Y.isMap(seqItem(doc, 'proxy-groups', index))) return '格式无法识别，请在配置原文中编辑';
    if (!GROUP_TYPES.includes(item.type)) return '表单不支持 ' + (item.type || '?') + ' 类型，请在配置原文中编辑';
    return '';
  }

  // 表单字段说明（节点与策略组共用）
  function formField(field) {
    const option = (entry) => (Array.isArray(entry) ? { id: String(entry[0]), title: String(entry[1]) } : { id: String(entry), title: entry === '' ? '默认' : String(entry) });
    return {
      key: field.key, label: field.label, kind: field.kind, required: !!field.required, adv: !!field.adv,
      help: field.help || '', placeholder: field.placeholder || '', options: (field.options || []).map(option),
      when: field.when ? { key: field.when.key, in: field.when.in.map((value) => (value === true ? 'true' : String(value))) } : null,
    };
  }

  function groupSchema(doc, data) {
    if (data['proxy-groups'] != null && !Array.isArray(data['proxy-groups'])) return { unsupported: 'proxy-groups 不是列表，请在配置原文中编辑' };
    const lib = root.mihomoProxyLink;
    const all = groupList(data);
    const list = all.map((item, index) => {
      const value = isObject(item) ? item : {};
      const name = String(value.name || '');
      return {
        name, type: String(value.type || ''), lock: groupLock(doc, value, index),
        summary: lib ? lib.groupSummary(value) : String(value.type || ''),
        data: value, values: lib ? lib.groupValues(value) : {},
        inherited: groupInherited(seqItem(doc, 'proxy-groups', index), value),
        heirs: groupHeirs(doc, data, index), refs: policyRefs(data, name),
        memberOf: all.filter((group) => isObject(group) && Array.isArray(group.proxies) && group.proxies.includes(name)).map((group) => String(group.name || '')),
      };
    });
    const proxies = (Array.isArray(data.proxies) ? data.proxies : []).filter((item) => isObject(item) && item.type !== 'dns')
      .map((item) => String(item.name || '')).filter(Boolean);
    return {
      list, proxies, builtin: BUILTIN_POLICIES.slice(),
      providers: Object.keys(isObject(data['proxy-providers']) ? data['proxy-providers'] : {}),
      types: lib ? lib.GROUP_TYPES.map((type) => ({ id: type.type, title: type.label, help: type.help })) : [],
      fields: lib ? lib.GROUP_FIELDS.map(formField) : [],
      defaults: lib ? lib.groupValues({}) : {},
    };
  }

  // 校验并整理一个策略组；self 为修改前的名称（新增时为 null）
  function checkGroupData(data, value, self) {
    if (!isObject(value)) throw new Error('策略组无效');
    if (Object.keys(value).some((key) => key === '<<')) throw new Error('不支持合并键（<<），请在配置原文中编辑');
    const group = nodeValue(value, 0);
    if (group === undefined) throw new Error('策略组包含无效的字段');
    const error = linkLib().checkGroup(group);
    if (error) throw new Error(error);
    if (!GROUP_TYPES.includes(group.type)) throw new Error('不支持的类型：' + group.type);
    if (group.name !== self && takenNames(data).includes(group.name)) throw new Error('名称已被占用：' + group.name);
    const known = policies(data);
    const members = group.proxies == null ? [] : group.proxies;
    if (!Array.isArray(members)) throw new Error('成员必须是列表');
    for (const member of members) {
      if (member === self) throw new Error('成员里不能包含自己');
      if (typeof member !== 'string' || !known.includes(member)) throw new Error('成员不存在：' + member);
    }
    const providers = Object.keys(isObject(data['proxy-providers']) ? data['proxy-providers'] : {});
    const use = group.use == null ? [] : group.use;
    if (!Array.isArray(use)) throw new Error('订阅必须是列表');
    for (const name of use) if (typeof name !== 'string' || !providers.includes(name)) throw new Error('订阅不存在：' + name);
    const out = { name: group.name, type: group.type };
    for (const [key, entry] of Object.entries(group)) if (key !== 'name' && key !== 'type') out[key] = entry;
    return out;
  }

  // 从所有策略组的成员列表里移除 name；组里只剩它且没有订阅等其他来源时拒绝
  function dropMember(doc, data, name) {
    const groups = nodeGroups(doc, data);
    for (const seq of groupSeqs(doc)) {
      const left = seq.items.filter((item) => !scalarIs(item, name));
      if (left.length === seq.items.length) continue;
      if (!left.length) {
        const owners = groups.filter((group) => { const map = seqItem(doc, 'proxy-groups', group.index); return Y.isMap(map) && map.get('proxies', true) === seq; });
        if (!owners.length || owners.some((group) => !group.others)) throw new Error('有策略组只包含「' + name + '」，请先给它换一个出站');
        for (const group of owners) seqItem(doc, 'proxy-groups', group.index).delete('proxies');
      } else seq.items = left;
    }
  }

  // 用到锚点的组必须排在定义锚点的组后面；order 为移动后的映射顺序（移动前解析，移动后别名可能已无法解析）
  function checkAnchorOrder(doc, items) {
    items.forEach((map, i) => {
      for (const source of mergeSources(doc, map)) {
        if (items.indexOf(source) > i) throw new Error('策略组「' + String(map.get('name')) + '」继承了排在它后面的组，锚点必须先定义，不能这样排序');
      }
    });
  }

  function applyGroup(doc, data, op) {
    const action = op.op.split('.')[1];
    if (data['proxy-groups'] != null && !Array.isArray(data['proxy-groups'])) throw new Error('proxy-groups 不是列表，请在配置原文中编辑');
    if (action === 'add') {
      const group = checkGroupData(data, op.data, null);
      if (groupList(data).length >= MAX_GROUPS) throw new Error('策略组过多');
      if (!Y.isSeq(doc.get('proxy-groups', true))) doc.set('proxy-groups', doc.createNode([]));
      const seq = doc.get('proxy-groups', true);
      seq.flow = false;
      seq.add(doc.createNode(group));
      return;
    }
    const index = groupIndex(data, op.name);
    if (typeof op.name !== 'string' || index < 0) throw new Error('策略组不存在：' + (op.name || ''));
    const current = data['proxy-groups'][index];
    const map = seqItem(doc, 'proxy-groups', index);
    if (!Y.isMap(map)) throw new Error(groupLock(doc, current, index));
    if (action === 'move') {
      const seq = doc.get('proxy-groups', true);
      if (!Number.isInteger(op.to) || op.to < 0 || op.to >= seq.items.length) throw new Error('位置无效');
      const order = seq.items.map((item) => resolved(doc, item));
      order.splice(op.to, 0, order.splice(index, 1)[0]);
      checkAnchorOrder(doc, order);
      const [item] = seq.items.splice(index, 1);
      seq.items.splice(op.to, 0, item);
      return;
    }
    if (action === 'delete') {
      const heirs = groupHeirs(doc, data, index);
      if (heirs.length) throw new Error('策略组「' + op.name + '」被 ' + heirs.join('、') + ' 通过锚点继承，不能删除，请在配置原文中修改');
      const refs = policyRefs(data, op.name);
      if (refs.length) throw new Error('策略组「' + op.name + '」正在被使用：' + refs.join('、') + '。请先改成别的出站');
      dropMember(doc, data, op.name);
      doc.get('proxy-groups', true).delete(index);
      return;
    }
    if (action !== 'set') throw new Error('不支持的修改：' + op.op);
    const lock = groupLock(doc, current, index);
    if (lock) throw new Error(lock);
    const group = checkGroupData(data, op.data, op.name);
    const inherited = groupInherited(map, current);
    for (const key of Object.keys(current)) {
      if (key in group) continue;
      if (inherited.includes(key)) throw new Error('「' + key + '」继承自锚点，不能在这里删除，请在配置原文中修改');
      map.delete(key);
    }
    // 只改有变化的字段，保留其余字段的注释与格式
    for (const [key, value] of Object.entries(group)) if (!sameValue(current[key], value)) map.set(key, doc.createNode(value));
    if (group.name !== op.name) renameRefs(doc, op.name, group.name);
  }

  function groupBuild(base, values) {
    const result = linkLib().buildGroup(isObject(base) ? base : {}, isObject(values) ? values : {});
    if (result.error) throw new Error(result.error);
    return { ok: true, group: result.group, summary: linkLib().groupSummary(result.group) };
  }

  // ---------- 规则 ----------
  // 与 LuCI forms.uc 的 rules.set 一致：items 为 [{k}|{k,v}|{v}]，k 为原下标（保留该条的注释），v 为新文本

  const MAX_RULES = 20000;

  function ruleSchema(data) {
    const rules = data.rules;
    if (rules != null && !Array.isArray(rules)) return { unsupported: 'rules 不是列表，请在配置原文中编辑' };
    if ((rules || []).some((rule) => typeof rule !== 'string')) return { unsupported: 'rules 里有不是文字的条目，请在配置原文中编辑' };
    return { list: rules || [], policies: policies(data), ruleSets: Object.keys(isObject(data['rule-providers']) ? data['rule-providers'] : {}) };
  }

  function ruleText(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || text.length > 4096 || !text.includes(',') || /[\x00-\x1f\x7f]/.test(text)) return null;
    return text;
  }

  function applyRules(doc, data, op) {
    const schema = ruleSchema(data);
    if (schema.unsupported) throw new Error(schema.unsupported);
    if (!Array.isArray(op.items) || op.items.length > MAX_RULES) throw new Error('规则列表无效');
    const seq = doc.get('rules', true);
    const current = Y.isSeq(seq) ? seq.items : [];
    const used = new Set();
    const items = op.items.map((item) => {
      if (!isObject(item) || (item.k == null && item.v == null)) throw new Error('规则列表无效');
      const k = item.k;
      if (k != null && (!Number.isInteger(k) || k < 0 || k >= current.length || used.has(k))) throw new Error('规则列表与当前配置不一致，请重新读取');
      if (k != null) used.add(k);
      if (item.v == null) return current[k];
      const text = ruleText(item.v);
      if (text === null) throw new Error('规则格式无效：' + String(item.v));
      if (k == null) return doc.createNode(text);
      // 改原有的一条：只换文字，保留它的注释
      const node = current[k];
      if (Y.isScalar(node)) {
        if (node.value !== text) node.value = text;
        return node;
      }
      return doc.createNode(text);
    });
    if (!Y.isSeq(seq)) {
      if (!items.length) return;
      doc.set('rules', doc.createNode([]));
    }
    const target = doc.get('rules', true);
    if (items.length === current.length && items.every((item, index) => item === current[index])) return;
    // 第一条规则上方的注释记在列表上，随原来的第一条一起移动
    if (target.commentBefore && current.length && items[0] !== current[0] && Y.isNode(current[0])) {
      current[0].commentBefore = current[0].commentBefore ? target.commentBefore + String.fromCharCode(10) + current[0].commentBefore : target.commentBefore;
      target.commentBefore = undefined;
    }
    target.items = items;
  }

  // ---------- 分析 ----------

  function looksLikeSubscription(text) {
    const trimmed = text.trim();
    if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 64 && !/:\s/.test(trimmed)) return true;
    const lines = trimmed.split(/\n/).filter(Boolean);
    return lines.length > 0 && lines.every((line) => /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|anytls|wireguard|socks5?|https?):\/\//i.test(line.trim()));
  }

  function summarize(doc, data) {
    const listeners = Array.isArray(data.listeners) ? data.listeners : [];
    const ebpf = listeners.filter((item) => isObject(item) && item.type === 'ebpf');
    const rules = Array.isArray(data.rules) ? data.rules : [];
    const providers = isObject(data['proxy-providers']) ? Object.keys(data['proxy-providers']) : [];
    return {
      proxies: (Array.isArray(data.proxies) ? data.proxies : []).filter((item) => isObject(item) && item.type !== 'dns').length,
      providers: providers.length,
      providerNames: providers.slice(0, 16),
      groups: (Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : []).length,
      rules: rules.length,
      ruleProviders: isObject(data['rule-providers']) ? Object.keys(data['rule-providers']).length : 0,
      mode: String(data.mode || 'rule'),
      ebpf: ebpf.length === 1 && listeners.length === 1,
      listeners: listeners.length,
      tun: !!(isObject(data.tun) && data.tun.enable),
      dns: !!(isObject(data.dns) && data.dns.enable),
      dnsMode: isObject(data.dns) ? String(data.dns['enhanced-mode'] || '') : '',
      controller: typeof data['external-controller'] === 'string' ? data['external-controller'] : '',
      anchors: doc ? countAnchors(doc) : 0,
    };
  }

  function countAnchors(doc) {
    let count = 0;
    Y.visit(doc, { Node(_, node) { if (node.anchor) count++; } });
    return count;
  }

  function analyze(content) {
    const text = String(content == null ? '' : content);
    if (!text.trim()) throw new Error('内容为空');
    if (looksLikeSubscription(text)) {
      return { ok: true, kind: 'subscription', message: '这是节点订阅而不是完整配置，可作为订阅加入内置模板。' };
    }
    const doc = parse(text);
    const data = plain(doc);
    const summary = summarize(doc, data);
    const full = summary.proxies + summary.providers > 0 || summary.groups > 0 || summary.rules > 0;
    return { ok: true, kind: full ? 'config' : 'partial', summary,
      message: full ? '' : '没有找到节点、订阅、策略组或规则，导入后可能无法上网。' };
  }

  // ---------- 本机优化 ----------
  // host: { ipv6, interfaces:[name], memMb, sdk, mirror }
  // options.skip: [id]。返回 changes: [{id, title, detail, optional}]，content 为应用了未跳过项后的结果。

  function hasRuleType(rules, pattern) {
    return rules.some((rule) => typeof rule === 'string' && pattern.test(rule));
  }

  // 旧写法（与 LuCI ebpf_normalize 一致）：顶层 dns-mode / bypass-private-address 作为各角色缺省值，ipv6-mode 换成 ipv6。
  const LISTENER_LEGACY = ['dns-mode', 'bypass-private-address', 'ipv6-mode', 'tcp-splice'];

  function legacyListenerKeys(listener) {
    if (!isObject(listener)) return [];
    const keys = LISTENER_LEGACY.filter((key) => listener[key] !== undefined);
    for (const role of ['local', 'shared']) if (isObject(listener[role]) && listener[role]['ipv6-mode'] !== undefined) keys.push(role + '.ipv6-mode');
    return keys;
  }

  function tailnetPresent(data) {
    const proxies = Array.isArray(data.proxies) ? data.proxies : [];
    return proxies.some((item) => isObject(item) && item.type === 'tailscale');
  }

  const TAILNET_CIDRS = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

  function buildListener(data, current, host) {
    const ipcidr = Object.entries(isObject(data['rule-providers']) ? data['rule-providers'] : {})
      .filter(([, item]) => isObject(item) && item.behavior === 'ipcidr').map(([name]) => name);
    const base = isObject(current) ? current : {};
    const tailnet = tailnetPresent(data);
    const role = (name, defaults) => {
      const source = isObject(base[name]) ? base[name] : {};
      const result = Object.assign({}, defaults);
      for (const key of ['dns-mode', 'bypass-private-address']) if (base[key] !== undefined) result[key] = base[key];
      for (const [key, value] of Object.entries(source)) {
        if (['enable', 'enabled', 'interface', 'exclude-package', 'ipv6-mode'].includes(key)) continue;
        result[key] = value;
      }
      if (source['ipv6-mode'] !== undefined && source.ipv6 === undefined) result.ipv6 = source['ipv6-mode'] !== 'off';
      // 本机 DNS 由模块按「应用绕过」策略生成（respect_policy），这里不保留
      if (name === 'local') delete result['dns-mode'];
      if (host && host.ipv6 === false) result.ipv6 = false;
      // 有 Tailscale 出站时，Tailnet 地址段必须进入 mihomo，不能当作私网在内核直连
      if (tailnet) {
        const exclude = Array.isArray(result['bypass-exclude']) ? result['bypass-exclude'].slice() : [];
        for (const cidr of TAILNET_CIDRS) if (!exclude.includes(cidr)) exclude.push(cidr);
        result['bypass-exclude'] = exclude;
      }
      return result;
    };
    const listener = { name: String(base.name || 'ebpf-in'), type: 'ebpf' };
    listener.network = Array.isArray(base.network) && base.network.length ? base.network : ['tcp', 'udp'];
    listener['udp-timeout'] = Number.isInteger(base['udp-timeout']) ? base['udp-timeout'] : 300;
    const bypass = Array.isArray(base['bypass-rule-set']) ? base['bypass-rule-set'].filter((name) => ipcidr.includes(name))
      : ipcidr.filter((name) => /^(cn|cn-?ip|china.?ip|cncidr|geoip-cn)$/i.test(name));
    if (bypass.length) listener['bypass-rule-set'] = bypass;
    for (const key of ['fakeip-icmp', 'bypass-tun-direct', 'tc-priority']) if (base[key] !== undefined) listener[key] = base[key];
    listener.local = role('local', { 'data-plane': 'cgroup', ipv6: true, 'bypass-private-address': true });
    listener.shared = role('shared', { 'data-plane': 'packet_rewrite', 'dns-mode': 'hijack', ipv6: true, 'bypass-private-address': true });
    return listener;
  }

  function optimize(content, host, options) {
    const doc = parse(content);
    const skip = new Set(options && Array.isArray(options.skip) ? options.skip : []);
    const info = host || {};
    const changes = [];
    const step = (id, title, detail, optional, run) => {
      changes.push({ id, title, detail, optional: optional !== false, applied: !skip.has(id) || optional === false });
      if (!skip.has(id) || optional === false) run();
    };
    let data = plain(doc);
    const rules = Array.isArray(data.rules) ? data.rules : [];
    const refresh = () => { data = plain(doc); };

    // 1. eBPF listener：模块唯一的透明代理入口（必需）。
    const listeners = Array.isArray(data.listeners) ? data.listeners : [];
    const ebpf = listeners.filter((item) => isObject(item) && item.type === 'ebpf');
    const listenerNode = doc.get('listeners', true);
    let listenerFlow = false;
    if (Y.isSeq(listenerNode)) {
      // policy-yaml.awk 要求 listener 与 local/shared 为块映射，且不含锚点/别名；流式列表可以保留。
      Y.visit(listenerNode, {
        Map(_, node) { if (node.flow || node.anchor) listenerFlow = true; },
        Seq(_, node) { if (node.anchor) listenerFlow = true; },
        Scalar(_, node) { if (node.anchor || (typeof node.value === 'string' && node.value.includes('\n'))) listenerFlow = true; },
        Alias() { listenerFlow = true; },
      });
      for (const item of listenerNode.items) {
        if (Y.isMap(item)) for (const pair of item.items) if (isMergeKey(pair.key)) listenerFlow = true;
      }
    }
    const legacy = ebpf.length === 1 ? legacyListenerKeys(ebpf[0]) : [];
    const tailnetMissing = ebpf.length === 1 && tailnetPresent(data) && ['local', 'shared'].some((role) => {
      const exclude = isObject(ebpf[0][role]) && Array.isArray(ebpf[0][role]['bypass-exclude']) ? ebpf[0][role]['bypass-exclude'] : [];
      return !TAILNET_CIDRS.every((cidr) => exclude.includes(cidr));
    });
    const listenerOk = ebpf.length === 1 && listeners.length === 1 && !listenerFlow && !legacy.length && !tailnetMissing;
    if (!listenerOk) {
      const removed = listeners.length - ebpf.length;
      const detail = !ebpf.length ? '新增 eBPF 透明代理入口（本机 cgroup + 共享 packet_rewrite）'
        : legacy.length ? '把旧写法 ' + legacy.join('、') + ' 展开到 local/shared' + (tailnetMissing ? '，并让 Tailnet 地址进入 mihomo' : '')
        : tailnetMissing ? 'Tailnet 地址（100.64.0.0/10）加入 bypass-exclude，避免被当作私网直连'
        : '整理为模块可接管的单个 eBPF listener';
      step('ebpf', ebpf.length ? '规范 eBPF 入站' : '添加 eBPF 入站',
        detail + (removed > 0 ? '，移除 ' + removed + ' 个不适用于手机的 listener' : ''), false, () => {
          const built = buildListener(data, ebpf[0], info);
          const node = doc.createNode([built]);
          node.flow = false;
          Y.visit(node, { Seq(_, seq) { if (seq !== node) seq.flow = true; } });
          doc.set('listeners', node);
          refresh();
        });
    } else if (info.ipv6 === false && (ebpf[0].local && ebpf[0].local.ipv6 !== false)) {
      step('ebpf-ipv6', '关闭 eBPF 的 IPv6 处理', '本机没有可用的 IPv6 出口', true, () => {
        const index = ebpfIndex(data);
        setIn(doc, ['listeners', index, 'local', 'ipv6'], false);
        setIn(doc, ['listeners', index, 'shared', 'ipv6'], false);
        refresh();
      });
    }

    // 2. 关闭 TUN：与 eBPF 透明代理二选一，同时开启会抢占路由。
    if (isObject(data.tun) && data.tun.enable) {
      step('tun', '关闭 TUN', 'eBPF 已接管透明代理，TUN 会与其冲突', false, () => { setIn(doc, ['tun', 'enable'], false); refresh(); });
    }

    // 3. 去掉路由器专用字段。
    const routerKeys = ['tproxy-port', 'redir-port', 'routing-mark', 'interface-name', 'iptables', 'ebpf', 'auto-redirect'].filter((key) => data[key] !== undefined);
    if (routerKeys.length) {
      step('router', '移除路由器专用字段', routerKeys.join('、') + ' 在手机上无效或会让出站绑定到不存在的网卡', true, () => {
        for (const key of routerKeys) doc.delete(key);
        refresh();
      });
    }

    // 4. 控制器：只监听本机，并确保有密钥。
    const controller = typeof data['external-controller'] === 'string' ? data['external-controller'] : '';
    const port = /:(\d{1,5})$/.exec(controller);
    if (!controller) {
      step('controller', '启用本机控制器', '模块通过 127.0.0.1:9090 管理内核', false, () => { doc.set('external-controller', '127.0.0.1:9090'); refresh(); });
    } else if (!/^(127\.0\.0\.1|localhost|\[::1\]):/.test(controller)) {
      step('controller', '控制器只监听本机', controller + ' 会在公共 Wi-Fi 下暴露管理接口，改为 127.0.0.1:' + (port ? port[1] : '9090'), true, () => {
        doc.set('external-controller', '127.0.0.1:' + (port ? port[1] : '9090'));
        refresh();
      });
    }
    if (!data.secret) {
      step('secret', '生成控制器密钥', '防止本机其它应用调用控制接口', true, () => { doc.set('secret', randomHex(16)); refresh(); });
    }
    // 内核只允许数据目录内的路径（SAFE_PATHS）；导入的路由器配置常带 /etc/... 等绝对路径。
    const pathFixes = [];
    const relative = (value, fallback) => {
      const base = String(value).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop();
      return './' + (fallback ? fallback + '/' : '') + (base || 'file');
    };
    const isUnsafe = (value) => typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes('..'));
    if (isUnsafe(data['external-ui'])) pathFixes.push([['external-ui'], './dashboard']);
    for (const [section, dir] of [['proxy-providers', 'proxy_provider'], ['rule-providers', 'rule_provider']]) {
      const items = isObject(data[section]) ? data[section] : {};
      for (const [name, item] of Object.entries(items)) {
        if (isObject(item) && isUnsafe(item.path)) pathFixes.push([[section, name, 'path'], relative(item.path, dir)]);
      }
    }
    for (const key of ['geoip', 'geosite', 'mmdb', 'asn']) {
      if (isObject(data['geox-path']) && isUnsafe(data['geox-path'][key])) pathFixes.push([['geox-path', key], relative(data['geox-path'][key])]);
    }
    if (pathFixes.length) {
      step('paths', '改写数据目录外的路径', pathFixes.map(([path]) => path.join('.')).slice(0, 4).join('、') +
        (pathFixes.length > 4 ? ' 等 ' + pathFixes.length + ' 项' : '') + ' 指向数据目录外，内核会拒绝加载，改为相对路径', false, () => {
        for (const [path, value] of pathFixes) {
          const node = doc.getIn(path.slice(0, -1), true);
          // 带合并键的条目直接在条目层写入，避免改到锚点
          if (Y.isMap(node)) node.set(path[path.length - 1], value); else setIn(doc, path, value);
        }
        refresh();
      });
    }
    if (!data['external-ui']) {
      step('dashboard', '配置网页面板', '使用 zashboard，首次访问时自动下载', true, () => {
        doc.set('external-ui', './dashboard');
        if (!data['external-ui-url']) doc.set('external-ui-url', (info.mirror || '') + ZASHBOARD);
        refresh();
      });
    } else if (!data['external-ui-url'] && !data['external-ui-name']) {
      // 有面板目录但没写下载地址时，内核默认下载 metacubexd；统一改用 zashboard
      step('dashboard', '面板改用 zashboard', '未指定面板下载地址，内核默认会下载 metacubexd', true, () => {
        doc.set('external-ui-url', (info.mirror || '') + ZASHBOARD);
        refresh();
      });
    }

    // 5. 局域网入站：手机共享走 eBPF，不需要对外开放混合端口。
    if (data['allow-lan'] === true && !info.keepLan) {
      step('lan', '关闭局域网入站', '热点/USB 共享由 eBPF 接管，关闭后公共 Wi-Fi 下更安全', true, () => {
        doc.set('allow-lan', false);
        if (data['bind-address'] !== undefined) doc.delete('bind-address');
        refresh();
      });
    }

    // 6. DNS：eBPF 劫持 53 端口后交给 DNS 出站处理。
    const dns = isObject(data.dns) ? data.dns : null;
    if (!dns) {
      step('dns', '启用 DNS 模块', 'redir-host 模式，国内上游 223.5.5.5 / 119.29.29.29', false, () => {
        doc.set('dns', doc.createNode({ enable: true, ipv6: info.ipv6 === true, listen: '127.0.0.1:1053', 'enhanced-mode': 'redir-host',
          'default-nameserver': ['223.5.5.5', '119.29.29.29'], nameserver: ['223.5.5.5', '119.29.29.29'] }));
        refresh();
      });
    } else if (!dns.enable || !dns.listen) {
      step('dns', '启用 DNS 模块', '原配置的 DNS 未启用或缺少监听地址', false, () => {
        setIn(doc, ['dns', 'enable'], true);
        if (!dns.listen) setIn(doc, ['dns', 'listen'], '127.0.0.1:1053');
        refresh();
      });
    }
    const dnsProxy = (Array.isArray(data.proxies) ? data.proxies : []).find((item) => isObject(item) && item.type === 'dns');
    const hijackRule = dnsProxy && rules.some((rule) => typeof rule === 'string' && /^DST-PORT\s*,\s*53\s*,/.test(rule.trim()));
    if (!dnsProxy || !hijackRule) {
      step('dns-hijack', '接管 53 端口 DNS', '添加 DNS 出站与 DST-PORT,53 规则，避免应用绕过 DNS 设置', false, () => {
        let name = dnsProxy ? String(dnsProxy.name) : 'DNS_Hijack';
        if (!dnsProxy) {
          const taken = new Set(policies(data));
          for (let index = 2; taken.has(name); index++) name = 'DNS_Hijack-' + index;
          if (!Y.isSeq(doc.get('proxies', true))) doc.set('proxies', doc.createNode([]));
          const node = doc.createNode({ name, type: 'dns' });
          node.flow = true;
          doc.get('proxies', true).items.unshift(node);
        }
        if (!hijackRule) {
          if (!Y.isSeq(doc.get('rules', true))) doc.set('rules', doc.createNode([]));
          doc.get('rules', true).items.unshift(doc.createNode('DST-PORT,53,' + name));
        }
        refresh();
      });
    }

    // 7. IPv6：本机没有 IPv6 出口时关闭，避免连接先走 IPv6 超时。
    if (info.ipv6 === false && data.ipv6 !== false) {
      step('ipv6', '关闭 IPv6', '当前网络没有 IPv6 默认路由，避免 AAAA 解析导致的连接等待', true, () => {
        doc.set('ipv6', false);
        if (isObject(data.dns) && data.dns.ipv6) setIn(doc, ['dns', 'ipv6'], false);
        refresh();
      });
    }

    // 8. 进程匹配：Android 上按包名分流需要 find-process-mode；不用时关闭以省电。
    const usesProcess = hasRuleType(rules, /^(AND|OR|NOT|SUB-RULE)?.*\b(PROCESS-NAME|PROCESS-PATH|PROCESS-NAME-REGEX|PROCESS-PATH-REGEX|UID)\b/);
    if (usesProcess && data['find-process-mode'] === 'off') {
      step('process', '开启进程匹配', '规则里有 PROCESS-NAME/UID，Android 上按包名匹配需要 strict', true, () => { doc.set('find-process-mode', 'strict'); refresh(); });
    } else if (!usesProcess && data['find-process-mode'] === undefined) {
      step('process', '关闭进程查找', '规则没有按应用分流，关闭可降低 CPU 占用', true, () => { doc.set('find-process-mode', 'off'); refresh(); });
    }

    // 9. GEO 数据：使用 jsDelivr 镜像，低内存设备用省内存加载。
    const usesGeo = hasRuleType(rules, /\b(GEOSITE|GEOIP|SRC-GEOIP)\b/) || JSON.stringify(data.dns || {}).includes('geosite:');
    if (usesGeo && !isObject(data['geox-url'])) {
      step('geox', '设置 GEO 数据下载镜像', 'GitHub 直连不稳定时也能下载 geoip/geosite', true, () => { doc.set('geox-url', doc.createNode(GEOX)); refresh(); });
    }
    if (usesGeo && Number(info.memMb) > 0 && Number(info.memMb) < 6144 && data['geodata-loader'] === undefined) {
      step('geodata', 'GEO 数据省内存加载', '本机内存 ' + Math.round(Number(info.memMb) / 1024) + ' GB，减少常驻内存', true, () => {
        doc.set('geodata-loader', 'memconservative');
        refresh();
      });
    }

    // 10. 体验与功耗。
    if (data['log-level'] === 'debug' || data['log-level'] === 'info' || data['log-level'] === undefined) {
      step('log', '降低日志级别', '改为 warning，减少写入与耗电', true, () => { doc.set('log-level', 'warning'); refresh(); });
    }
    if (data['tcp-concurrent'] === undefined) {
      step('tcp', '开启 TCP 并发', '同时连接多个解析结果，移动网络下更快', true, () => { doc.set('tcp-concurrent', true); refresh(); });
    }
    if (!isObject(data.profile) || data.profile['store-selected'] === undefined) {
      step('profile', '记住手动选择的节点', '重启内核后保留选择', true, () => { setIn(doc, ['profile', 'store-selected'], true); refresh(); });
    }
    if (!isObject(data.sniffer)) {
      step('sniffer', '开启域名嗅探', '从 TLS/HTTP 中识别域名，提升规则命中率', true, () => {
        doc.set('sniffer', doc.createNode({ enable: true, sniff: { HTTP: { ports: [80, '8080-8880'] }, TLS: { ports: [443, 8443] }, QUIC: { ports: [443, 8443] } } }));
        refresh();
      });
    }

    const output = dump(doc);
    parse(output);
    return { ok: true, content: output, changes, summary: summarize(parse(output), plain(parse(output))) };
  }

  // 订阅转配置时，把多个订阅写进内置模板之后统一走 optimize。
  root.mihomoConfig = Object.freeze({ parse: (content) => { parse(content); return { ok: true }; }, lint, schema, tailscale, nodes, nodeParse, nodeForm, nodeBuild, groupBuild, patch, analyze, optimize, check });
})(typeof window !== 'undefined' ? window : globalThis);
