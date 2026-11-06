'use strict';
// 本地预览：node magisk/tests/preview-server.cjs [端口]
// 提供 wasm 产物，并把 backend.js 换成内存模拟后台，便于在桌面浏览器里检查布局与交互。
// ?fresh=1 模拟首次启动（无配置、未完成引导）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dist = path.resolve(__dirname, '../webui/build/dist/wasmJs/productionExecutable');
const port = Number(process.argv[2] || 8790);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.yaml': 'text/plain; charset=utf-8', '.otf': 'font/otf', '.ttf': 'font/ttf', '.json': 'application/json', '.map': 'application/json' };

function mockBackend() {
  const fresh = new URLSearchParams(location.search).has('fresh');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const policy = { ok: true, autostart: false, tethering: false, tethering_interfaces: 'ap0,wlan1,rndis0,usb0,bt-pan',
    bypass_packages: 'com.android.settings\ncom.example.music', wifi_mode: 'off', wifi_ssids: '家庭 Wi-Fi',
    current_ssid: '家庭 Wi-Fi', allowed: true };
  const apps = [
    { packageName: 'com.android.settings', appLabel: '设置', isSystem: true, uid: 1000 },
    { packageName: 'com.example.music', appLabel: '音乐', isSystem: false, uid: 10111 },
    { packageName: 'com.example.chat', appLabel: '聊天', isSystem: false, uid: 10112 },
    { packageName: 'com.example.browser', appLabel: '浏览器', isSystem: false, uid: 10113 },
  ];
  let running = !fresh;
  let config = fresh ? '' : window.__previewTemplate;
  let completed = !fresh;
  let installed = !fresh;
  const host = { ok: true, abi: 'aarch64', kernel: '6.1.75-android14-11', sdk: 35, android: '15', model: 'Xiaomi 15', cpus: 8,
    mem_mb: 11742, btf: true, cgroup2: true, bpffs: true, kernel_ok: true, ipv6: false, upstream: 'wlan0', ssid: '家庭 Wi-Fi',
    core: !fresh, root: 'kernelsu', mirror: 'https://ghfast.top/', has_config: !fresh };
  const svgIcon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#3482ff"/><path d="M14 25l7 7 13-15" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/></svg>');
  const many = Array.from({ length: 120 }, (_, i) => '节点 ' + String(i + 1).padStart(3, '0'));
  const groups = [
    { name: '节点选择', type: 'Selector', now: '香港 01', icon: svgIcon, all: ['自动选择', '香港 01', '香港 02', '日本 01', '美国 01', 'DIRECT'] },
    { name: '自动选择', type: 'URLTest', now: '香港 02', icon: svgIcon, all: ['香港 01', '香港 02', '日本 01', '美国 01'] },
    { name: '全部节点', type: 'Selector', now: many[3], all: many },
    { name: '隐藏组', type: 'Selector', now: 'DIRECT', hidden: true, all: ['DIRECT'] },
  ];
  const delays = { '香港 01': 82, '香港 02': 64, '日本 01': 121, '美国 01': 233, DIRECT: 6 };
  many.forEach((name, i) => { delays[name] = i % 9 === 0 ? 0 : 60 + (i * 37) % 900; });
  const webui = { enabled: false, port: 9099, lan: false, allow_cidrs: [], require_password: true, tailscale: false,
    tailscale_no_password: false, tailscale_users: [], session_hours: 168, has_password: false,
    enhanced: { enabled: false, has_password: false, scrcpy: false, scrcpy_port: 8080,
      scrcpy_mode: 'builtin', scrcpy_max_size: 1280, scrcpy_fps: 24, scrcpy_bit_rate: 2000000 } };
  const previewMode = new URLSearchParams(location.search);
  const remote = previewMode.has('remote');
  let operationPassword = 'operation-password';
  let operationUnlocked = false;
  let screenRunning = false;
  let hotspot = { ok: true, enabled: false, tethered: false, configured: false, ssid: '', band: '2' };
  if (previewMode.has('enhanced')) {
    webui.enabled = true;
    webui.has_password = true;
    webui.enhanced.enabled = true;
    webui.enhanced.has_password = true;
  }
  window.__previewCalls = [];
  const tsLogged = {};
  window.mihomoBridge = { request: async (operation, raw = '{}') => {
    const payload = JSON.parse(raw);
    window.__previewCalls.push({ operation, payload });
    await sleep(60);
    let result = { ok: true };
    try {
    switch (operation) {
      case 'onboardingState': result = { ok: true, has_config: !!config, completed }; break;
      case 'onboardingComplete': completed = true; break;
      case 'policyGet': result = policy; break;
      case 'policySsid': result = { ok: true, current_ssid: policy.current_ssid }; break;
      case 'policySet': Object.assign(policy, payload); break;
      case 'apps': result = { ok: true, apps }; break;
      case 'appIcon': result = { ok: true, icon: null }; break;
      case 'hostProbe': result = host; break;
      case 'discoveryInterfaces': result = { ok: true, interfaces: [
        { name: 'ap0', kind: 'wifi', present: true, state: 'up', upstream: false, suggested: true },
        { name: 'wlan0', kind: 'wifi', present: true, state: 'up', upstream: true, suggested: false },
        { name: 'rndis0', kind: 'usb', present: false, state: 'down', upstream: false, suggested: true },
      ] }; break;
      case 'status': result = { ok: true, running, pid: running ? 2471 : null, rss_kb: running ? 46336 : 0, uptime: running ? 7384 : null,
        desired: 'manual', allowed: true, current_ssid: policy.current_ssid }; break;
      case 'service': running = payload.action !== 'stop'; break;
      case 'coreInfo': result = { ok: true, installed, version: installed ? 'alpha-smart-e272b9d' : '', can_rollback: !fresh }; break;
      case 'coreGetSet': result = { ok: true, repo: 'liuran001/mihomo', tag: 'Prerelease-Alpha', mirror: 'https://ghfast.top/' }; break;
      case 'coreSet': break;
      case 'coreUpdate': await sleep(1200); installed = true; result = { ok: true, version: 'alpha-smart-e272b9d' }; break;
      case 'configRead': result = { ok: true, content: config, exists: !!config }; break;
      case 'validate': result = { ok: true, valid: true, output: 'configuration file test is successful' }; break;
      case 'apply': config = payload.content || config; result = { ok: true, restarted: running }; break;
      case 'template': result = { ok: true, content: window.__previewTemplate }; break;
      case 'importUrl': result = { ok: true, content: window.__previewRouter }; break;
      case 'configSchema': result = window.mihomoConfig.schema(payload.content); break;
      case 'configAnalyze': result = window.mihomoConfig.analyze(payload.content); break;
      case 'nodeParse': result = window.mihomoConfig.nodeParse(payload.text, payload.taken); break;
      case 'nodeForm': result = window.mihomoConfig.nodeForm(payload.type, payload.node); break;
      case 'nodeBuild': result = window.mihomoConfig.nodeBuild(payload.base, payload.type, payload.values); break;
      case 'configPatch': result = window.mihomoConfig.patch(payload.content, payload.ops); break;
      case 'configOptimize': result = window.mihomoConfig.optimize(payload.content, payload.host || {}, { skip: payload.skip || [] }); break;
      case 'tailscaleRead':
      case 'tailscaleStatus': {
        const schema = window.mihomoConfig.tailscale(config);
        result = { ...(operation === 'tailscaleRead' ? { ...schema, content: config } : {}), ok: true, list: schema.tailscale.map((item) => ({
        name: item.name, stateDir: '/data/adb/mihomo/tailscale', authKey: item.used, loggedIn: !!tsLogged[item.name],
        login: tsLogged[item.name] ? 'user@example.com' : null, tailnet: tsLogged[item.name] ? 'example.ts.net' : null,
        magicDns: tsLogged[item.name] ? 'tail0000.ts.net' : null })) };
        break;
      }
      case 'tailscaleLogin': await sleep(1500); setTimeout(() => { tsLogged[payload.name] = true; }, 8000);
        result = { ok: true, url: 'https://login.tailscale.com/a/1a2b3c4d5e6f70' }; break;
      case 'tailscaleLogout': delete tsLogged[payload.name]; break;
      case 'openUrl': window.__opened = payload.url; break;
      case 'proxyIcon': if (!payload.url.startsWith('data:')) throw new Error('预览无法下载图标'); result = { ok: true, icon: payload.url }; break;
      case 'webuiStatus': result = { ok: true, installed: true, running: webui.enabled, settings: { ok: true, ...webui,
        addrs: [{ iface: 'wlan0', addr: '192.168.1.23' }, { iface: 'tailscale0', addr: '100.64.0.2' }] } }; break;
      case 'webuiSet': Object.assign(webui, payload.settings); result = { ok: true, installed: true, running: webui.enabled, settings: { ok: true, ...webui,
        addrs: [{ iface: 'wlan0', addr: '192.168.1.23' }] } }; break;
      case 'webuiPasswd':
        webui.has_password = !!payload.password;
        if (!webui.has_password) { webui.enhanced.enabled = false; webui.enhanced.scrcpy = false; }
        break;
      case 'webuiSession': result = { ok: true, remote, via: remote ? 'lan' : 'local', passwordless: false }; break;
      case 'enhancedSet': {
        if (remote) throw new Error('增强功能设置只能在本机模块 WebUI 修改');
        if (payload.settings.enabled && !webui.has_password) throw new Error('请先设置主 WebUI 密码');
        const patch = { ...payload.settings };
        if ('password' in patch) { operationPassword = patch.password; patch.has_password = !!patch.password; delete patch.password; }
        Object.assign(webui.enhanced, patch);
        if (webui.enhanced.enabled) { webui.enabled = true; webui.require_password = true; }
        else webui.enhanced.scrcpy = false;
        operationUnlocked = false;
        result = { ok: true, installed: true, running: webui.enabled, settings: { ...webui, addrs: [] } };
        break;
      }
      case 'enhanced': {
        const body = payload.payload || {};
        if (payload.action === 'status') {
          result = { ok: true, ...webui.enhanced, unlocked: webui.enhanced.enabled && (!webui.enhanced.has_password || operationUnlocked),
            can_configure: !remote, requires_main: false, public_access: previewMode.has('public'),
            screen_service: { installed: true, version: '5.0.1', running: screenRunning, last_error: '' } };
          break;
        }
        if (!webui.enhanced.enabled) throw new Error('请先在本机启用增强功能');
        if (payload.action === 'unlock') {
          if (webui.enhanced.has_password && body.password !== operationPassword) throw new Error('操作密码错误');
          operationUnlocked = true;
          break;
        }
        if (webui.enhanced.has_password && !operationUnlocked) throw new Error('增强功能已锁定，请输入操作密码');
        switch (payload.action) {
          case 'lock': operationUnlocked = false; break;
          case 'battery': result = { ok: true, percent: 73, powered: true, temperature: 32 }; break;
          case 'sms': result = { ok: true, messages: [{ id: '1', address: 'QA-SENDER', body: 'QA-SMS-NOT-A-REAL-MESSAGE', date: '1793880000000', type: '1' }] }; break;
          case 'hotspot': result = hotspot; break;
          case 'hotspot-set':
            if (body.config) hotspot = { ...hotspot, configured: true, ssid: body.config.ssid, band: body.config.band };
            if ('enabled' in body) hotspot = { ...hotspot, enabled: body.enabled, tethered: body.enabled };
            result = hotspot;
            break;
          case 'terminal': result = { ok: true, errno: 0, stdout: 'QA-TERMINAL-RESULT', stderr: '', truncated: false }; break;
          case 'scrcpy-set':
            if ('enabled' in body) webui.enhanced.scrcpy = body.enabled;
            for (const key of ['port', 'mode', 'max_size', 'fps', 'bit_rate']) if (key in body) webui.enhanced['scrcpy_' + key] = body[key];
            screenRunning = false;
            break;
          case 'scrcpy-stop': screenRunning = false; break;
          default: throw new Error('未知预览设备操作');
        }
        break;
      }
      case 'scrcpyUrl': result = { ok: true, url: location.origin + '/enhanced/scrcpy/' }; break;
      case 'dashboard': result = { ok: true, available: true, url: 'http://127.0.0.1:9090/ui/#/setup?hostname=127.0.0.1&port=9090' }; break;
      case 'qrCode': {
        const code = window.qrcode(0, 'M');
        code.addData(payload.text, 'Byte');
        code.make();
        const size = code.getModuleCount();
        const rows = [];
        for (let r = 0; r < size; r++) { let line = ''; for (let c = 0; c < size; c++) line += code.isDark(r, c) ? '1' : '0'; rows.push(line); }
        result = { ok: true, size, rows };
        break;
      }
      case 'backupRead': result = { ok: true, content: config }; break;
      case 'coreRollback': case 'backupRestore': case 'backupDel': break;
      case 'backups': result = { ok: true, backups: [{ name: 'config-20261104-2210.yaml', size: 13312, time: 1730729400 }] }; break;
      case 'logs': {
        const lines = ['[2026-11-05 09:59:58] mihomo.sh: 启动服务',
          'time="2026-11-05T10:00:00.1+08:00" level=info msg="Start initial configuration in progress"',
          'time="2026-11-05T10:00:01.2+08:00" level=info msg="Mixed(http+socks) proxy listening at: 127.0.0.1:7890"',
          'time="2026-11-05T10:00:02.3+08:00" level=warning msg="geoip.dat not found, downloading"',
          'time="2026-11-05T10:00:03.4+08:00" level=error msg="dial tcp 1.2.3.4:443: i/o timeout"',
          'time="2026-11-05T10:00:04.5+08:00" level=debug msg="[DNS] resolve www.google.com from udp://223.5.5.5:53"'];
        for (let i = 0; i < 280; i++) lines.push('time="2026-11-05T10:01:' + String(i % 60).padStart(2, '0') + '.0+08:00" level=info msg="[TCP] 192.168.43.' + (i % 250) + ':' + (40000 + i) + ' --> www.example' + i + '.com:443 match DomainSuffix(example' + i + '.com) using 节点选择[香港 01]"');
        result = { ok: true, content: lines.join('\n') + '\n' };
        break;
      }
      case 'controller': {
        const p = payload.path || '';
        if (p.startsWith('/proxies') && p.includes('/delay')) result = { ok: true, data: { delay: 70 + Math.round(Math.random() * 90) } };
        else if (p === '/proxies') {
          const proxies = {};
          for (const g of groups) proxies[g.name] = { name: g.name, type: g.type, now: g.now, all: g.all, icon: g.icon || '', hidden: !!g.hidden, history: [] };
          proxies.GLOBAL = { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: groups.map((g) => g.name).concat(['DIRECT']), history: [] };
          for (const [name, delay] of Object.entries(delays)) proxies[name] = { name, type: name === 'DIRECT' ? 'Direct' : 'Vless', udp: name !== 'DIRECT', history: [{ delay }] };
          result = { ok: true, data: { proxies } };
        } else if (p === '/connections') result = { ok: true, data: { downloadTotal: 734003200, uploadTotal: 41943040, connections: [
          { id: '1', chains: ['香港 02', '自动选择'], rule: 'RuleSet', rulePayload: 'google', upload: 2048, download: 90112,
            start: new Date(Date.now() - 42000).toISOString(), metadata: { host: 'www.google.com', network: 'tcp', destinationPort: '443', process: 'com.android.chrome' } },
          { id: '2', chains: ['DIRECT'], rule: 'GeoIP', rulePayload: 'CN', upload: 512, download: 4096,
            start: new Date(Date.now() - 8000).toISOString(), metadata: { host: 'api.bilibili.com', network: 'tcp', destinationPort: '443', process: 'tv.danmaku.bili' } },
        ] } };
        else if (p === '/connections/summary') result = { ok: true, data: { uploadTotal: 41943040 + Date.now() % 1000000, downloadTotal: 734003200 + Date.now() % 10000000, connectionCount: 2, memory: 47448064 } };
        else if (p === '/overview') result = { ok: true, data: { exit: { chain: ['节点选择', '自动选择', '香港 02'], smart: false }, providers: { sample: { name: '示例订阅', vehicleType: 'HTTP', count: 6, updatedAt: new Date().toISOString(), subscriptionInfo: { Upload: 41943040, Download: 734003200, Total: 107374182400, Expire: 0 } } } } };
        else if (p === '/ebpf/summary') result = { ok: true, data: { inbounds: [{ id: 1, mode: 'hybrid', local_data_plane: 'cgroup', shared_data_plane: 'packet_rewrite', maintenance: [] }] } };
        else if (p === '/ebpf') result = { ok: true, data: { inbounds: [{ id: 1, mode: 'hybrid', resources: { programs: [{ id: 1 }], maps: { status: 'pass', maps: [] } } }] } };
        else if (p === '/traffic') result = { ok: true, data: { up: 12000 + Math.round(Math.random() * 9000), down: 260000 + Math.round(Math.random() * 90000) } };
        else if (p === '/memory') result = { ok: true, data: { inuse: 47448064 } };
        else result = { ok: true, data: { version: 'alpha-smart-e272b9d' } };
        break;
      }
      default: result = { ok: false, error: `预览未模拟 ${operation}` };
    }
    } catch (error) { result = { ok: false, error: error.message }; }
    return JSON.stringify(result);
  } };
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/backend.js') {
    const NL = String.fromCharCode(10);
    const fills = {
      providers: (i) => [i + '"机场":', i + '  <<: *p', i + '  url: "https://example.com/sub"', i + '  path: "./providers/a.yaml"'],
      use: (i) => [i + '- "机场"'], secret: () => ['secret: "preview"'], 'ui-url': () => [],
      'fake-ip-filter-url': (i) => [i + 'url: "https://example.com/f.mrs"'], lan: (i) => [i + 'interface: []'],
    };
    const template = fs.readFileSync(path.resolve(__dirname, '../../shared/template.yaml'), 'utf8').split(String.fromCharCode(13)).join('')
      .split(NL).flatMap((line) => {
        const match = /^( *)#@(\S+)$/.exec(line);
        return match ? fills[match[2]](match[1]) : [line.replace('external-controller: 0.0.0.0:9090', 'external-controller: 127.0.0.1:9090')];
      }).join(NL);
    const router = ['mixed-port: 7890', 'tproxy-port: 7894', 'allow-lan: true', 'external-controller: 0.0.0.0:9090', 'tun:', '  enable: true',
      'proxies:', '  - {name: 香港, type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: x}',
      'proxy-groups:', '  - {name: 节点选择, type: select, proxies: [香港, DIRECT]}', 'rules:', '  - GEOSITE,cn,DIRECT', '  - MATCH,节点选择', ''].join(NL);
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(`window.__previewTemplate=${JSON.stringify(template)};window.__previewRouter=${JSON.stringify(router)};(${mockBackend.toString()})();`);
    return;
  }
  const file = path.join(dist, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('preview http://127.0.0.1:' + port + '/'));
