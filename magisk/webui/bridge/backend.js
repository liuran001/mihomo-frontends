(function (root) {
  'use strict';

  const DATA = '/data/adb/mihomo';
  const CONFIG = DATA + '/config.yaml';
  const SH = 'sh /data/adb/modules/mihomo-ebpf/scripts/';
  const DEFAULT_INTERFACES = 'ap0,wlan1,rndis0,usb0,bt-pan';
  const MAX_CONFIG_BASE64 = 120000;
  const PACKAGE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*(?![\s\S])/;
  const callbacks = new Map();
  const icons = new Map();
  let callbackSequence = 0;
  let cachedApps = null;
  let pendingApps = null;
  let appsGeneration = 0;

  function shq(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function bytesBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function b64encode(value) {
    return bytesBase64(new TextEncoder().encode(value));
  }

  function b64decode(value) {
    const encoded = value.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('读取内容不是有效 Base64');
    }
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) throw new Error('读取内容不是有效 Base64');
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  }

  const MAX_CONFIG_BYTES = 4194304;
  const STAGE_CHUNK = 96000;

  function configPayload(content) {
    const encoded = b64encode(content);
    if (encoded.length > MAX_CONFIG_BASE64) {
      throw new Error('配置过大：UTF-8 Base64 编码后为 ' + encoded.length + ' 字节，上限为 ' + MAX_CONFIG_BASE64 + ' 字节；请精简配置以避免 Android 参数长度限制');
    }
    return encoded;
  }

  // 超过单条命令参数上限的配置分段写入 run/stage.b64，返回在 shell 中引用暂存内容的方式。
  async function stageConfig(content) {
    const encoded = b64encode(content);
    if (encoded.length <= MAX_CONFIG_BASE64) return { inline: encoded };
    if (new TextEncoder().encode(content).length > MAX_CONFIG_BYTES) throw new Error('配置超过 4 MB，无法写入');
    for (let index = 0, offset = 0; offset < encoded.length; index++, offset += STAGE_CHUNK) {
      await shJson('host.sh', ['stage', String(index), encoded.slice(offset, offset + STAGE_CHUNK)], 30000);
    }
    return { staged: true };
  }

  function exec(command, timeout = 30000) {
    const callbackName = '__mihomo_bridge_cb_' + (++callbackSequence);
    return new Promise((resolve) => {
      let timer;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callbacks.delete(callbackName);
        delete root[callbackName];
        resolve(result);
      };
      callbacks.set(callbackName, finish);
      root[callbackName] = (errno, stdout, stderr) => finish({
        errno: Number.isFinite(Number(errno)) ? Number(errno) : -1,
        stdout: String(stdout == null ? '' : stdout),
        stderr: String(stderr == null ? '' : stderr),
      });
      timer = setTimeout(() => finish({ errno: -1, stdout: '', stderr: '回调超时；命令可能仍在执行，请刷新确认实际状态，勿重复提交' }), timeout);
      try {
        if (!root.ksu || (typeof root.ksu.spawn !== 'function' && typeof root.ksu.exec !== 'function')) throw new Error('请在 KernelSU/Magisk WebUI 中打开');
        // KernelSU 的 ksu.exec 在 JS 接口方法里同步执行命令，期间页面主线程（也是界面渲染线程）被阻塞；
        // ksu.spawn 只同步创建 shell，命令在后台执行，按行回传输出，界面不会因轮询而卡顿。
        if (typeof root.ksu.spawn === 'function') {
          const out = [];
          const err = [];
          root[callbackName] = {
            stdout: { emit: (event, data) => { if (event === 'data') out.push(String(data)); } },
            stderr: { emit: (event, data) => { if (event === 'data') err.push(String(data)); } },
            emit: (event, code) => {
              if (event === 'exit') finish({ errno: Number.isFinite(Number(code)) ? Number(code) : -1, stdout: out.join('\n'), stderr: err.join('\n') });
            },
          };
          root.ksu.spawn(command, '[]', '{}', callbackName);
          return;
        }
        root.ksu.exec(command, '{}', callbackName);
      } catch (error) {
        finish({ errno: -1, stdout: '', stderr: 'ksu.exec 不可用：' + error.message });
      }
    });
  }

  // 网页管理（mihomo-webd）：没有 ksu 时经同源 api/run 调用脚本子命令；只允许 SCRIPTS 中的脚本，不执行任意 shell。
  const SCRIPTS = ['apply.sh', 'backup.sh', 'core.sh', 'discovery.sh', 'host.sh', 'mihomo.sh', 'onboarding.sh', 'policy.sh', 'substore.sh', 'tailscale.sh', 'webui.sh'];
  const ENV_NAMES = ['MIHOMO_SECRET', 'MIHOMO_API_TIMEOUT'];

  function remoteMode() {
    return !root.ksu && !!root.location && /^https?:$/.test(root.location.protocol);
  }

  async function remoteJson(url, init, timeout = 10000) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    let expired = false;
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('请求超时；请检查网页服务连接后重试，写入操作可能仍在执行，勿重复提交'));
        if (abort) abort.abort();
      }, timeout);
    });
    try {
      const pending = (async () => {
        const response = await root.fetch(url, {
          ...init, credentials: 'same-origin', signal: abort ? abort.signal : undefined,
          headers: { ...init.headers, 'X-Mihomo-Request': '1' },
        });
        if (expired) throw new Error('请求已超时');
        if (response.status === 401) {
          root.location.href = 'login?next=' + encodeURIComponent(root.location.pathname + root.location.hash);
          throw new Error('登录已失效，请重新登录');
        }
        const body = await response.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('网页服务 HTTP ' + response.status + '：响应格式无效');
        if (!response.ok) throw Object.assign(new Error(String(body.error || ('网页服务 HTTP ' + response.status))), { locked: body.locked === true });
        return body;
      })();
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // 网页服务同时只跑 4 个脚本，旧版超出即返回 429；页面并发读取多项状态时在这里排队，最多同时 3 个，留 1 个给其它标签页。
  // 图标下载等后台请求走低优先级：同时最多 1 个，且排在界面读取之后，不会把状态读取堵在后面。
  const REMOTE_SLOTS = 3;
  let remoteActive = 0;
  let remoteLowActive = 0;
  const remoteQueue = [];
  const remoteLowQueue = [];
  function remoteNext() {
    while (remoteActive < REMOTE_SLOTS) {
      if (remoteQueue.length) { remoteActive++; remoteQueue.shift()(); continue; }
      if (remoteLowQueue.length && remoteLowActive < 1) { remoteActive++; remoteLowActive++; remoteLowQueue.shift()(); continue; }
      return;
    }
  }
  function remoteSlot(low) {
    return new Promise((resolve) => { (low ? remoteLowQueue : remoteQueue).push(resolve); remoteNext(); });
  }
  function remoteRelease(low) {
    remoteActive--;
    if (low) remoteLowActive--;
    remoteNext();
  }

  async function remoteRun(script, args, timeout, env, low) {
    await remoteSlot(low);
    try {
      const body = await remoteJson('api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, args, env, timeout }),
      }, timeout + 5000);
      return { errno: Number(body.errno), stdout: String(body.stdout || ''), stderr: String(body.stderr || '') };
    } catch (error) {
      return { errno: -1, stdout: '', stderr: '网页服务请求失败：' + error.message };
    } finally {
      remoteRelease(low);
    }
  }

  // 调用模块脚本子命令：script 为 SCRIPTS 之一，args 为字符串参数，env 只允许 ENV_NAMES。
  function run(script, args = [], timeout = 30000, env = {}, low = false) {
    if (!SCRIPTS.includes(script)) return Promise.resolve({ errno: -1, stdout: '', stderr: '不允许的脚本：' + script });
    for (const name of Object.keys(env)) {
      if (!ENV_NAMES.includes(name)) return Promise.resolve({ errno: -1, stdout: '', stderr: '不允许的环境变量：' + name });
    }
    const list = args.map(String);
    if (remoteMode()) return remoteRun(script, list, timeout, env, low);
    const prefix = Object.entries(env).map(([name, value]) => name + '=' + shq(value) + ' ').join('');
    // 子命令（首个参数）是固定的小写单词，不加引号，便于在日志里辨认
    const words = list.map((arg, index) => (index === 0 && /^[a-z][a-z_-]*$/.test(arg) ? arg : shq(arg)));
    return exec(prefix + SH + script + words.map((word) => ' ' + word).join(''), timeout);
  }

  root.addEventListener('pagehide', () => {
    for (const finish of callbacks.values()) finish({ errno: -1, stdout: '', stderr: '页面已关闭，操作结果未知' });
  });

  async function shJson(script, args, timeout, env) {
    const result = await run(script, args, timeout, env);
    let data;
    try {
      data = JSON.parse(result.stdout.trim());
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON 对象缺失');
    } catch (error) {
      throw new Error(result.stderr || ('输出不是 JSON：' + result.stdout.slice(0, 200)));
    }
    if (result.errno !== 0 || data.ok !== true) {
      throw new Error(data.error || result.stderr || ('命令失败（退出码 ' + result.errno + '）'));
    }
    return data;
  }

  function isSSIDPaused(status) {
    return status.ok && status.running === false && status.allowed === false && ['manual', 'auto'].includes(status.desired);
  }

  function ssidPauseMessage(status) {
    return '服务已启用，因 SSID 策略暂停；当前 SSID：' + (status.current_ssid || '（未连接或无法获取）') + '。策略允许后自动恢复';
  }

  async function readStatus(prefix) {
    try { return await shJson('mihomo.sh', ['status']); }
    catch (error) { throw new Error(prefix + error.message); }
  }

  async function service(action) {
    const result = await run('mihomo.sh', [action], 120000);
    if (result.errno !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || ('服务操作失败（退出码 ' + result.errno + '）'));
    const status = await readStatus('操作已返回，但无法确认服务状态：');
    if (action !== 'stop' && isSSIDPaused(status)) return { ok: true, paused: true, message: ssidPauseMessage(status) };
    if (action === 'stop' && ['manual', 'auto'].includes(status.desired)) throw new Error('服务仍处于启用状态，自动恢复意图未取消，请刷新确认');
    if (status.running !== (action !== 'stop')) throw new Error(action === 'stop' ? '服务仍在运行' : '服务未运行，请检查 SSID 策略和日志');
    return { ok: true, paused: false, message: action === 'stop' ? '服务已停止' : '服务已启动' };
  }

  async function apply(content, restart) {
    controllerCache = null;
    const staged = await stageConfig(content);
    const result = await shJson('apply.sh', [staged.inline || '--staged'].concat(restart ? ['restart'] : []), 120000);
    if (!restart) return result;
    const status = await readStatus('配置已保存，但无法确认服务状态：');
    if (isSSIDPaused(status)) return { ...result, paused: true, message: ssidPauseMessage(status) };
    if (status.running !== true) throw new Error('配置已保存，但服务未运行；请检查 SSID 策略和日志');
    return { ...result, paused: false, message: '已确认服务运行中' };
  }

  function yamlScalar(value) {
    const text = value.trim();
    if (text.startsWith('"')) {
      const match = /^"(?:[^"\\]|\\.)*"/.exec(text);
      if (!match || !/^\s*(?:#.*)?$/.test(text.slice(match[0].length))) throw new Error('控制器配置引号无效');
      return JSON.parse(match[0]);
    }
    if (text.startsWith("'")) {
      const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
      if (!match) throw new Error('控制器配置引号无效');
      return match[1].replace(/''/g, "'");
    }
    const plain = text.replace(/\s+#.*$/, '').trim();
    if (/^[|>&*!{\[]/.test(plain) && !/^\[[\da-fA-F:]+\]:\d{1,5}$/.test(plain) && !/^\*:\d{1,5}$/.test(plain)) throw new Error('控制器地址和密钥请使用单行字符串');
    return /^(?:null|~)$/i.test(plain) ? '' : plain;
  }

  async function detectController() {
    const result = await run('host.sh', ['controller']);
    if (result.errno !== 0 && result.errno !== 1) throw new Error(result.stderr || '读取控制器配置失败');
    let address = null;
    let secret = '';
    let ui = '';
    for (const line of result.stdout.split('\n')) {
      const match = /^(external-controller|secret|external-ui):\s*(.*)$/.exec(line);
      if (!match) continue;
      if (match[1] === 'external-controller') address = yamlScalar(match[2]);
      else if (match[1] === 'secret') secret = yamlScalar(match[2]);
      else ui = yamlScalar(match[2]);
    }
    if (!address) throw new Error('配置中没有 external-controller');
    if (!/^(?:\[[\da-fA-F:]+\]|[\w.*-]*):\d{1,5}$/.test(address)) throw new Error('external-controller 地址无效');
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) throw new Error('external-controller 端口无效');
    address = address.replace(/^(?:0\.0\.0\.0|\[::\]|\*|)(?=:)/, '127.0.0.1');
    if (/[\r\n\0]/.test(secret)) throw new Error('控制器密钥不能包含换行');
    return { address: 'http://' + address, secret, ui };
  }

  // 控制器地址与密钥缓存一小段时间：轮询时不必每次都读配置（每次读都要起一个 shell）
  const CONTROLLER_TTL = 15000;
  let controllerCache = null;

  async function cachedController() {
    const now = Date.now();
    if (controllerCache && now - controllerCache.at < CONTROLLER_TTL) return controllerCache.value;
    const value = await detectController();
    controllerCache = { value, at: now };
    return value;
  }

  // 先由页面直接请求本机控制器（mihomo 默认允许跨域与私网访问），失败时再经 curl；
  // 直连失败而脚本成功时，两分钟内不再尝试直连。网页管理下经同源 /clash/ 反向代理访问。
  let directBlockedUntil = 0;

  function controllerResult(status, body) {
    if (status < 200 || status >= 300) throw new Error('控制器 HTTP ' + status + (body ? '：' + body.slice(0, 200) : ''));
    if (status === 204 || !body) return { ok: true, data: null };
    try { return { ok: true, data: JSON.parse(body) }; }
    catch (error) { throw new Error('控制器响应不是 JSON'); }
  }

  async function controllerFetch(base, detected, payload) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    let expired = false;
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('控制器请求超时'));
        if (abort) abort.abort();
      }, payload.timeout || 10000);
    });
    try {
      const remote = remoteMode();
      const headers = remote ? { 'X-Mihomo-Request': '1' } : { Authorization: 'Bearer ' + detected.secret };
      const init = { method: payload.method || 'GET', headers, credentials: remote ? 'same-origin' : 'omit', cache: 'no-store', signal: abort ? abort.signal : undefined };
      if (payload.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
      }
      return await Promise.race([(async () => {
        const response = await root.fetch(base + payload.path, init);
        if (expired) throw new Error('控制器请求已超时');
        if (!response || typeof response.status !== 'number' || typeof response.text !== 'function') throw new Error('无效响应');
        if (response.status === 401 && remote) {
          root.location.href = 'login?next=' + encodeURIComponent(root.location.pathname + root.location.hash);
          throw new Error('登录已失效，请重新登录');
        }
        return { status: response.status, body: String(await response.text()).trim() };
      })(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function controller(payload) {
    if (remoteMode()) {
      const response = await controllerFetch(root.location.origin + '/clash', null, payload);
      return controllerResult(response.status, response.body);
    }
    const detected = await cachedController();
    let direct = null;
    if (Date.now() >= directBlockedUntil && typeof root.fetch === 'function') {
      try {
        direct = await controllerFetch(remoteMode() ? root.location.origin + '/clash' : detected.address, detected, payload);
      } catch (error) {
        direct = null; // 被拦截、连不上或超时：改经脚本，脚本成功说明直连不可用
      }
    }
    if (direct) {
      if (direct.status === 401) controllerCache = null;
      return controllerResult(direct.status, direct.body);
    }
    const viaScript = await controllerScript(detected, payload);
    directBlockedUntil = Date.now() + 120000;
    return viaScript;
  }

  async function controllerScript(detected, payload) {
    const args = [payload.method || 'GET', detected.address + payload.path];
    if (payload.body !== undefined) args.push(typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body));
    const env = { MIHOMO_SECRET: detected.secret };
    let limit = 15000;
    if (payload.timeout) {
      const seconds = Math.ceil(payload.timeout / 1000);
      env.MIHOMO_API_TIMEOUT = String(seconds);
      limit = (seconds + 7) * 1000;
    }
    const result = await run('host.sh', ['api'].concat(args), limit, env);
    if (result.errno !== 0) throw new Error('控制器 curl 失败：' + (result.stderr || ('退出码 ' + result.errno + '')));
    const match = /\n__MIHOMO_HTTP__:(\d{3})\s*$/.exec(result.stdout);
    if (!match) throw new Error('控制器响应缺少 HTTP 状态码');
    return controllerResult(Number(match[1]), result.stdout.slice(0, match.index).trim());
  }

  function renderTemplate(template, payload) {
    const output = [];
    for (const line of template.split(/\r?\n/)) {
      const marker = line.trim();
      if (marker === '#@providers') {
        // 与 LuCI 向导一致：沿用 p 锚点、./proxy_provider/ 路径、节点名加 [订阅名] 前缀
        for (const subscription of payload.subscriptions) {
          output.push('  ' + JSON.stringify(subscription.name) + ':', '    <<: *p',
            '    path: ' + JSON.stringify('./proxy_provider/' + encodeURIComponent(subscription.name) + '.yaml'),
            '    url: ' + JSON.stringify(subscription.url),
            '    override:', '      additional-prefix: ' + JSON.stringify('[' + subscription.name + ']'));
          if (subscription.ua) output.push('    header:', '      User-Agent: [' + JSON.stringify(subscription.ua) + ']');
        }
      } else if (marker === '#@use') {
        for (const subscription of payload.subscriptions) output.push('    - ' + JSON.stringify(subscription.name));
      } else if (marker === '#@secret') {
        if (payload.secret) output.push('secret: ' + JSON.stringify(payload.secret));
      } else if (marker === '#@ui-url') {
        if (payload.uiUrl) output.push('external-ui-url: ' + JSON.stringify(payload.uiUrl));
      } else if (marker === '#@fake-ip-filter-url') {
        // 与 LuCI 向导一致：走镜像时直连即可；直连 GitHub 不稳定，没有镜像时经代理下载
        output.push('    url: ' + JSON.stringify(payload.rulesUrl),
          '    proxy: ' + JSON.stringify(/^https:\/\/github\.com\//.test(payload.rulesUrl) ? '节点选择' : 'DIRECT'));
      } else if (marker === '#@lan') {
        output.push('      interface: []');
      } else if (/^external-controller:/.test(line)) {
        output.push('external-controller: 127.0.0.1:9090');
      } else if (/^allow-lan:/.test(line)) {
        output.push('allow-lan: false');
      } else if (/^bind-address:/.test(line)) {
        output.push('bind-address: 127.0.0.1');
      } else if (/^    mode: hybrid\s*(?:#.*)?$/.test(line)) {
        output.push('    mode: local');
      } else {
        output.push(line);
      }
    }
    return output.join('\n');
  }

  async function fetchResource(url, consume, options = {}) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await root.fetch(url, { ...options, ...(abort ? { signal: abort.signal } : {}) });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return consume(response);
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            if (abort) abort.abort();
            reject(new Error('资源读取超时'));
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function packageArray(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error('应用列表不是 JSON 数组');
    return parsed;
  }

  function packageProviders() {
    const providers = [];
    if (root.ksu) {
      try {
        const manager = typeof root.ksu.pm === 'function' ? root.ksu.pm() : root.ksu.pm;
        if (manager && manager.support !== false) providers.push(manager);
      } catch (error) {}
      providers.push(root.ksu);
    }
    return providers;
  }

  async function appLabel(info, providers) {
    for (const label of [info.appLabel, info.label, info.getLabel]) {
      if (typeof label === 'string' && label.trim() && label !== info.packageName) return label;
    }
    if (typeof info.getLabel === 'function') {
      try {
        const label = await info.getLabel();
        if (typeof label === 'string' && label.trim()) return label;
      } catch (error) {}
    }
    for (const provider of providers) {
      if (typeof provider.getLabel !== 'function') continue;
      try {
        const label = await provider.getLabel(info.packageName);
        if (typeof label === 'string' && label.trim()) return label;
      } catch (error) {}
    }
    return info.packageName;
  }

  async function normalizeApps(infos, providers) {
    const apps = [];
    const seen = new Set();
    for (const info of infos) {
      if (!info || typeof info.packageName !== 'string' || !PACKAGE_NAME.test(info.packageName) || info.packageName.length > 255 || seen.has(info.packageName)) continue;
      seen.add(info.packageName);
      const uid = typeof info.uid === 'number' ? info.uid : null;
      const cachedIcon = icons.get(info.packageName);
      apps.push({
        packageName: info.packageName,
        appLabel: await appLabel(info, providers),
        isSystem: info.isSystem === true || info.isSystem === 1 || info.isSystem === 'true',
        uid: Number.isSafeInteger(uid) && uid >= 0 ? uid : null,
        icon: typeof cachedIcon === 'string' ? cachedIcon : null,
      });
    }
    return apps;
  }

  async function loadApps() {
    const providers = packageProviders();
    for (const provider of providers) {
      if (typeof provider.listPackages !== 'function' || typeof provider.getPackagesInfo !== 'function') continue;
      try {
        const rawPackages = await provider.listPackages('all');
        const packages = [...new Set(packageArray(rawPackages).filter((name) => typeof name === 'string' && PACKAGE_NAME.test(name) && name.length <= 255))];
        if (!packages.length) continue;
        const infos = new Map();
        for (let offset = 0; offset < packages.length; offset += 100) {
          if (typeof root.requestAnimationFrame === 'function') {
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
          const batch = packages.slice(offset, offset + 100);
          const records = packageArray(await provider.getPackagesInfo(typeof rawPackages === 'string' ? JSON.stringify(batch) : batch));
          for (const info of records) {
            if (info && !info.error && batch.includes(info.packageName) && !infos.has(info.packageName)) infos.set(info.packageName, info);
          }
        }
        if (!infos.size) continue;
        return { ok: true, apps: await normalizeApps(packages.map((packageName) => infos.get(packageName) || { packageName }), providers), source: 'kernelsu' };
      } catch (error) {}
    }
    const discovered = await shJson('discovery.sh', ['apps']);
    if (!Array.isArray(discovered.apps)) throw new Error('应用列表不是 JSON 数组');
    return { ok: true, apps: await normalizeApps(discovered.apps, providers), source: 'package-manager' };
  }

  async function getInstalledApps(refresh) {
    if (!refresh && cachedApps) return cachedApps;
    if (!refresh && pendingApps) return pendingApps;
    if (refresh) {
      cachedApps = null;
      icons.clear();
    }
    const generation = ++appsGeneration;
    const pending = loadApps();
    pendingApps = pending;
    try {
      const result = await pending;
      if (generation === appsGeneration) cachedApps = result;
      return result;
    } finally {
      if (pendingApps === pending) pendingApps = null;
    }
  }

  async function iconDataURI(blob) {
    const type = (blob.type || 'image/png').toLowerCase();
    if (!/^image\/(?:png|jpeg|webp|gif|bmp|avif|x-icon|vnd\.microsoft\.icon)$/.test(type) || blob.size > 2097152 || blob.size === 0) throw new Error('应用图标类型或大小无效');
    if (typeof blob.arrayBuffer === 'function') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length || bytes.length > 2097152) throw new Error('应用图标大小无效');
      return 'data:' + type + ';base64,' + bytesBase64(bytes);
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取应用图标失败'));
      reader.onload = () => {
        if (typeof reader.result !== 'string' || !reader.result.startsWith('data:' + type + ';base64,')) reject(new Error('应用图标数据无效'));
        else resolve(reader.result);
      };
      reader.readAsDataURL(blob);
    });
  }

  function xhrIcon(url) {
    return new Promise((resolve) => {
      const request = new XMLHttpRequest();
      let settled = false;
      let timer;
      const finish = (icon) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.onload = request.onerror = request.ontimeout = request.onabort = null;
        resolve(icon);
      };
      timer = setTimeout(() => {
        finish(null);
        request.abort();
      }, 15000);
      try {
        request.open('GET', url, true);
        request.responseType = 'blob';
        request.timeout = 15000;
        request.onload = async () => {
          try {
            if (request.status !== 0 && (request.status < 200 || request.status >= 300)) throw new Error('图标 HTTP ' + request.status);
            finish(await iconDataURI(request.response));
          } catch (error) { finish(null); }
        };
        request.onerror = request.ontimeout = request.onabort = () => finish(null);
        request.send();
      } catch (error) { finish(null); }
    });
  }

  async function readIcon(packageName) {
    const url = 'ksu://icon/' + encodeURIComponent(packageName);
    try {
      return await fetchResource(url, async (response) => iconDataURI(await response.blob()));
    } catch (error) {
      if (typeof XMLHttpRequest === 'function') {
        try { return await xhrIcon(url); } catch (xhrError) {}
      }
      return null;
    }
  }

  async function appIcon(packageName) {
    if (!icons.has(packageName)) {
      const pending = readIcon(packageName);
      icons.set(packageName, pending);
      const icon = await pending;
      if (icons.get(packageName) === pending) {
        icons.set(packageName, icon);
        if (cachedApps) {
          const app = cachedApps.apps.find((entry) => entry.packageName === packageName);
          if (app) app.icon = icon;
        }
      }
      return { ok: true, packageName, icon };
    }
    return { ok: true, packageName, icon: await icons.get(packageName) };
  }

  // ---------- 策略组图标 ----------
  // 先由浏览器直接下载（多数图标站允许跨域），失败时由模块脚本下载；结果缓存在 localStorage。
  const ICON_LIMIT = 262144;
  const ICON_CACHE_PREFIX = 'mihomo.icon:';
  const proxyIcons = new Map();

  function iconMime(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'image/webp';
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
    if (/^(<\?xml|<svg|<!--)/i.test(head) && /<svg/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)))) return 'image/svg+xml';
    return '';
  }

  function iconCache(url, value) {
    try {
      const storage = root.localStorage;
      if (!storage) return '';
      if (value === undefined) return storage.getItem(ICON_CACHE_PREFIX + url) || '';
      storage.setItem(ICON_CACHE_PREFIX + url, value);
    } catch (error) {
      // 存储已满或被禁用时只用内存缓存
    }
    return '';
  }

  async function downloadIcon(url) {
    try {
      return await fetchResource(url, async (response) => {
        if (Number(response.headers?.get('Content-Length') || 0) > ICON_LIMIT) throw new Error('图标过大');
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const chunks = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > ICON_LIMIT) throw new Error('图标过大');
              chunks.push(value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            if (!size) throw new Error('图标为空');
            return bytes;
          } finally { await reader.cancel().catch(() => {}); }
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > ICON_LIMIT) throw new Error('图标为空或过大');
        return bytes;
      }, { mode: 'cors', credentials: 'omit' });
    } catch (error) {
      // 跨域或网络失败，改由模块下载
    }
    const result = await run('host.sh', ['icon', url], 20000, {}, true);
    if (result.errno !== 0) throw new Error(result.stderr.trim() || '下载图标失败');
    return b64bytes(result.stdout);
  }

  function b64bytes(value) {
    const binary = atob(value.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function readProxyIcon(url) {
    if (url.startsWith('data:')) return url;
    const cached = iconCache(url);
    if (cached) return cached;
    const bytes = await downloadIcon(url);
    const mime = iconMime(bytes);
    if (!mime) throw new Error('不是图片');
    const icon = 'data:' + mime + ';base64,' + bytesBase64(bytes);
    iconCache(url, icon);
    return icon;
  }

  async function proxyIcon(url) {
    if (!proxyIcons.has(url)) {
      const pending = readProxyIcon(url).catch((error) => {
        proxyIcons.delete(url);
        throw error;
      });
      proxyIcons.set(url, pending);
      if (proxyIcons.size > 96) proxyIcons.delete(proxyIcons.keys().next().value);
    }
    return { ok: true, icon: await proxyIcons.get(url) };
  }

  function assertObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象');
  }

  function onlyKeys(value, keys) {
    assertObject(value);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error('不支持的参数：' + key);
  }

  function text(value, name, optional = false) {
    if (optional && value === undefined) return '';
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(name + ' 必须为不含 NUL 的字符串');
    return value;
  }

  function boolean(value, name, optional = false) {
    if (optional && value === undefined) return;
    if (typeof value !== 'boolean') throw new Error(name + ' 必须为布尔值');
  }

  function oneOf(value, values, name) {
    if (!values.includes(value)) throw new Error('不支持的 ' + name);
  }

  function httpUrl(value, name, optional = false) {
    text(value, name);
    if (optional && value === '') return;
    if (!/^https?:\/\//.test(value) || /[\x00-\x20\x7f]/.test(value)) throw new Error(name + ' 必须为 http:// 或 https:// 地址');
    try {
      const parsed = new URL(value);
      if (!parsed.hostname) throw new Error('缺少主机名');
    } catch (error) { throw new Error(name + ' 地址无效'); }
  }

  function validPackage(value) {
    text(value, 'packageName');
    if (!PACKAGE_NAME.test(value) || value.length > 255) throw new Error('包名格式无效');
  }

  function validBackup(value) {
    text(value, 'name');
    if (!/^config-[A-Za-z0-9_.-]*\.yaml(?![\s\S])/.test(value) || value.length > 255) throw new Error('备份文件名无效');
  }

  function validPolicy(payload) {
    boolean(payload.autostart, 'autostart');
    boolean(payload.tethering, 'tethering');
    oneOf(payload.wifi_mode, ['off', 'only', 'exclude'], 'wifi_mode');
    for (const name of ['tethering_interfaces', 'bypass_packages', 'wifi_ssids']) {
      text(payload[name], name);
      payload[name] = payload[name].replace(/\r\n?/g, '\n');
      if (/[\x00-\x09\x0b-\x1f\x7f]/.test(payload[name]) || new TextEncoder().encode(payload[name]).length > 32768) throw new Error(name + ' 过长或含控制字符');
    }
    payload.tethering_interfaces = payload.tethering_interfaces || DEFAULT_INTERFACES;
    if (payload.tethering_interfaces.split(',').some((name) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}(?![\s\S])/.test(name))) throw new Error('接口须为逗号分隔的有效网卡名称');
    if (payload.bypass_packages.split('\n').some((name) => name && (!PACKAGE_NAME.test(name) || !name.includes('.')))) throw new Error('包名格式无效');
    if (payload.wifi_ssids.split('\n').some((name) => new TextEncoder().encode(name).length > 32)) throw new Error('SSID 不能超过 32 字节');
  }

  function validController(payload) {
    text(payload.path, 'path');
    if (!/^\/(?:version|overview|proxies|connections|rules|ebpf|providers\/proxies|group\/[^/?]+\/delay)(?:[/?]|$)/.test(payload.path) || /[\x00-\x20\x7f#\\]/.test(payload.path)) throw new Error('不支持的控制器接口（不读取流接口）');
    const pathname = payload.path.split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch (error) { throw new Error('控制器路径编码无效'); }
    if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('控制器路径无效');
    oneOf(payload.method === undefined ? 'GET' : payload.method, ['GET', 'PUT', 'DELETE'], '控制器操作');
    if (payload.body !== undefined) {
      const body = typeof payload.body === 'string' ? text(payload.body, 'body') : JSON.stringify(payload.body);
      try { JSON.parse(body); } catch (error) { throw new Error('控制器 body 必须为 JSON'); }
      if (new TextEncoder().encode(body).length > 90000) throw new Error('控制器 body 过大');
    }
    if (payload.path.length > 8192) throw new Error('控制器路径过长');
  }

  function validTemplate(payload) {
    if (!Array.isArray(payload.subscriptions) || !payload.subscriptions.length) throw new Error('请添加订阅');
    const names = new Set();
    for (const subscription of payload.subscriptions) {
      onlyKeys(subscription, ['name', 'url', 'ua']);
      text(subscription.name, '订阅名称');
      if (!subscription.name.trim() || /[\r\n]/.test(subscription.name) || names.has(subscription.name)) throw new Error('订阅名称不能为空或重复');
      names.add(subscription.name);
      httpUrl(subscription.url, '订阅地址');
      if (subscription.ua != null) {
        text(subscription.ua, 'UA');
        if (/[\r\n]/.test(subscription.ua)) throw new Error('UA 不能包含换行');
      }
    }
    payload.secret = text(payload.secret, 'secret', true);
    if (/[\r\n]/.test(payload.secret)) throw new Error('控制器密钥不能包含换行');
    if (!payload.secret) payload.secret = Array.from(root.crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    payload.uiUrl = payload.uiUrl === undefined ? 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip' : payload.uiUrl;
    payload.rulesUrl = payload.rulesUrl === undefined ? 'https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs' : payload.rulesUrl;
    httpUrl(payload.uiUrl, 'uiUrl', true);
    httpUrl(payload.rulesUrl, 'rulesUrl');
  }

  const operations = Object.create(null);

  function register(name, keys, validate, run) {
    operations[name] = { keys, validate, run };
  }

  const noValidation = () => {};
  for (const [name, command, timeout] of [
    ['status', 'mihomo.sh status'], ['coreGetSet', 'core.sh get_settings'],
    ['coreCheck', 'core.sh check', 90000], ['coreRollback', 'core.sh rollback'],
    ['backups', 'backup.sh list'], ['policyGet', 'policy.sh get'],
    ['discoveryInterfaces', 'discovery.sh interfaces', 15000],
    ['onboardingState', 'onboarding.sh get'], ['onboardingComplete', 'onboarding.sh complete'],
    // 连通性与出口 IP 在模块所在设备上测，从别的设备打开网页时结果才有意义
    ['netCheck', 'host.sh netcheck', 20000], ['exitIp', 'host.sh exitip', 20000],
  ]) register(name, [], noValidation, () => shJson(command.split(' ')[0], command.split(' ').slice(1), timeout));

  // force：版本相同也重新下载（默认同版本直接返回 unchanged）
  register('coreUpdate', ['force'], (payload) => boolean(payload.force, 'force', true),
    (payload) => shJson('core.sh', payload.force === true ? ['download', 'force'] : ['download'], 1320000));
  register('service', ['action'], (payload) => oneOf(payload.action, ['start', 'stop', 'restart'], '服务操作'), (payload) => service(payload.action));
  register('coreInfo', [], noValidation, async () => {
    const info = await shJson('core.sh', ['info']);
    return { ...info, installed: info.installed === true, version: String(info.version || ''), can_rollback: info.can_rollback === true || info.can_rollback === 'yes' };
  });
  register('coreSet', ['repo', 'tag', 'mirror'], (payload) => {
    for (const name of ['repo', 'tag', 'mirror']) {
      payload[name] = text(payload[name], name, true);
      if (/[\r\n]/.test(payload[name]) || payload[name].length > 4096) throw new Error('下载设置格式无效');
    }
    if (payload.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repo)) throw new Error('仓库格式须为 owner/repo');
    httpUrl(payload.mirror, 'mirror', true);
  }, (payload) => shJson('core.sh', ['settings'].concat([payload.repo, payload.tag, payload.mirror].map((value) => value || '-'))));
  register('configRead', [], noValidation, async () => {
    const result = await run('host.sh', ['read-config']);
    if (result.errno !== 0 || !result.stdout.trim()) throw new Error(result.stderr || '读取配置失败（文件不存在？）');
    return { ok: true, content: b64decode(result.stdout) };
  });
  register('validate', ['content'], (payload) => text(payload.content, 'content'), async (payload) => {
    const staged = await stageConfig(payload.content);
    const result = await run('host.sh', ['validate', staged.inline || '--staged'], 120000);
    if (result.errno !== 0) throw new Error((result.stderr || result.stdout || '校验失败').trim().split('\n').slice(-5).join('\n'));
    return { ok: true };
  });
  register('apply', ['content', 'restart'], (payload) => { text(payload.content, 'content'); boolean(payload.restart, 'restart', true); }, (payload) => apply(payload.content, payload.restart));
  for (const [name, command] of [['backupDel', 'delete'], ['backupRestore', 'restore']]) {
    register(name, ['name'], (payload) => validBackup(payload.name), (payload) => shJson('backup.sh', [command, payload.name]));
  }
  register('backupRead', ['name'], (payload) => validBackup(payload.name), async (payload) => {
    const result = await run('backup.sh', ['read', payload.name]);
    if (result.errno !== 0 || !result.stdout.trim() || result.stdout.trim().startsWith('{')) {
      let message = result.stderr || '读取备份失败';
      try { message = JSON.parse(result.stdout).error || message; } catch (error) {}
      throw new Error(message);
    }
    return { ok: true, content: b64decode(result.stdout) };
  });
  register('logs', ['lines'], (payload) => {
    if (payload.lines !== undefined && (!Number.isInteger(payload.lines) || payload.lines < 1 || payload.lines > 10000)) throw new Error('lines 必须为 1–10000 的整数');
  }, async (payload) => {
    const result = await run('host.sh', ['logs', String(payload.lines || 200)]);
    if (result.errno !== 0) throw new Error(result.stderr || '读取日志失败');
    return { ok: true, content: result.stdout || result.stderr || '' };
  });
  register('policySet', ['autostart', 'tethering', 'tethering_interfaces', 'bypass_packages', 'wifi_mode', 'wifi_ssids'], validPolicy, (payload) => shJson('policy.sh', ['set',
    payload.autostart ? '1' : '0', payload.tethering ? '1' : '0', b64encode(payload.tethering_interfaces),
    b64encode(payload.bypass_packages), payload.wifi_mode, b64encode(payload.wifi_ssids),
  ], 120000));
  register('controller', ['path', 'method', 'body'], validController, controller);
  register('policySsid', [], noValidation, () => shJson('policy.sh', ['ssid'], 15000));
  register('apps', ['refresh'], (payload) => boolean(payload.refresh, 'refresh', true), (payload) => getInstalledApps(payload.refresh));
  register('appIcon', ['packageName'], (payload) => validPackage(payload.packageName), (payload) => appIcon(payload.packageName));
  register('proxyIcon', ['url'], (payload) => {
    text(payload.url, 'url');
    if (payload.url.length > 2048 || !/^(https?:\/\/[^\s]+|data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)$/i.test(payload.url)) throw new Error('图标地址无效');
  }, (payload) => proxyIcon(payload.url));
  register('template', ['subscriptions', 'secret', 'uiUrl', 'rulesUrl'], validTemplate, async (payload) => ({
    ok: true, content: renderTemplate(await fetchResource('template.yaml', (response) => response.text()), payload),
  }));

  const engine = () => {
    if (!root.mihomoConfig) throw new Error('配置引擎未加载，请重新安装完整模块');
    return root.mihomoConfig;
  };
  register('hostProbe', [], noValidation, () => shJson('host.sh', ['probe'], 20000));
  register('importUrl', ['url', 'ua'], (payload) => {
    httpUrl(payload.url, '链接');
    payload.ua = text(payload.ua, 'UA', true);
    if (/[\r\n]/.test(payload.ua) || payload.ua.length > 256) throw new Error('UA 无效');
  }, async (payload) => {
    await shJson('host.sh', ['fetch', payload.url, payload.ua || 'clash.meta'], 90000);
    const result = await run('host.sh', ['import-read'], 30000);
    if (result.errno !== 0 || !result.stdout.trim()) throw new Error(result.stderr || '读取下载内容失败');
    return { ok: true, content: b64decode(result.stdout.trim()) };
  });
  register('configSchema', ['content'], (payload) => text(payload.content, 'content'), (payload) => engine().schema(payload.content));
  register('nodeParse', ['text', 'taken'], (payload) => {
    text(payload.text, 'text');
    if (payload.text.length > 1024 * 1024) throw new Error('内容过长');
    if (payload.taken !== undefined && !Array.isArray(payload.taken)) throw new Error('taken 必须为数组');
  }, (payload) => engine().nodeParse(payload.text, payload.taken));
  register('nodeForm', ['type', 'node'], (payload) => {
    text(payload.type, 'type');
    if (payload.node !== undefined) assertObject(payload.node);
  }, (payload) => engine().nodeForm(payload.type, payload.node));
  register('nodeBuild', ['base', 'type', 'values'], (payload) => {
    text(payload.type, 'type');
    if (payload.base !== undefined) assertObject(payload.base);
    assertObject(payload.values);
  }, (payload) => engine().nodeBuild(payload.base, payload.type, payload.values));
  register('groupBuild', ['base', 'values'], (payload) => {
    if (payload.base !== undefined) assertObject(payload.base);
    assertObject(payload.values);
  }, (payload) => engine().groupBuild(payload.base, payload.values));
  register('yamlLint', ['content'], (payload) => text(payload.content, 'content'), (payload) => engine().lint(payload.content));
  register('configAnalyze', ['content'], (payload) => text(payload.content, 'content'), (payload) => engine().analyze(payload.content));
  register('configPatch', ['content', 'ops'], (payload) => {
    text(payload.content, 'content');
    if (!Array.isArray(payload.ops)) throw new Error('ops 必须为数组');
  }, (payload) => engine().patch(payload.content, payload.ops));
  register('configOptimize', ['content', 'host', 'skip'], (payload) => {
    text(payload.content, 'content');
    if (payload.host !== undefined) assertObject(payload.host);
    if (payload.skip !== undefined && (!Array.isArray(payload.skip) || payload.skip.some((item) => typeof item !== 'string'))) throw new Error('skip 必须为字符串数组');
  }, (payload) => engine().optimize(payload.content, payload.host || {}, { skip: payload.skip || [] }));

  // ---------- Tailscale ----------
  // 登录状态来自状态目录里的 tailscaled.state（只解码 _current-profile 与 _profiles，与 LuCI system.uc 一致）。

  // 与 mihomo 一致：缺省为 tailscale，相对路径相对于数据目录；只接受数据目录之内的路径
  function tailscaleDir(stateDir) {
    const dir = stateDir || 'tailscale';
    const full = (dir.startsWith('/') ? dir : DATA + '/' + dir.replace(/^(?:\.\/)+/, '')).replace(/\/+$/, '');
    if (('/' + full + '/').includes('/../') || ('/' + full + '/').includes('/./') || !full.startsWith(DATA + '/')) return null;
    return full;
  }

  function tailscaleProfile(state) {
    const empty = { loggedIn: false, login: null, tailnet: null, magicDns: null };
    if (!state || !state.exists || !state.current || !state.profiles) return empty;
    let current;
    let profiles;
    try {
      current = b64decode(state.current);
      profiles = JSON.parse(b64decode(state.profiles));
    } catch (error) {
      return empty;
    }
    if (!profiles || typeof profiles !== 'object') return empty;
    const profile = Object.entries(profiles).map(([id, item]) => (item && typeof item === 'object' && (item.Key === current || 'profile-' + id === current) ? item : null)).find(Boolean);
    if (!profile) return empty;
    return {
      loggedIn: typeof profile.NodeID === 'string' && profile.NodeID !== '',
      login: (profile.UserProfile && profile.UserProfile.LoginName) || null,
      tailnet: (profile.NetworkProfile && profile.NetworkProfile.DomainName) || null,
      magicDns: (profile.NetworkProfile && profile.NetworkProfile.MagicDNSName) || null,
    };
  }

  async function tailscaleEntries() {
    const read = await operations.configRead.run({});
    return engine().tailscale(read.content).tailscale;
  }

  async function tailscaleEntry(name) {
    const entry = (await tailscaleEntries()).find((item) => item.name === name);
    if (!entry) throw new Error('配置中没有名为 ' + name + ' 的 Tailscale 出站');
    const dir = tailscaleDir(entry.stateDir);
    if (!dir) throw new Error('state-dir 必须在数据目录之内');
    return { entry, dir };
  }

  const tailscaleName = (payload) => {
    payload.name = text(payload.name, 'name');
    if (!payload.name || payload.name.length > 128 || /[\r\n]/.test(payload.name)) throw new Error('出站名无效');
  };

  // 新内核提供 /tailscale 接口：直接返回登录状态、登录链接与本机地址；旧内核（404）或服务未运行时退回读状态文件。
  const tailscalePath = (name) => '/tailscale/' + encodeURIComponent(name).replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());

  function kernelTailscale(item) {
    if (!item || typeof item !== 'object') return null;
    const self = item.self && typeof item.self === 'object' ? item.self : {};
    const state = typeof item.state === 'string' ? item.state : '';
    return {
      state,
      loggedIn: state === 'Running' || state === 'Starting' || (typeof item.login === 'string' && item.login !== '' && state !== 'NeedsLogin'),
      login: state === 'NeedsLogin' ? null : item.login || null,
      tailnet: item.tailnet || null,
      magicDns: item.magicDNSSuffix || null,
      hostName: self.hostName || null,
      dnsName: self.dnsName ? String(self.dnsName).replace(/\.$/, '') : null,
      ips: Array.isArray(self.ips) ? self.ips.filter((ip) => typeof ip === 'string') : [],
      authUrl: typeof item.authURL === 'string' && /^https?:\/\//.test(item.authURL) ? item.authURL : null,
      error: typeof item.error === 'string' ? item.error : (Array.isArray(item.health) && item.health.length ? item.health.join('；') : null),
      serve: Array.isArray(item.serve) ? item.serve : [],
    };
  }

  async function kernelTailscaleList() {
    try {
      const status = await readStatus('');
      if (!status.running) return null;
      const result = await controller({ path: '/tailscale' });
      return result.data && Array.isArray(result.data.tailscale) ? result.data.tailscale : null;
    } catch (error) {
      return null; // 旧内核没有该接口或控制器不可用
    }
  }

  async function tailscaleStatus(entries) {
    const list = [];
    if (!entries.length) return { ok: true, list, kernel: false };
    const kernel = await kernelTailscaleList();
    for (const entry of entries) {
      const dir = tailscaleDir(entry.stateDir);
      const live = kernel && kernelTailscale(kernel.find((value) => value && value.name === entry.name));
      const saved = !live || live.state === 'NotStarted';
      const state = saved && dir ? await shJson('tailscale.sh', ['state', dir]) : null;
      const item = { name: entry.name, stateDir: dir, authKey: entry.used, kernel: !!live, ...tailscaleProfile(state) };
      if (live) {
        const merged = { ...item, ...live };
        if (saved) Object.assign(merged, tailscaleProfile(state));
        list.push(merged);
      } else {
        list.push(item);
      }
    }
    return { ok: true, list, kernel: kernel !== null };
  }

  register('tailscaleStatus', [], noValidation, async () => tailscaleStatus(await tailscaleEntries()));
  register('tailscaleRead', [], noValidation, async () => {
    const read = await operations.configRead.run({});
    const schema = engine().tailscale(read.content);
    const status = await tailscaleStatus(schema.tailscale);
    return { ...schema, ...status, content: read.content };
  });
  register('tailscaleLogin', ['name', 'wait'], (payload) => {
    tailscaleName(payload);
    if (payload.wait !== undefined && (!Number.isInteger(payload.wait) || payload.wait < 5 || payload.wait > 60)) throw new Error('wait 必须为 5–60 的整数');
  }, async (payload) => {
    await tailscaleEntry(payload.name);
    const wait = payload.wait || 20;
    try {
      const result = await controller({ path: tailscalePath(payload.name) + '/login?wait=' + wait, method: 'POST', timeout: (wait + 10) * 1000 });
      const live = result.data && result.data.name === payload.name ? kernelTailscale(result.data) : null;
      if (live) return { ok: true, url: live.authUrl, running: live.state === 'Running', state: live.state, error: live.error, kernel: true };
    } catch (error) {
      // 内核明确报错（如启动失败）时直接返回；接口不存在（旧内核）或控制器不可用时走旧方式
      if (/控制器 HTTP (?!404)\d{3}/.test(error.message)) throw new Error('登录失败：' + error.message);
    }
    // 旧内核：订阅日志并用测速唤醒节点，从日志里取登录链接
    const detected = await detectController();
    return shJson('tailscale.sh', ['login', detected.address, tailscalePath(payload.name).slice('/tailscale/'.length), JSON.stringify(payload.name).slice(1, -1), String(wait)],
      (wait + 20) * 1000, { MIHOMO_SECRET: detected.secret });
  });
  register('tailscaleLogout', ['name'], tailscaleName, async (payload) => {
    const { dir } = await tailscaleEntry(payload.name);
    try {
      const result = await controller({ path: tailscalePath(payload.name) + '/logout', method: 'POST', timeout: 20000 });
      if (result.data === null) return { ok: true, restarted: false, kernel: true };
    } catch (error) {
      if (/控制器 HTTP (?!404|503)\d{3}/.test(error.message)) throw new Error('退出登录失败：' + error.message);
    }
    return shJson('tailscale.sh', ['logout', dir], 120000);
  });
  register('openUrl', ['url'], (payload) => httpUrl(payload.url, 'url'), (payload) => {
    // 网页管理时在当前浏览器打开；在管理器里用系统浏览器打开
    if (remoteMode()) {
      root.open(payload.url, '_blank', 'noopener');
      return { ok: true };
    }
    return shJson('tailscale.sh', ['open', payload.url]);
  });
  register('qrCode', ['text'], (payload) => {
    text(payload.text, 'text');
    if (!payload.text || payload.text.length > 1024) throw new Error('二维码内容须为 1–1024 个字符');
  }, async (payload) => {
    if (typeof root.qrcode !== 'function') throw new Error('二维码组件未加载，请重新安装完整模块');
    const code = root.qrcode(0, 'M');
    code.addData(payload.text, 'Byte');
    code.make();
    const size = code.getModuleCount();
    const rows = [];
    for (let row = 0; row < size; row++) {
      let line = '';
      for (let column = 0; column < size; column++) line += code.isDark(row, column) ? '1' : '0';
      rows.push(line);
    }
    return { ok: true, size, rows };
  });

  // ---------- 网页管理 ----------
  const WEBUI_KEYS = ['enabled', 'port', 'lan', 'allow_cidrs', 'require_password', 'tailscale', 'tailscale_no_password', 'tailscale_users', 'session_hours'];

  register('webuiStatus', [], noValidation, () => shJson('webui.sh', ['status'], 20000));
  register('webuiSet', ['settings'], (payload) => {
    assertObject(payload.settings);
    for (const [key, value] of Object.entries(payload.settings)) {
      if (!WEBUI_KEYS.includes(key)) throw new Error('不支持的设置：' + key);
      if (['enabled', 'lan', 'require_password', 'tailscale', 'tailscale_no_password'].includes(key)) boolean(value, key);
      else if (key === 'port' || key === 'session_hours') {
        if (!Number.isInteger(value)) throw new Error(key + ' 必须为整数');
      } else if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || /[\s,]/.test(item) || item.length > 254)) {
        throw new Error(key + ' 必须为不含空白的字符串列表');
      }
    }
  }, (payload) => shJson('webui.sh', ['set', b64encode(JSON.stringify(payload.settings))], 30000));
  register('webuiPasswd', ['password'], (payload) => {
    text(payload.password, 'password');
    if (payload.password && (payload.password.length < 6 || payload.password.length > 256)) throw new Error('密码须为 6–256 个字符');
  }, (payload) => shJson('webui.sh', ['passwd', b64encode(payload.password)], 30000));
  // 当前页面是否经网页管理打开，以及来源（lan / tailscale / local）
  register('webuiSession', [], noValidation, async () => {
    if (!remoteMode()) return { ok: true, remote: false };
    const body = await remoteJson('api/session', {});
    return { ok: true, remote: true, via: String(body.via || ''), login: String(body.login || ''), passwordless: body.passwordless === true };
  });
  register('webuiLogout', [], noValidation, async () => {
    if (!remoteMode()) return { ok: true };
    await remoteJson('api/logout', { method: 'POST' });
    root.location.href = 'login';
    return { ok: true };
  });

  let enhancedToken = '';
  const enhancedActions = ['status', 'unlock', 'lock', 'battery', 'sms', 'hotspot', 'hotspot-set', 'terminal', 'scrcpy-set', 'scrcpy-stop'];
  register('enhancedSet', ['settings'], (payload) => {
    if (remoteMode() || !root.ksu) throw new Error('增强功能设置只能在本机模块 WebUI 修改');
    assertObject(payload.settings);
    for (const [key, value] of Object.entries(payload.settings)) {
      if (key === 'enabled' || key === 'scrcpy') boolean(value, key);
      else if (key === 'password') {
        text(value, key);
        if (value && (Array.from(value).length < 6 || new TextEncoder().encode(value).length > 256)) throw new Error('操作密码须为 6–256 个字符');
      } else if (key === 'scrcpy_port') {
        if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('web scrcpy 端口无效');
      } else if (key === 'scrcpy_mode') {
        if (!['builtin', 'external'].includes(value)) throw new Error('屏幕服务模式无效');
      } else throw new Error('不支持的增强设置：' + key);
    }
  }, async (payload) => {
    enhancedToken = '';
    return shJson('webui.sh', ['enhanced-set', b64encode(JSON.stringify(payload.settings))], 30000);
  });

  register('enhanced', ['action', 'payload'], (payload) => {
    if (!enhancedActions.includes(payload.action)) throw new Error('不允许的增强操作');
    assertObject(payload.payload || {});
    const keys = { status: [], unlock: ['password'], lock: [], battery: [], sms: ['limit'], hotspot: [],
      'hotspot-set': ['enabled', 'config'], terminal: ['command', 'timeout'],
      'scrcpy-set': ['enabled', 'port', 'mode', 'max_size', 'fps', 'bit_rate'], 'scrcpy-stop': [] }[payload.action];
    for (const key of Object.keys(payload.payload || {})) if (!keys.includes(key)) throw new Error('不支持的操作参数：' + key);
    if (JSON.stringify(payload.payload || {}).length > 20000) throw new Error('增强操作参数过大');
  }, async (payload) => {
    try {
      const body = payload.payload || {};
      const result = remoteMode()
        ? await remoteJson('api/enhanced/' + payload.action, {
          method: payload.action === 'status' ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(payload.action === 'status' ? {} : { body: JSON.stringify(body) }),
        }, payload.action === 'terminal' ? 65000 : 30000)
        : await shJson('webui.sh', ['enhanced-request', payload.action, b64encode(JSON.stringify({ token: enhancedToken, payload: body }))], payload.action === 'terminal' ? 70000 : 35000);
      if (payload.action === 'unlock') enhancedToken = result.token || '';
      if (payload.action === 'lock') enhancedToken = '';
      return result;
    } catch (error) {
      return { ok: false, error: error.message, locked: error.locked === true || /操作密码|增强功能已锁定/.test(error.message) };
    }
  });

  register('scrcpyUrl', [], noValidation, async () => {
    const session = await operations.enhanced.run({ action: 'status' });
    if (!session.ok || !session.enabled || !session.scrcpy) throw new Error('请先开启增强功能和 web scrcpy 入口');
    if (remoteMode()) {
      if (!session.unlocked) throw new Error('请先解锁增强功能');
      return { ok: true, url: root.location.origin + '/enhanced/scrcpy/' };
    }
    const settings = await operations.webuiStatus.run({});
    return { ok: true, url: 'http://127.0.0.1:' + settings.settings.port + '/login?next=%2F%23enhanced' };
  });

  // zashboard：内核在 /ui/ 提供面板；setup 参数让面板自动添加并连接本机控制器
  register('dashboard', [], noValidation, async () => {
    const detected = await detectController();
    if (!detected.ui) return { ok: true, available: false, reason: '配置里没有 external-ui，面板未启用' };
    const params = new URLSearchParams({ disableUpgradeCore: '1' });
    if (remoteMode()) {
      // 经网页管理的 /clash/ 反向代理访问控制器
      const location = root.location;
      const https = location.protocol === 'https:';
      params.set('hostname', location.hostname);
      params.set('port', location.port || (https ? '443' : '80'));
      params.set('secondaryPath', '/clash');
      params.set(https ? 'https' : 'http', '1');
      return { ok: true, available: true, url: location.origin + '/clash/ui/#/setup?' + params.toString() };
    }
    if (detected.secret) params.set('secret', detected.secret);
    const port = detected.address.slice(detected.address.lastIndexOf(':') + 1);
    const host = detected.address.slice('http://'.length, detected.address.lastIndexOf(':')).replace(/^\[|\]$/g, '');
    params.set('hostname', host);
    params.set('port', port);
    return { ok: true, available: true, url: detected.address + '/ui/#/setup?' + params.toString() };
  });

  // 诊断信息：去掉订阅链接、密钥、UUID、公网地址等后再交给页面复制
  function redact(text) {
    return text
      .replace(/\b(https?|wss?|ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|anytls|socks5?):\/\/[^\s'"]+/gi, (match, scheme) => scheme + '://***')
      .replace(/((?:secret|password|passwd|auth-key|authkey|token|private-key|pre-shared-key|psk|uuid|sid|short-id|public-key|key)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***-uuid')
      .replace(/\btskey-[A-Za-z0-9-]+/g, 'tskey-***')
      .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '***')
      .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (match, a, b) => {
        const first = Number(a);
        const second = Number(b);
        const local = first === 10 || first === 127 || first === 0 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second < 32)
          || (first === 100 && second >= 64 && second < 128) || (first === 169 && second === 254) || (first === 198 && (second === 18 || second === 19)) || first >= 224;
        return local ? match : a + '.' + b + '.x.x';
      })
      .replace(/\b(?:2[0-9a-f]{3}|3[0-9a-f]{3}):[0-9a-f:]{4,}/gi, (match) => match.split(':').slice(0, 2).join(':') + ':…');
  }

  register('diagnostics', [], noValidation, async () => {
    const [info, status] = await Promise.all([run('host.sh', ['diag'], 30000), readStatus('').catch(() => null)]);
    const lines = ['# mihomo-ebpf 诊断信息', '时间: ' + new Date().toISOString()];
    if (status) lines.push('服务: ' + (status.running ? '运行中' : '未运行') + (status.paused ? '（Wi-Fi 条件暂停）' : '') + (status.uptime ? '，已运行 ' + status.uptime + ' 秒' : ''));
    return { ok: true, content: redact(lines.join('\n') + '\n' + String(info.stdout || '')).slice(0, 200000) };
  });

  // ---------- Sub-Store ----------
  // 本机运行时后端在 http://127.0.0.1:端口/路径，前端在同一端口的根路径；已有服务时 url 即后端地址。
  const SUBSTORE_FRONTEND = 'https://sub-store.vercel.app/';

  function substoreBase(status, host) {
    if (status.mode === 'local') return 'http://' + (host || '127.0.0.1') + ':' + status.port + '/' + status.path;
    if (status.mode === 'remote' && status.url) return status.url.replace(/\/+$/, '');
    return '';
  }

  function substoreView(status) {
    // 经网页管理从其它设备访问时，本机地址要换成手机的局域网地址（需开启 Sub-Store 局域网访问）
    const remote = remoteMode();
    const host = remote ? root.location.hostname : '127.0.0.1';
    const reachable = status.mode === 'remote' || !remote || status.lan;
    const base = substoreBase(status, host);
    let open = '';
    if (status.mode === 'local' && status.running && reachable) open = 'http://' + host + ':' + status.port + '/?api=' + encodeURIComponent(base);
    if (status.mode === 'remote' && base) open = SUBSTORE_FRONTEND + '?api=' + encodeURIComponent(base);
    return { ...status, base: substoreBase(status), open, reachable };
  }

  register('substoreStatus', [], noValidation, async () => substoreView(await shJson('substore.sh', ['status'])));
  register('substoreSet', ['mode', 'port', 'lan', 'url'], (payload) => {
    oneOf(payload.mode, ['off', 'local', 'remote'], '模式');
    if (!Number.isInteger(payload.port) || payload.port < 1024 || payload.port > 65535) throw new Error('端口须为 1024–65535');
    boolean(payload.lan, 'lan');
    text(payload.url, 'url', true);
    if (payload.url && (!/^https?:\/\/[^\s"']+$/.test(payload.url) || payload.url.length > 1024)) throw new Error('地址须为 http(s) 链接');
    if (payload.mode === 'remote' && !payload.url) throw new Error('请填写 Sub-Store 后端地址');
  }, async (payload) => substoreView(await shJson('substore.sh', ['set', payload.mode, String(payload.port), payload.lan ? '1' : '0',
    payload.url ? b64encode(payload.url) : '-'], 60000)));
  register('substoreInstall', ['what'], (payload) => oneOf(payload.what === undefined ? 'all' : payload.what, ['all', 'node', 'backend', 'frontend'], '下载项'),
    async (payload) => substoreView(await shJson('substore.sh', ['install', payload.what || 'all'], 1200000)));
  register('substoreService', ['action'], (payload) => oneOf(payload.action, ['start', 'stop', 'restart', 'reset-path', 'uninstall'], '操作'),
    async (payload) => substoreView(await shJson('substore.sh', [payload.action], 60000)));
  register('substoreList', [], noValidation, async () => {
    const status = await shJson('substore.sh', ['status']);
    const base = substoreBase(status);
    if (!base) throw new Error('没有启用 Sub-Store');
    const result = await run('substore.sh', ['list'], 40000);
    if (result.errno !== 0) {
      let message = result.stderr || '读取订阅失败';
      try { message = JSON.parse(result.stdout).error || message; } catch (error) { /* 保留 stderr */ }
      throw new Error(message);
    }
    const [subsText, collectionsText] = result.stdout.split('\n');
    const items = (textValue) => {
      try {
        const body = JSON.parse(textValue);
        return Array.isArray(body && body.data) ? body.data : [];
      } catch (error) {
        return [];
      }
    };
    // target=ClashMeta 让 Sub-Store 输出 mihomo（Clash.Meta）格式的节点
    const link = (kind, name) => base + '/download/' + (kind === 'collection' ? 'collection/' : '') + encodeURIComponent(name) + '?target=ClashMeta';
    const list = [];
    for (const item of items(subsText)) if (item && typeof item.name === 'string') list.push({ kind: 'sub', name: item.name, title: item.displayName || item['display-name'] || item.name, url: link('sub', item.name) });
    for (const item of items(collectionsText)) if (item && typeof item.name === 'string') list.push({ kind: 'collection', name: item.name, title: item.displayName || item['display-name'] || item.name, url: link('collection', item.name) });
    return { ok: true, list };
  });

  // 一键更新面板：内核按 external-ui-url 重新下载并解压到 external-ui 目录
  register('dashboardUpgrade', [], noValidation, async () => {
    const detected = await detectController();
    if (!detected.ui) throw new Error('配置里没有 external-ui，面板未启用');
    const status = await readStatus('');
    if (!status.running) throw new Error('服务没有运行，无法更新面板');
    await controller({ path: '/upgrade/ui', method: 'POST', timeout: 120000 });
    return { ok: true };
  });

  root.mihomoBridge = Object.freeze({
    async request(operation, payloadJson = '{}') {
      try {
        if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(operations, operation)) throw new Error('不支持的操作');
        if (typeof payloadJson !== 'string') throw new Error('payloadJson 必须为 JSON 字符串');
        const payload = JSON.parse(payloadJson);
        const handler = operations[operation];
        onlyKeys(payload, handler.keys);
        handler.validate(payload);
        return JSON.stringify(await handler.run(payload));
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && error.message || error || '未知错误') });
      }
    },
  });
})(window);
