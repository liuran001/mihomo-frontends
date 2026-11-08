'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../webui/bridge/backend.js'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '../../shared/template.yaml'), 'utf8');
const scriptRoot = 'sh /data/adb/modules/mihomo-ebpf/scripts/';
const policy = {
  autostart: false, tethering: false, tethering_interfaces: 'ap0,wlan1,rndis0,usb0,bt-pan',
  bypass_packages: '', wifi_mode: 'off', wifi_ssids: '',
};
const subscriptions = [{ name: '订阅一', url: 'https://example.com/subscription' }];

function result(stdout = '', errno = 0, stderr = '') {
  return { errno, stdout, stderr };
}

function jsonResult(value, errno = 0, stderr = '') {
  return result(JSON.stringify(value), errno, stderr);
}

function httpResult(value, status = 200) {
  return result((value === undefined ? '' : JSON.stringify(value)) + '\n__MIHOMO_HTTP__:' + status);
}

function shellWords(command) {
  const words = [];
  let word = '';
  let quoted = false;
  let present = false;
  for (let offset = 0; offset < command.length; offset++) {
    const character = command[offset];
    if (character === "'") {
      quoted = !quoted;
      present = true;
    } else if (character === '\\' && !quoted) {
      assert.ok(offset + 1 < command.length, 'shell escape must have a following character');
      word += command[++offset];
      present = true;
    } else if (/\s/.test(character) && !quoted) {
      if (present) words.push(word);
      word = '';
      present = false;
    } else {
      if (!quoted) assert.doesNotMatch(character, /[;$`&|<>"()]/, 'arguments must not contain active shell syntax');
      word += character;
      present = true;
    }
  }
  assert.equal(quoted, false, 'shell quotes must balance');
  if (present) words.push(word);
  return words;
}

// 控制器请求经 host.sh api METHOD URL [BODY]，密钥在 MIHOMO_SECRET 环境变量里
function isCurl(command) {
  return command.includes(scriptRoot + 'host.sh api ');
}

function isDetect(command) {
  return command === scriptRoot + 'host.sh controller';
}

// 还原成等价的 curl 参数，便于按 --url / --header 取值
function curlArguments(command) {
  assert.ok(isCurl(command));
  const words = shellWords(command);
  assert.ok(words[0].startsWith('MIHOMO_SECRET='), 'secret travels in the environment');
  const secret = words[0].slice('MIHOMO_SECRET='.length);
  assert.equal(words[1], 'sh');
  assert.equal(words[2], scriptRoot.slice(3) + 'host.sh');
  assert.equal(words[3], 'api');
  const [method, url, body] = words.slice(4);
  assert.ok(words.length === 6 || words.length === 7);
  return ['--request', method, '--header', 'Authorization: Bearer ' + secret]
    .concat(body === undefined ? [] : ['--header', 'Content-Type: application/json', '--data-binary', body])
    .concat(['--url', url]);
}

function makeBridge(options = {}) {
  const timers = new Map();
  const events = new Map();
  let now = 0;
  let timerSequence = 0;
  const bridge = {
    commands: [], fetches: [], calls: [], timers,
    handler: options.handler,
    status: { ok: true, running: false, desired: 'stopped', allowed: true, current_ssid: '', ...options.status },
    pendingCallbacks: () => Object.keys(bridge.context).filter((name) => name.startsWith('__mihomo_bridge_cb_')),
    advance(milliseconds) {
      now += milliseconds;
      for (const [timer, entry] of [...timers]) {
        if (entry.deadline <= now) {
          timers.delete(timer);
          entry.callback();
        }
      }
    },
    dispatch(name) {
      for (const callback of events.get(name) || []) callback();
    },
    async raw(operation, payloadJson) {
      const pending = bridge.context.mihomoBridge.request(operation, payloadJson);
      assert.equal(typeof pending.then, 'function', 'request must return a Promise');
      const response = await pending;
      assert.equal(typeof response, 'string', 'request must resolve to a JSON string');
      const parsed = JSON.parse(response);
      assert.equal(typeof parsed.ok, 'boolean');
      return parsed;
    },
    request(operation, payload = {}) {
      return bridge.raw(operation, JSON.stringify(payload));
    },
  };
  const sandbox = {
    TextEncoder, TextDecoder, Uint8Array, URL, URLSearchParams, AbortController, crypto: webcrypto,
    btoa: (value) => Buffer.from(value, 'latin1').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('latin1'),
    setTimeout(callback, delay) {
      const timer = ++timerSequence;
      timers.set(timer, { callback, deadline: now + delay });
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    addEventListener(name, callback) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(callback);
    },
    fetch(url, init) {
      bridge.fetches.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      if (url === 'template.yaml') return Promise.resolve({ ok: true, status: 200, text: async () => template });
      return Promise.reject(new Error('unsupported URL'));
    },
    ksu: {
      exec(command, executionOptions, callbackName) {
        bridge.commands.push(command);
        const callback = bridge.context[callbackName];
        bridge.calls.push({ command, executionOptions, callbackName, callback });
        let response = bridge.handler && bridge.handler(command, callbackName);
        if (response === null) return;
        if (response === undefined) {
          if (command === scriptRoot + 'mihomo.sh status') response = jsonResult(bridge.status);
          else if (command === scriptRoot + 'core.sh info') response = jsonResult({ ok: true, installed: true, version: 'test', can_rollback: 'no' });
          else if (isDetect(command)) response = result('external-controller: 127.0.0.1:9090\nsecret: "test-secret"');
          else if (isCurl(command)) response = httpResult({ version: 'test' });
          else if (command === scriptRoot + 'discovery.sh apps') response = jsonResult({ ok: true, apps: [], source: 'package-manager' });
          else response = jsonResult({ ok: true });
        }
        callback(response.errno, response.stdout, response.stderr);
      },
      ...options.ksu,
    },
    ...options.globals,
  };
  if (options.remote) {
    // 网页管理：没有 ksu，页面来自 http(s)
    delete sandbox.ksu;
    sandbox.location = { protocol: 'http:', hostname: '192.168.1.5', port: '9099', origin: 'http://192.168.1.5:9099', pathname: '/', hash: '', href: 'http://192.168.1.5:9099/', ...options.remote };
    sandbox.open = (...args) => bridge.opened.push(args);
  }
  sandbox.window = sandbox;
  bridge.opened = [];
  bridge.context = vm.createContext(sandbox);
  vm.runInContext(source, bridge.context, { filename: 'backend.js' });
  assert.equal('document' in bridge.context, false, 'the backend must load without a DOM');
  assert.equal('process' in bridge.context, false);
  assert.equal('require' in bridge.context, false);
  return bridge;
}

function assertClean(bridge) {
  assert.deepEqual(bridge.pendingCallbacks(), []);
  assert.equal(bridge.timers.size, 0);
  for (const call of bridge.calls) assert.equal(call.executionOptions, '{}');
}

function assertError(response, pattern = /.+/) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(typeof response.error, 'string');
  assert.match(response.error, pattern);
}

function makeXHRBridge(options = {}) {
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  class XMLHttpRequestMock {
    constructor() {
      this.onload = this.onerror = this.ontimeout = this.onabort = null;
      this.status = 0;
      this.response = null;
      this.responseType = '';
      this.timeout = 0;
      this.sendCount = 0;
      this.abortCount = 0;
      announce(this);
    }

    open(...args) {
      this.openArguments = args;
      if (options.throwAt === 'open') throw new Error('open failed');
    }

    send() {
      this.sendCount++;
      if (options.throwAt === 'send') throw new Error('send failed');
    }

    abort() {
      this.abortCount++;
      if (this.onabort) this.onabort();
    }
  }
  const bridge = makeBridge({
    globals: { XMLHttpRequest: XMLHttpRequestMock },
    fetch: async () => { throw new TypeError('URL scheme ksu is not supported'); },
  });
  return { bridge, started };
}

function assertCleanXHR(bridge, request) {
  assertClean(bridge);
  for (const name of ['onload', 'onerror', 'ontimeout', 'onabort']) assert.equal(request[name], null, name + ' must be cleared');
  assert.deepEqual(bridge.commands, []);
}

test('public bridge is frozen and returns Promise<string JSON> without a DOM', async () => {
  const bridge = makeBridge();
  assert.ok(Object.isFrozen(bridge.context.mihomoBridge));
  assert.deepEqual(Object.keys(bridge.context.mihomoBridge), ['request']);
  assert.deepEqual(await bridge.raw('status'), bridge.status);
  assert.deepEqual(bridge.commands, [scriptRoot + 'mihomo.sh status']);
  assertClean(bridge);
});

test('unknown operations and malformed JSON payloads never reach native code', async () => {
  const bridge = makeBridge();
  for (const operation of ['exec', 'sh', '__proto__', 'constructor', 'toString', 'status;id', '', null, 1, {}]) {
    assertError(await bridge.request(operation), /不支持的操作/);
  }
  for (const payload of ['{', 'null', '[]', 'true', '42', '"text"', '', {}, 1, null]) {
    assertError(await bridge.raw('status', payload));
  }
  assert.deepEqual(bridge.commands, []);
  assert.deepEqual(bridge.fetches, []);
  assertClean(bridge);
});

test('every operation rejects unknown parameters before executing or fetching', async () => {
  const bridge = makeBridge();
  for (const operation of [
    'status', 'coreGetSet', 'coreUpdate', 'coreCheck', 'coreRollback', 'backups', 'policyGet', 'discoveryInterfaces', 'netCheck', 'exitIp',
    'service', 'coreInfo', 'coreSet', 'configRead', 'validate', 'apply', 'backupDel', 'backupRestore',
    'backupRead', 'logs', 'policySet', 'controller', 'template', 'apps', 'appIcon', 'moduleCheck', 'moduleCurrent', 'moduleUpgrade',
  ]) {
    assertError(await bridge.request(operation, { command: 'id' }), /不支持的参数/);
    assertError(await bridge.raw(operation, '{"__proto__":{"command":"id"}}'), /不支持的参数/);
  }
  assert.deepEqual(bridge.commands, []);
  assert.deepEqual(bridge.fetches, []);
  assertClean(bridge);
});

test('operation validators reject shell injection and invalid types without side effects', async () => {
  const bridge = makeBridge();
  for (const [operation, payload] of [
    ['service', { action: 'start; id' }], ['service', { action: null }],
    ['validate', { content: 'x\0y' }], ['validate', { content: 123 }],
    ['apply', { content: 'config', restart: 'true' }],
    ['coreSet', { repo: 'owner/repo;id' }], ['coreSet', { tag: 'latest\nid' }],
    ['coreSet', { mirror: 'file:///etc/passwd' }], ['coreSet', { tag: 'a'.repeat(4097) }],
    ['moduleUpgrade', { force: 'yes; id' }],
    ['logs', { lines: '1;id' }], ['logs', { lines: 0 }], ['logs', { lines: 10001 }],
    ['logs', { lines: 1.5 }], ['logs', { lines: null }],
    ['apps', { refresh: 1 }], ['appIcon', { packageName: '../system' }],
    ['appIcon', { packageName: 'com.app;id' }], ['appIcon', { packageName: 'com.app\n' }],
    ['appIcon', { packageName: 'com.' + 'a'.repeat(252) }],
    ['policySet', { ...policy, tethering_interfaces: 'ap0\n' }],
  ]) assertError(await bridge.request(operation, payload));
  for (const operation of ['backupRead', 'backupRestore', 'backupDel']) {
    for (const name of ['../config-x.yaml', 'config-../x.yaml', 'config-x.yaml;id', 'config-x.yaml\n', 'x.yaml', 'config-' + 'x'.repeat(250) + '.yaml']) {
      assertError(await bridge.request(operation, { name }), /备份文件名/);
    }
  }
  assert.deepEqual(bridge.commands, []);
  assert.deepEqual(bridge.fetches, []);
  assertClean(bridge);
});

test('JSON commands reject nonzero exit, invalid JSON, non-object data and nonboolean ok', async () => {
  for (const response of [
    jsonResult({ ok: true }, 7), jsonResult({ ok: false, error: '后端拒绝' }),
    jsonResult({ ok: 'true' }), jsonResult(null), jsonResult([]), jsonResult(1), result('garbage'),
    result('', 1, 'permission denied'), result('{"ok":true}', 'invalid'),
  ]) {
    const bridge = makeBridge({ handler: () => response });
    assertError(await bridge.request('status'));
    assertClean(bridge);
  }
  const bridge = makeBridge({ handler: () => jsonResult({ ok: true, running: false }, '0') });
  assert.equal((await bridge.request('status')).ok, true);
  assertClean(bridge);
});

test('callback timeout, missing bridge, native throw and pagehide clean up and ignore late callbacks', async () => {
  for (const scenario of ['timeout', 'missing', 'throw', 'pagehide']) {
    const bridge = makeBridge({ handler: () => null });
    if (scenario === 'missing') delete bridge.context.ksu;
    if (scenario === 'throw') bridge.handler = () => { throw new Error('native failed'); };
    const pending = bridge.request('status');
    const callback = bridge.calls[0] && bridge.calls[0].callback;
    if (scenario === 'timeout') {
      bridge.advance(29999);
      assert.equal(bridge.pendingCallbacks().length, 1);
      bridge.advance(1);
    }
    if (scenario === 'pagehide') bridge.dispatch('pagehide');
    const response = await pending;
    assertError(response, scenario === 'timeout' ? /超时.*可能仍在执行/ : scenario === 'pagehide' ? /页面已关闭/ : /不可用/);
    assertClean(bridge);
    if (callback) {
      callback(0, '{"ok":true}', '');
      callback(0, '{"ok":true}', '');
      assert.equal(response.ok, false);
      assertClean(bridge);
    }
  }
});

test('concurrent callbacks resolve independently out of order and clean up exactly once', async () => {
  const bridge = makeBridge({ handler: () => null });
  const first = bridge.request('status');
  const second = bridge.request('coreInfo');
  assert.equal(new Set(bridge.calls.map((call) => call.callbackName)).size, 2);
  bridge.calls[1].callback(0, JSON.stringify({ ok: true, installed: true, version: 'second', can_rollback: 'yes' }), '');
  assert.equal((await second).version, 'second');
  assert.equal(bridge.timers.size, 1);
  bridge.calls[1].callback(1, '', 'duplicate');
  assert.equal(bridge.timers.size, 1);
  bridge.advance(30000);
  assertError(await first, /超时/);
  assertClean(bridge);
});

test('pagehide settles all outstanding operations and removes every timer', async () => {
  const bridge = makeBridge({ handler: () => null });
  const pending = ['status', 'coreUpdate', 'backups'].map((operation) => bridge.request(operation));
  assert.equal(bridge.timers.size, 3);
  bridge.dispatch('pagehide');
  for (const response of await Promise.all(pending)) assertError(response, /页面已关闭/);
  bridge.dispatch('pagehide');
  assertClean(bridge);
});

test('long core updates retain their dedicated timeout instead of the default timeout', async () => {
  const bridge = makeBridge({ handler: () => null });
  const pending = bridge.request('coreUpdate');
  bridge.advance(1319999);
  assert.equal(bridge.pendingCallbacks().length, 1);
  bridge.advance(1);
  assertError(await pending, /超时/);
  assertClean(bridge);
});

test('validate and apply inline up to 120000 Base64 bytes and stage larger configs in chunks', async () => {
  const bridge = makeBridge({ status: { running: true, desired: 'manual' } });
  for (const content of ['a'.repeat(90000), '界'.repeat(30000), '😀'.repeat(22500)]) {
    const encoded = Buffer.from(content).toString('base64');
    assert.equal(encoded.length, 120000);
    for (const operation of ['validate', 'apply']) {
      bridge.commands.length = 0;
      assert.equal((await bridge.request(operation, { content })).ok, true);
      assert.equal(bridge.commands.length, 1);
      assert.ok(bridge.commands[0].includes("'" + encoded + "'"));
      assertClean(bridge);
    }
    for (const [operation, restart] of [['validate', undefined], ['apply', false], ['apply', true]]) {
      bridge.commands.length = 0;
      const larger = content + 'a';
      const response = await bridge.request(operation, { content: larger, ...(restart === undefined ? {} : { restart }) });
      assert.equal(response.ok, true, JSON.stringify(response));
      const stages = bridge.commands.filter((command) => command.startsWith(scriptRoot + 'host.sh stage '));
      assert.ok(stages.every((command, index) => bridge.commands[index] === command), 'stages run first');
      assert.equal(stages.length, 2);
      assert.ok(stages[0].startsWith(scriptRoot + "host.sh stage '0' "));
      const joined = stages.map((command) => command.split(' ').at(-1).slice(1, -1)).join('');
      assert.equal(joined, Buffer.from(larger).toString('base64'));
      const final = bridge.commands[stages.length];
      if (operation === 'apply') assert.ok(final.startsWith(scriptRoot + "apply.sh '--staged'"));
      else assert.equal(final, scriptRoot + "host.sh validate '--staged'");
      assertClean(bridge);
    }
  }
  const huge = await bridge.request('apply', { content: 'a'.repeat(4194305) });
  assertError(huge, /4 MB/);
});

test('stage failures abort before apply runs', async () => {
  const bridge = makeBridge({ handler: (command) => command.includes("host.sh stage '1' ") ? result('{"ok":false,"error":"写入暂存文件失败"}', 1) : undefined });
  const response = await bridge.request('apply', { content: 'a'.repeat(100000) });
  assertError(response, /暂存/);
  assert.ok(!bridge.commands.some((command) => command.includes('apply.sh')));
  assertClean(bridge);
});

test('host probe, URL import and config engine operations are exposed with validation', async () => {
  const bridge = makeBridge({ handler: (command) => {
    if (command === scriptRoot + 'host.sh probe') return jsonResult({ ok: true, ipv6: false, mem_mb: 4000 });
    if (command.startsWith(scriptRoot + 'host.sh fetch ')) return jsonResult({ ok: true, size: 12 });
    if (command === scriptRoot + 'host.sh import-read') return result(Buffer.from('mixed-port: 1\n').toString('base64'));
    return undefined;
  } });
  assert.equal((await bridge.request('hostProbe')).ipv6, false);
  const imported = await bridge.request('importUrl', { url: 'https://example.com/a?b=1', ua: 'clash.meta' });
  assert.equal(imported.content, 'mixed-port: 1\n');
  assert.ok(bridge.commands.some((command) => command === scriptRoot + "host.sh fetch 'https://example.com/a?b=1' 'clash.meta'"));
  assertError(await bridge.request('importUrl', { url: 'file:///etc/passwd' }), /链接/);
  assertError(await bridge.request('importUrl', { url: 'https://e.x', ua: 'a\nb' }), /UA/);
  assertError(await bridge.request('configSchema', { content: 'a: 1' }), /配置引擎未加载/);
  assertClean(bridge);
});

test('configuration text uses Base64 instead of interpolating shell syntax', async () => {
  const content = 'secret: "\' ; $(id) `whoami` & > /tmp/injected"\n# 中文 😀';
  const bridge = makeBridge();
  for (const operation of ['validate', 'apply']) {
    assert.equal((await bridge.request(operation, { content })).ok, true);
    const command = bridge.commands.at(-1);
    assert.ok(command.includes("'" + Buffer.from(content).toString('base64') + "'"));
    assert.ok(!command.includes('$(id)'));
  }
  assertClean(bridge);
});

test('service start and restart report SSID pause as enabled, not running', async () => {
  for (const desired of ['manual', 'auto']) {
    for (const action of ['start', 'restart']) {
      const bridge = makeBridge({ status: { running: false, allowed: false, desired, current_ssid: ' 未授权 Wi-Fi ' } });
      const response = await bridge.request('service', { action });
      assert.equal(response.ok, true);
      assert.equal(response.paused, true);
      assert.match(response.message, /SSID.*暂停.* 未授权 Wi-Fi .*自动恢复/);
      assert.deepEqual(bridge.commands, [scriptRoot + 'mihomo.sh ' + action, scriptRoot + 'mihomo.sh status']);
      assertClean(bridge);
    }
  }
});

test('service stop must clear desired resume intent even when the process is already stopped', async () => {
  for (const desired of ['manual', 'auto']) {
    const bridge = makeBridge({ status: { running: false, allowed: false, desired } });
    assertError(await bridge.request('service', { action: 'stop' }), /自动恢复意图未取消/);
    assertClean(bridge);
  }
  const bridge = makeBridge({ status: { running: false, allowed: false, desired: 'stopped' } });
  assert.deepEqual(await bridge.request('service', { action: 'stop' }), { ok: true, paused: false, message: '服务已停止' });
  bridge.status.running = true;
  assertError(await bridge.request('service', { action: 'stop' }), /仍在运行/);
  assertClean(bridge);
});

test('service and apply verify final status and never mask command or status failures', async () => {
  for (const operation of ['service', 'apply']) {
    const payload = operation === 'service' ? { action: 'start' } : { content: 'config', restart: true };
    const bridge = makeBridge({ status: { running: true, desired: 'manual' } });
    assert.equal((await bridge.request(operation, payload)).paused, false);
    bridge.status.running = false;
    assertError(await bridge.request(operation, payload), /服务未运行/);
    bridge.handler = (command) => command.endsWith('mihomo.sh status') ? result('invalid') : undefined;
    assertError(await bridge.request(operation, payload), /无法确认服务状态/);
    bridge.commands.length = 0;
    bridge.handler = () => result('', 3, 'permission denied');
    assertError(await bridge.request(operation, payload), /permission denied/);
    assert.equal(bridge.commands.length, 1);
    assertClean(bridge);
  }
});

test('apply restart accepts SSID pause while save-only never queries service state', async () => {
  const bridge = makeBridge({ status: { running: false, desired: 'auto', allowed: false, current_ssid: '机场' } });
  bridge.handler = (command) => command.includes('apply.sh ') ? jsonResult({ ok: true, backup: 'config-old.yaml' }) : undefined;
  const response = await bridge.request('apply', { content: 'config', restart: true });
  assert.equal(response.ok, true);
  assert.equal(response.paused, true);
  assert.equal(response.backup, 'config-old.yaml');
  assert.match(response.message, /SSID.*暂停.*机场/);
  bridge.commands.length = 0;
  assert.deepEqual(await bridge.request('apply', { content: 'config', restart: false }), { ok: true, backup: 'config-old.yaml' });
  assert.equal(bridge.commands.length, 1);
  assert.ok(!bridge.commands[0].endsWith(' restart'));
  assertClean(bridge);
});

test('coreInfo normalizes rollback strings and returns typed installed/version fields', async () => {
  for (const [canRollback, expected] of [['yes', true], ['no', false], [true, true], [false, false], ['', false], [undefined, false]]) {
    const bridge = makeBridge({ handler: () => jsonResult({ ok: true, installed: true, version: 'v1', platform: 'android', can_rollback: canRollback }) });
    assert.deepEqual(await bridge.request('coreInfo'), { ok: true, installed: true, version: 'v1', platform: 'android', can_rollback: expected });
    assertClean(bridge);
  }
  const bridge = makeBridge({ handler: () => jsonResult({ ok: true }) });
  assert.deepEqual(await bridge.request('coreInfo'), { ok: true, installed: false, version: '', can_rollback: false });
  assertClean(bridge);
});

test('coreGetSet and backups preserve the actual backend contracts', async () => {
  const settings = { ok: true, repo: 'liuran001/mihomo', tag: 'Prerelease-Alpha', mirror: '' };
  const backups = { ok: true, list: [{ name: 'config-20261104.yaml', size: 1234 }] };
  const bridge = makeBridge({ handler: (command) => command.endsWith('get_settings') ? jsonResult(settings) : jsonResult(backups) });
  assert.deepEqual(await bridge.request('coreGetSet'), settings);
  assert.deepEqual(await bridge.request('backups'), backups);
  assert.deepEqual(bridge.commands, [scriptRoot + 'core.sh get_settings', scriptRoot + 'backup.sh list']);
  assertClean(bridge);
});

test('policyGet and discoveryInterfaces preserve the backend response contracts', async () => {
  const configuredPolicy = { ok: true, ...policy, autostart: true, wifi_mode: 'only', wifi_ssids: ' 家庭 Wi-Fi ', current_ssid: ' 家庭 Wi-Fi ', allowed: true };
  const interfaces = { ok: true, interfaces: [
    { name: 'ap0', kind: 'wifi', present: true, state: 'up', upstream: false, suggested: true },
    { name: 'rmnet_data0', kind: 'cellular', present: true, state: 'up', upstream: true, suggested: false },
  ], current_ssid: ' 家庭 Wi-Fi ' };
  const bridge = makeBridge({ handler: (command) => command.endsWith('policy.sh get') ? jsonResult(configuredPolicy) : jsonResult(interfaces) });
  assert.deepEqual(await bridge.request('policyGet'), configuredPolicy);
  assert.deepEqual(await bridge.request('discoveryInterfaces'), interfaces);
  assert.deepEqual(bridge.commands, [scriptRoot + 'policy.sh get', scriptRoot + 'discovery.sh interfaces']);
  assertClean(bridge);
});

test('discoveryInterfaces times out after 15 seconds independently of policyGet', async () => {
  const bridge = makeBridge({ handler: () => null });
  const discovery = bridge.request('discoveryInterfaces');
  const configuredPolicy = bridge.request('policyGet');
  bridge.advance(14999);
  assert.equal(bridge.pendingCallbacks().length, 2);
  bridge.advance(1);
  assertError(await discovery, /超时/);
  assert.equal(bridge.pendingCallbacks().length, 1);
  bridge.calls[0].callback(0, '{"ok":true,"interfaces":[]}', '');
  assert.equal(bridge.pendingCallbacks().length, 1);
  bridge.calls[1].callback(0, JSON.stringify({ ok: true, ...policy }), '');
  assert.deepEqual(await configuredPolicy, { ok: true, ...policy });
  assertClean(bridge);
});

test('coreSet quotes tag and mirror literally and maps empty settings to reset sentinels', async () => {
  const bridge = makeBridge();
  const settings = { repo: 'liuran001/mihomo', tag: "release';$(id);`whoami`", mirror: "https://mirror.example/a'$(id)?x=1&y=2" };
  assert.equal((await bridge.request('coreSet', settings)).ok, true);
  assert.deepEqual(shellWords(bridge.commands[0]), ['sh', '/data/adb/modules/mihomo-ebpf/scripts/core.sh', 'settings', settings.repo, settings.tag, settings.mirror]);
  assert.equal((await bridge.request('coreSet')).ok, true);
  assert.deepEqual(shellWords(bridge.commands[1]).slice(-3), ['-', '-', '-']);
  assertClean(bridge);
});

test('backup operations use named script actions and preserve literal backup filenames', async () => {
  const bridge = makeBridge();
  for (const [operation, action] of [['backupDel', 'delete'], ['backupRestore', 'restore']]) {
    assert.deepEqual(await bridge.request(operation, { name: 'config-2026_11.04-1.yaml' }), { ok: true });
    assert.deepEqual(shellWords(bridge.commands.at(-1)), ['sh', '/data/adb/modules/mihomo-ebpf/scripts/backup.sh', action, 'config-2026_11.04-1.yaml']);
  }
  assertClean(bridge);
});

test('configRead and backupRead decode wrapped UTF-8 Base64 and reject bad output or exit status', async () => {
  const content = 'secret: "中文 😀"\nmode: rule\n';
  const encoded = Buffer.from(content).toString('base64');
  for (const operation of ['configRead', 'backupRead']) {
    const payload = operation === 'backupRead' ? { name: 'config-valid.yaml' } : {};
    const bridge = makeBridge({ handler: () => result(encoded.match(/.{1,12}/g).join('\r\n') + '\n') });
    assert.deepEqual(await bridge.request(operation, payload), { ok: true, content });
    for (const response of [result(encoded, 1, 'read denied'), result(''), result('%%%'), result('abc'), result('Zh=='), jsonResult({ ok: false, error: '备份不存在' }, 1)]) {
      bridge.handler = () => response;
      assertError(await bridge.request(operation, payload));
      assertClean(bridge);
    }
    if (operation === 'backupRead') {
      bridge.handler = () => jsonResult({ ok: false, error: '备份不存在' });
      assertError(await bridge.request(operation, payload), /备份不存在/);
      assert.ok(bridge.commands[0].includes("backup.sh read 'config-valid.yaml'"));
    }
    assertClean(bridge);
  }
});

test('logs exposes a stable object with content, bounded line count and errors', async () => {
  const bridge = makeBridge({ handler: () => result('内核日志\nAndroid 日志\n') });
  assert.deepEqual(await bridge.request('logs'), { ok: true, content: '内核日志\nAndroid 日志\n' });
  assert.equal(bridge.commands[0], scriptRoot + "host.sh logs '200'");
  for (const lines of [1, 300, 10000]) {
    assert.equal((await bridge.request('logs', { lines })).ok, true);
    assert.equal(bridge.commands.at(-1), scriptRoot + "host.sh logs '" + lines + "'");
  }
  bridge.handler = () => result('');
  assert.deepEqual(await bridge.request('logs'), { ok: true, content: '' });
  bridge.handler = () => result('', 2, '日志不可读');
  assertError(await bridge.request('logs'), /日志不可读/);
  assertClean(bridge);
});

test('controller parses quoted YAML scalars safely and falls back to curl when the page cannot reach it', async () => {
  for (const [config, address, secret] of [
    ['external-controller: 0.0.0.0:9090 # local\nsecret: "a b\\\"c" # comment', '127.0.0.1:9090', 'a b"c'],
    ["external-controller: '[::]:9091'\nsecret: 'it''s # exact'", '127.0.0.1:9091', "it's # exact"],
    ['external-controller: "[::1]:9092"\nsecret: bare#hash', '[::1]:9092', 'bare#hash'],
    ['external-controller: :9093\nsecret: null', '127.0.0.1:9093', ''],
    ['external-controller: "*:9094"\nsecret: "new-secret"', '127.0.0.1:9094', 'new-secret'],
  ]) {
    const bridge = makeBridge({ handler: (command) => isDetect(command) ? result(config) : undefined });
    assert.deepEqual(await bridge.request('controller', { path: '/version' }), { ok: true, data: { version: 'test' } });
    assert.equal(bridge.commands.length, 2);
    assert.equal(bridge.commands[0], scriptRoot + 'host.sh controller');
    assert.equal(bridge.fetches.length, 1, 'direct attempt first');
    assert.equal(bridge.fetches[0].url, 'http://' + address + '/version');
    assert.equal(bridge.fetches[0].init.headers.Authorization, 'Bearer ' + secret);
    const args = curlArguments(bridge.commands.at(-1));
    assert.equal(args[args.indexOf('--url') + 1], 'http://' + address + '/version');
    assert.equal(args[args.indexOf('--header') + 1], 'Authorization: Bearer ' + secret);
    assertClean(bridge);
  }
});

test('controller talks to mihomo directly when possible and caches the detected address', async () => {
  const bridge = makeBridge({
    fetch: async (url, init) => ({ status: url.endsWith('/proxies/missing') ? 404 : 200, text: async () => (url.endsWith('/proxies/missing') ? 'not found' : JSON.stringify({ url, method: init.method, body: init.body || null })) }),
  });
  const first = await bridge.request('controller', { path: '/proxies/a', method: 'PUT', body: { name: 'b' } });
  assert.deepEqual(first.data, { url: 'http://127.0.0.1:9090/proxies/a', method: 'PUT', body: '{"name":"b"}' });
  assert.equal(bridge.fetches[0].init.headers.Authorization, 'Bearer test-secret');
  assert.equal(bridge.fetches[0].init.headers['Content-Type'], 'application/json');
  await bridge.request('controller', { path: '/version' });
  assert.deepEqual(bridge.commands, [scriptRoot + 'host.sh controller'], 'no curl, and the address is detected once');
  assertError(await bridge.request('controller', { path: '/proxies/missing' }), /HTTP 404/);
  assert.equal(bridge.commands.filter(isCurl).length, 0, 'HTTP errors do not fall back to curl');
  await bridge.request('apply', { content: 'port: 1\n', restart: false });
  await bridge.request('controller', { path: '/version' });
  assert.equal(bridge.commands.filter(isDetect).length, 2, 'saving the config re-detects the controller');
});

test('controller stops trying the direct path for a while once curl succeeds after it failed', async () => {
  const bridge = makeBridge();
  await bridge.request('controller', { path: '/version' });
  await bridge.request('controller', { path: '/proxies' });
  assert.equal(bridge.fetches.length, 1);
  assert.equal(bridge.commands.filter(isCurl).length, 2);
});

test('remote mode reaches the controller through the same-origin /clash proxy', async () => {
  const bridge = remoteBridge((body) => body.args[0] === 'controller' ? { errno: 0, stdout: 'external-controller: 127.0.0.1:9090\nsecret: "k"', stderr: '' } : undefined);
  const original = bridge.context.fetch;
  bridge.context.fetch = async (url, init) => url.startsWith('http://192.168.1.5:9099/clash/')
    ? { status: 200, text: async () => JSON.stringify({ url, auth: init.headers.Authorization, credentials: init.credentials }) } : original(url, init);
  const response = await bridge.request('controller', { path: '/version' });
  assert.deepEqual(response.data, { url: 'http://192.168.1.5:9099/clash/version', credentials: 'same-origin' });
  assert.equal(bridge.runs.length, 0, 'remote reads neither controller secrets nor shell scripts');
});

test('commands use ksu.spawn when the manager provides it so the page is not blocked', async () => {
  const spawned = [];
  const bridge = makeBridge({ ksu: { spawn(command, args, options, callbackName) {
    spawned.push({ command, args, options });
    const target = bridge.context[callbackName];
    target.stdout.emit('data', '{"ok":true,');
    target.stdout.emit('data', '"running":true}');
    target.stderr.emit('data', 'warn');
    target.emit('exit', 0);
  } } });
  const status = await bridge.request('status');
  assert.equal(status.running, true);
  assert.deepEqual(spawned, [{ command: scriptRoot + 'mihomo.sh status', args: '[]', options: '{}' }]);
  assert.deepEqual(bridge.commands, [], 'ksu.exec is not used');
  assertClean(bridge);
});

test('concurrent controller requests never share detected address or secret', async () => {
  const bridge = makeBridge({ handler: (command) => isDetect(command) ? null : undefined });
  const first = bridge.request('controller', { path: '/version' });
  const second = bridge.request('controller', { path: '/proxies' });
  assert.equal(bridge.calls.length, 2);
  bridge.calls[1].callback(0, 'external-controller: 127.0.0.1:9192\nsecret: "second"', '');
  assert.equal((await second).ok, true);
  bridge.calls[0].callback(0, 'external-controller: 127.0.0.1:9191\nsecret: "first"', '');
  assert.equal((await first).ok, true);
  const curlCalls = bridge.commands.filter(isCurl).map(curlArguments);
  assert.equal(curlCalls.length, 2);
  for (const [args, suffix, secret] of [[curlCalls[0], ':9192/proxies', 'second'], [curlCalls[1], ':9191/version', 'first']]) {
    assert.ok(args[args.indexOf('--url') + 1].endsWith(suffix));
    assert.equal(args[args.indexOf('--header') + 1], 'Authorization: Bearer ' + secret);
  }
  assertClean(bridge);
});

test('controller quotes every curl argument when it falls back to curl', async () => {
  const secret = "secret';$(id);`whoami`";
  const body = { name: "节点';$(id);`whoami`", nested: { enabled: true } };
  const target = "/proxies/group'$(id)?name=%E4%B8%AD&value=1";
  const bridge = makeBridge({ handler: (command) => isDetect(command) ? result('external-controller: 127.0.0.1:9090\nsecret: ' + JSON.stringify(secret)) : httpResult(undefined, 204) });
  assert.deepEqual(await bridge.request('controller', { path: target, method: 'PUT', body }), { ok: true, data: null });
  const command = bridge.commands.at(-1);
  const args = curlArguments(command);
  assert.deepEqual(args, [
    '--request', 'PUT', '--header', 'Authorization: Bearer ' + secret, '--header', 'Content-Type: application/json',
    '--data-binary', JSON.stringify(body), '--url', 'http://127.0.0.1:9090' + target,
  ]);
  assert.ok(command.startsWith('MIHOMO_SECRET='));
  assert.equal(bridge.fetches.length, 1);
  assertClean(bridge);
});

test('controller handles 204, empty 200 and pre-serialized JSON bodies', async () => {
  const bridge = makeBridge();
  for (const status of [200, 204]) {
    bridge.handler = (command) => isCurl(command) ? httpResult(undefined, status) : undefined;
    assert.deepEqual(await bridge.request('controller', { path: '/connections/id', method: 'DELETE' }), { ok: true, data: null });
  }
  bridge.handler = undefined;
  assert.equal((await bridge.request('controller', { path: '/proxies/name', method: 'PUT', body: '{"name":"节点"}' })).ok, true);
  const args = curlArguments(bridge.commands.at(-1));
  assert.equal(args[args.indexOf('--data-binary') + 1], '{"name":"节点"}');
  assertClean(bridge);
});

test('controller surfaces curl, HTTP, missing status and invalid JSON errors', async () => {
  for (const [response, pattern] of [
    [result('', 127, 'curl not found'), /curl.*curl not found/],
    [result('', 28, 'operation timed out'), /timed out/],
    [httpResult({ message: 'Unauthorized' }, 401), /HTTP 401.*Unauthorized/],
    [httpResult({ message: 'failure' }, 500), /HTTP 500/],
    [httpResult(undefined, 302), /HTTP 302/],
    [result('{}'), /缺少 HTTP 状态码/],
    [result('not JSON\n__MIHOMO_HTTP__:200'), /不是 JSON/],
  ]) {
    const bridge = makeBridge({ handler: (command) => isCurl(command) ? response : undefined });
    assertError(await bridge.request('controller', { path: '/version' }), pattern);
    assertClean(bridge);
  }
});

test('controller refuses streaming endpoints, traversal, malformed encodings and invalid parameters', async () => {
  const bridge = makeBridge();
  for (const target of [
    '/traffic', '/logs', '/memory', '/configs', '/providers/rules', '/rulesets', '/ebpfx', '/versioned', '//evil.example/version',
    'https://evil.example/version', '/proxies/../configs', '/proxies/%2e%2e/configs',
    '/proxies/%2e/configs', '/proxies/%2F..%2Fconfigs', '/proxies/%5c..%5cconfigs',
    '/proxies/has space', '/proxies/a#fragment', '/proxies/%00', '/proxies/%0a', '/proxies/%ZZ',
    '/proxies/' + 'a'.repeat(8192),
  ]) assertError(await bridge.request('controller', { path: target }));
  for (const payload of [
    { path: '/version', method: 'POST' }, { path: '/version', method: 'get' },
    { path: '/version', method: '' }, { path: '/version', method: null },
    { path: '/version', method: false }, { path: '/version', method: 0 },
    { path: '/version', body: 'not JSON' }, { path: '/version', body: '"' + '界'.repeat(30000) + '"' },
  ]) assertError(await bridge.request('controller', payload));
  assert.deepEqual(bridge.commands, []);
  assert.deepEqual(bridge.fetches, []);
  assertClean(bridge);
});

test('controller rejects unsafe config before constructing curl arguments', async () => {
  for (const config of [
    '', 'secret: "no controller"', 'external-controller: 127.0.0.1:0', 'external-controller: 127.0.0.1:65536',
    'external-controller: 127.0.0.1:9090;id', 'external-controller: "unterminated',
    'external-controller: 127.0.0.1:9090\nsecret: |',
    'external-controller: 127.0.0.1:9090\nsecret: "bad\\nheader"',
    'external-controller: 127.0.0.1:9090\nsecret: "bad\\u0000header"',
  ]) {
    const bridge = makeBridge({ handler: () => result(config) });
    assertError(await bridge.request('controller', { path: '/version' }));
    assert.equal(bridge.commands.length, 1);
    assertClean(bridge);
  }
});

test('template uses the actual bundled template via relative fetch with secure defaults and random secrets', async () => {
  const bridge = makeBridge();
  const secrets = [];
  for (let count = 0; count < 2; count++) {
    const response = await bridge.request('template', { subscriptions });
    assert.equal(response.ok, true);
    const content = response.content;
    assert.match(content, /^external-controller: 127\.0\.0\.1:9090$/m);
    assert.match(content, /^allow-lan: false$/m);
    assert.match(content, /^bind-address: 127\.0\.0\.1$/m);
    assert.match(content, /^    mode: local$/m);
    assert.match(content, /^      interface: \[\]$/m);
    assert.match(content, /^  type: smart$/m);
    assert.ok(content.includes('    url: "https://example.com/subscription"'));
    assert.ok(content.includes('external-ui-url: "https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip"'));
    assert.ok(content.includes('https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs'));
    assert.doesNotMatch(content, /^\s*#@(providers|use|secret|ui-url|fake-ip-filter-url|lan)\s*$/m);
    const secret = /^secret: "([a-f0-9]{24})"$/m.exec(content);
    assert.ok(secret);
    secrets.push(secret[1]);
    assertClean(bridge);
  }
  assert.notEqual(secrets[0], secrets[1]);
  assert.deepEqual(bridge.fetches.map((fetch) => fetch.url), ['template.yaml', 'template.yaml']);
  assert.deepEqual(bridge.commands, []);
});

test('template escapes YAML-sensitive fields and supports explicit secret, UI and rule URLs', async () => {
  const bridge = makeBridge();
  const subscription = { name: '../订阅: "quoted"', url: 'https://example.com/?value=a:b', ua: 'agent "quoted" # text' };
  const secret = "secret';$(id)#literal";
  const response = await bridge.request('template', { subscriptions: [subscription], secret, uiUrl: '', rulesUrl: 'https://rules.example/fakeip.mrs' });
  assert.equal(response.ok, true);
  assert.ok(response.content.includes('  ' + JSON.stringify(subscription.name) + ':'));
  assert.ok(response.content.includes('    - ' + JSON.stringify(subscription.name)));
  assert.ok(response.content.includes('    path: ' + JSON.stringify('./proxy_provider/' + encodeURIComponent(subscription.name) + '.yaml')));
  assert.ok(response.content.includes('      additional-prefix: ' + JSON.stringify('[' + subscription.name + ']')));
  assert.ok(response.content.includes('    header:\n      User-Agent: [' + JSON.stringify(subscription.ua) + ']'));
  assert.ok(response.content.includes('secret: ' + JSON.stringify(secret)));
  assert.ok(response.content.includes('    url: "https://rules.example/fakeip.mrs"'));
  assert.ok(response.content.includes('    url: "https://rules.example/fakeip.mrs"\n    proxy: "DIRECT"'), '经镜像下载规则集时直连');
  const direct = await bridge.request('template', { subscriptions: [subscription], secret, uiUrl: '' });
  assert.ok(direct.content.includes('fakeip-filter.mrs"\n    proxy: "节点选择"'), '直连 GitHub 时经代理下载规则集（与 LuCI 一致）');
  assert.doesNotMatch(response.content, /^external-ui-url:/m);
  assertClean(bridge);
});

test('template validation rejects duplicate names, nested extras, newlines and non-HTTP resources', async () => {
  const bridge = makeBridge();
  for (const payload of [
    { subscriptions: [] }, { subscriptions: {} }, { subscriptions: [...subscriptions, ...subscriptions] },
    { subscriptions: [{ ...subscriptions[0], name: '  ' }] },
    { subscriptions: [{ ...subscriptions[0], name: 'name\nsecret: bad' }] },
    { subscriptions: [{ ...subscriptions[0], path: '/etc/passwd' }] },
    { subscriptions: [{ ...subscriptions[0], ua: 'header\r\nInjected: yes' }] },
    { subscriptions: [{ ...subscriptions[0], url: 'file:///etc/passwd' }] },
    { subscriptions, secret: 'bad\nsecret' }, { subscriptions, rulesUrl: 'ksu://icon/com.app' },
    { subscriptions, uiUrl: 'javascript:alert(1)' },
  ]) assertError(await bridge.request('template', payload));
  assert.deepEqual(bridge.commands, []);
  assert.deepEqual(bridge.fetches, []);
  assertClean(bridge);
});

test('template resource failures and timeout return errors and cancel timers', async () => {
  for (const fetch of [
    async () => ({ ok: false, status: 404 }),
    async () => { throw new Error('fetch failed'); },
  ]) {
    const bridge = makeBridge({ fetch });
    assertError(await bridge.request('template', { subscriptions }), /404|fetch failed/);
    assertClean(bridge);
  }
  const bridge = makeBridge({ fetch: () => new Promise(() => {}) });
  const pending = bridge.request('template', { subscriptions });
  bridge.advance(15000);
  assertError(await pending, /超时/);
  assert.equal(bridge.fetches[0].init.signal.aborted, true);
  assertClean(bridge);
});

test('policy preserves exact SSIDs including spaces, duplicates and shell metacharacters', async () => {
  const bridge = makeBridge();
  const ssids = " 家庭 Wi-Fi \r\nO'Reilly;$(id)\r家庭 Wi-Fi\r\n家庭 Wi-Fi\r\n";
  const payload = { ...policy, autostart: true, wifi_mode: 'only', tethering_interfaces: '', bypass_packages: 'com.example.app\r\ncom.second.app', wifi_ssids: ssids };
  assert.equal((await bridge.request('policySet', payload)).ok, true);
  const words = shellWords(bridge.commands[0]);
  assert.deepEqual(words.slice(0, 5), ['sh', '/data/adb/modules/mihomo-ebpf/scripts/policy.sh', 'set', '1', '0']);
  assert.equal(words.length, 9);
  assert.equal(Buffer.from(words[5], 'base64').toString(), policy.tethering_interfaces);
  assert.equal(Buffer.from(words[6], 'base64').toString(), 'com.example.app\ncom.second.app');
  assert.equal(words[7], 'only');
  assert.equal(Buffer.from(words[8], 'base64').toString(), ssids.replace(/\r\n?/g, '\n'));
  assertClean(bridge);
});

test('policy enforces UTF-8 byte limits per SSID and across the full value', async () => {
  const bridge = makeBridge();
  for (const wifi_ssids of ['a'.repeat(32), '界'.repeat(10) + 'ab', '😀'.repeat(8), 'wifi\rname', ('a'.repeat(31) + '\n').repeat(1024)]) {
    assert.equal((await bridge.request('policySet', { ...policy, wifi_ssids })).ok, true);
    assertClean(bridge);
  }
  bridge.commands.length = 0;
  for (const wifi_ssids of ['a'.repeat(33), '界'.repeat(11), '😀'.repeat(9), ('a'.repeat(31) + '\n').repeat(1024) + 'a', 'wifi\tname', 'wifi\x7fname']) {
    assertError(await bridge.request('policySet', { ...policy, wifi_ssids }));
  }
  for (const override of [
    { autostart: 'true' }, { tethering: 1 }, { wifi_mode: 'allow' },
    { tethering_interfaces: 'ap0;id' }, { tethering_interfaces: 'ap0, wlan1' },
    { tethering_interfaces: 'a'.repeat(16) }, { bypass_packages: 'com.app\nid' },
    { bypass_packages: 'com.app;id' },
  ]) assertError(await bridge.request('policySet', { ...policy, ...override }));
  assert.deepEqual(bridge.commands, []);
  assertClean(bridge);
});

test('apps supports actual synchronous KernelSU JSON-string method signatures', async () => {
  const nativeCalls = [];
  const bridge = makeBridge({ ksu: {
    listPackages(type) {
      nativeCalls.push(['listPackages', type]);
      return JSON.stringify(['com.native.app', 'com.android.settings']);
    },
    getPackagesInfo(packagesJson) {
      nativeCalls.push(['getPackagesInfo', packagesJson]);
      if (typeof packagesJson !== 'string') throw new Error('native requires JSON string');
      return JSON.stringify(JSON.parse(packagesJson).map((packageName, index) => ({ packageName, appLabel: index ? '设置' : '原生应用', isSystem: index ? true : null, uid: index ? 1000 : null })));
    },
  } });
  assert.deepEqual(await bridge.request('apps'), {
    ok: true, source: 'kernelsu', apps: [
      { packageName: 'com.native.app', appLabel: '原生应用', isSystem: false, uid: null, icon: null },
      { packageName: 'com.android.settings', appLabel: '设置', isSystem: true, uid: 1000, icon: null },
    ],
  });
  assert.deepEqual(nativeCalls, [['listPackages', 'all'], ['getPackagesInfo', '["com.native.app","com.android.settings"]']]);
  assert.deepEqual(bridge.commands, []);
  assert.deepEqual(bridge.fetches, []);
  assertClean(bridge);
});

test('apps supports array and Promise-array wrappers with array arguments', async () => {
  for (const asynchronous of [false, true]) {
    const argumentsSeen = [];
    const bridge = makeBridge({ ksu: {
      listPackages: () => asynchronous ? Promise.resolve(['com.wrapper.app']) : ['com.wrapper.app'],
      getPackagesInfo(packages) {
        argumentsSeen.push(packages);
        if (!Array.isArray(packages)) throw new Error('wrapper requires array');
        const infos = [{ packageName: packages[0], appLabel: '包装应用', isSystem: false, uid: 10099 }];
        return asynchronous ? Promise.resolve(infos) : infos;
      },
    } });
    assert.deepEqual(await bridge.request('apps'), { ok: true, source: 'kernelsu', apps: [{ packageName: 'com.wrapper.app', appLabel: '包装应用', isSystem: false, uid: 10099, icon: null }] });
    assert.equal(argumentsSeen.length, 1);
    assert.equal(Array.isArray(argumentsSeen[0]), true);
    assert.deepEqual(Array.from(argumentsSeen[0]), ['com.wrapper.app']);
    assert.deepEqual(bridge.commands, []);
    assertClean(bridge);
  }
});

test('apps prefers pm object or pm() provider and retains legacy fallback', async () => {
  for (const shape of ['object', 'function', 'unsupported', 'throw']) {
    const seen = [];
    const provider = {
      listPackages: () => { seen.push('pm'); return '["com.pm.app"]'; },
      getPackagesInfo: () => '[{"packageName":"com.pm.app","appLabel":"PM 应用","isSystem":false,"uid":10001}]',
    };
    const bridge = makeBridge({ ksu: {
      pm: shape === 'object' ? provider : shape === 'unsupported' ? { ...provider, support: false } : () => {
        if (shape === 'throw') throw new Error('pm unavailable');
        return provider;
      },
      listPackages: () => { seen.push('legacy'); return '["com.legacy.app"]'; },
      getPackagesInfo: () => '[{"packageName":"com.legacy.app","appLabel":"旧版应用"}]',
    } });
    const response = await bridge.request('apps');
    assert.equal(response.ok, true);
    assert.equal(response.source, 'kernelsu');
    assert.equal(response.apps[0].packageName, ['object', 'function'].includes(shape) ? 'com.pm.app' : 'com.legacy.app');
    assert.deepEqual(seen, [['object', 'function'].includes(shape) ? 'pm' : 'legacy']);
    assertClean(bridge);
  }
});

test('apps batches native package information by 100 and drops invalid or unsolicited packages', async () => {
  const packages = Array.from({ length: 205 }, (_, index) => 'com.batch.app' + index);
  const batchSizes = [];
  const bridge = makeBridge({ ksu: {
    listPackages: () => JSON.stringify([...packages, packages[0], '../bad', 'com.bad;id', null]),
    getPackagesInfo(packagesJson) {
      const batch = JSON.parse(packagesJson);
      batchSizes.push(batch.length);
      return JSON.stringify([...batch.map((packageName) => ({ packageName, appLabel: '名称 ' + packageName, uid: 10001 })), { packageName: 'com.unrequested.app', appLabel: '不可注入' }]);
    },
  } });
  const response = await bridge.request('apps');
  assert.equal(response.ok, true);
  assert.equal(response.source, 'kernelsu');
  assert.deepEqual(response.apps.map((app) => app.packageName), packages);
  assert.deepEqual(batchSizes, [100, 100, 5]);
  assertClean(bridge);
});

test('apps preserves the first native package record when multiple Android users share a package', async () => {
  const bridge = makeBridge({ ksu: {
    pm: () => ({
      listPackages: () => '["com.shared.app"]',
      getPackagesInfo: () => JSON.stringify([
        { packageName: 'com.shared.app', appLabel: '所有者应用', isSystem: false, uid: 10001 },
        { packageName: 'com.shared.app', appLabel: '工作配置应用', isSystem: false, uid: 1010001 },
      ]),
    }),
  } });
  const expected = { ok: true, source: 'kernelsu', apps: [
    { packageName: 'com.shared.app', appLabel: '所有者应用', isSystem: false, uid: 10001, icon: null },
  ] };
  assert.deepEqual(await bridge.request('apps'), expected);
  assert.deepEqual(await bridge.request('apps'), expected);
  assert.deepEqual(bridge.commands, []);
  assertClean(bridge);
});

test('apps resolves friendly labels from fields and functions before falling back to package names', async () => {
  const infos = [
    { packageName: 'com.labels.first', appLabel: '应用名', label: '不优先' },
    { packageName: 'com.labels.second', appLabel: 'com.labels.second', label: '标签' },
    { packageName: 'com.labels.third', getLabel: '旧版标签' },
    { packageName: 'com.labels.fourth', getLabel() { return '方法标签'; } },
    { packageName: 'com.labels.fifth' },
    { packageName: 'com.labels.sixth', appLabel: '' },
  ];
  const bridge = makeBridge({ ksu: {
    listPackages: () => infos.map((info) => info.packageName),
    getPackagesInfo: () => infos,
    getLabel: (packageName) => packageName === 'com.labels.fifth' ? Promise.resolve('管理器标签') : '',
  } });
  const response = await bridge.request('apps');
  assert.equal(response.ok, true);
  assert.deepEqual(response.apps.map((app) => app.appLabel), ['应用名', '标签', '旧版标签', '方法标签', '管理器标签', 'com.labels.sixth']);
  assertClean(bridge);
});

test('apps falls back to discovery with a stable package-manager contract', async () => {
  const bridge = makeBridge({
    ksu: { listPackages: () => 'not JSON', getPackagesInfo: () => '[]' },
    handler: () => jsonResult({ ok: true, source: 'untrusted', apps: [
      { packageName: 'com.fallback.app', appLabel: '回退应用', uid: 10042, isSystem: true },
      { packageName: 'com.fallback.app', appLabel: '重复' },
      { packageName: 'com.bad;id', appLabel: '无效' },
      { packageName: 'com.fallback.other', uid: -1, icon: 'javascript:bad' },
    ] }),
  });
  assert.deepEqual(await bridge.request('apps'), { ok: true, source: 'package-manager', apps: [
    { packageName: 'com.fallback.app', appLabel: '回退应用', uid: 10042, isSystem: true, icon: null },
    { packageName: 'com.fallback.other', appLabel: 'com.fallback.other', uid: null, isSystem: false, icon: null },
  ] });
  assert.deepEqual(bridge.commands, [scriptRoot + 'discovery.sh apps']);
  assertClean(bridge);
});

test('apps reports discovery errors and does not cache failed results', async () => {
  const bridge = makeBridge({ handler: () => jsonResult({ ok: false, error: '应用读取失败' }, 1) });
  assertError(await bridge.request('apps'), /应用读取失败/);
  bridge.handler = () => jsonResult({ ok: true, apps: {} });
  assertError(await bridge.request('apps'), /不是 JSON 数组/);
  bridge.handler = undefined;
  assert.deepEqual(await bridge.request('apps'), { ok: true, apps: [], source: 'package-manager' });
  assert.equal(bridge.commands.length, 3);
  assertClean(bridge);
});

test('apps coalesces concurrent requests, caches results and refresh invalidates the cache', async () => {
  const bridge = makeBridge({ handler: () => null });
  const first = bridge.request('apps');
  const second = bridge.request('apps');
  assert.equal(bridge.commands.length, 1);
  bridge.calls[0].callback(0, '{"ok":true,"apps":[{"packageName":"com.cached.app","appLabel":"缓存应用"}]}', '');
  assert.deepEqual(await first, await second);
  assert.equal((await bridge.request('apps')).apps[0].appLabel, '缓存应用');
  assert.equal(bridge.commands.length, 1);
  const refresh = bridge.request('apps', { refresh: true });
  assert.equal(bridge.commands.length, 2);
  bridge.calls[1].callback(0, '{"ok":true,"apps":[]}', '');
  assert.deepEqual((await refresh).apps, []);
  assert.deepEqual((await bridge.request('apps')).apps, []);
  assertClean(bridge);
});

test('apps refresh prevents an older in-flight result from overwriting the refreshed cache', async () => {
  const bridge = makeBridge({ handler: () => null });
  const old = bridge.request('apps');
  const refreshed = bridge.request('apps', { refresh: true });
  bridge.calls[1].callback(0, '{"ok":true,"apps":[{"packageName":"com.new.app"}]}', '');
  assert.equal((await refreshed).apps[0].packageName, 'com.new.app');
  bridge.calls[0].callback(0, '{"ok":true,"apps":[{"packageName":"com.old.app"}]}', '');
  assert.equal((await old).apps[0].packageName, 'com.old.app');
  assert.equal((await bridge.request('apps')).apps[0].packageName, 'com.new.app');
  assertClean(bridge);
});

test('appIcon returns data URI, coalesces requests and populates cached app metadata', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const icon = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
  const bridge = makeBridge({
    handler: () => jsonResult({ ok: true, apps: [{ packageName: 'com.icon.app', appLabel: '图标应用' }] }),
    fetch: async () => ({ ok: true, status: 200, blob: async () => ({ type: 'image/png', size: bytes.length, arrayBuffer: async () => bytes.buffer }) }),
  });
  assert.equal((await bridge.request('apps')).apps[0].icon, null);
  const responses = await Promise.all([bridge.request('appIcon', { packageName: 'com.icon.app' }), bridge.request('appIcon', { packageName: 'com.icon.app' })]);
  for (const response of responses) assert.deepEqual(response, { ok: true, packageName: 'com.icon.app', icon });
  assert.equal(bridge.fetches.length, 1);
  assert.equal(bridge.fetches[0].url, 'ksu://icon/com.icon.app');
  assert.equal((await bridge.request('apps')).apps[0].icon, icon);
  assert.equal((await bridge.request('appIcon', { packageName: 'com.icon.app' })).icon, icon);
  assert.equal(bridge.fetches.length, 1);
  await bridge.request('apps', { refresh: true });
  assert.equal((await bridge.request('apps')).apps[0].icon, null);
  assert.equal((await bridge.request('appIcon', { packageName: 'com.icon.app' })).icon, icon);
  assert.equal(bridge.fetches.length, 2);
  assertClean(bridge);
});

test('appIcon supports FileReader when Blob.arrayBuffer is unavailable', async () => {
  const icon = 'data:image/png;base64,iVBORw==';
  class FileReaderMock {
    readAsDataURL() {
      this.result = icon;
      this.onload();
    }
  }
  const bridge = makeBridge({
    globals: { FileReader: FileReaderMock },
    fetch: async () => ({ ok: true, status: 200, blob: async () => ({ type: 'image/png', size: 4 }) }),
  });
  assert.deepEqual(await bridge.request('appIcon', { packageName: 'com.icon.app' }), { ok: true, packageName: 'com.icon.app', icon });
  assertClean(bridge);
});

test('appIcon caches unsupported, unsafe, empty or oversized images as null', async () => {
  for (const fetch of [
    async () => { throw new Error('unsupported scheme'); },
    async () => ({ ok: false, status: 404 }),
    async () => ({ ok: true, blob: async () => ({ type: 'image/svg+xml', size: 20 }) }),
    async () => ({ ok: true, blob: async () => ({ type: 'text/html', size: 20 }) }),
    async () => ({ ok: true, blob: async () => ({ type: 'image/png', size: 2097153 }) }),
    async () => ({ ok: true, blob: async () => ({ type: 'image/png', size: 0, arrayBuffer: async () => new ArrayBuffer(0) }) }),
    async () => ({ ok: true, blob: async () => ({ type: 'image/png', size: 1, arrayBuffer: async () => new ArrayBuffer(2097153) }) }),
  ]) {
    const bridge = makeBridge({ fetch });
    for (let count = 0; count < 2; count++) {
      assert.deepEqual(await bridge.request('appIcon', { packageName: 'com.icon.app' }), { ok: true, packageName: 'com.icon.app', icon: null });
    }
    assert.equal(bridge.fetches.length, 1);
    assert.deepEqual(bridge.commands, []);
    assertClean(bridge);
  }
});

test('appIcon timeout returns cached null and aborts the resource request', async () => {
  const bridge = makeBridge({ fetch: () => new Promise(() => {}) });
  const pending = bridge.request('appIcon', { packageName: 'com.icon.app' });
  bridge.advance(15000);
  assert.deepEqual(await pending, { ok: true, packageName: 'com.icon.app', icon: null });
  assert.equal(bridge.fetches[0].init.signal.aborted, true);
  assert.equal((await bridge.request('appIcon', { packageName: 'com.icon.app' })).icon, null);
  assert.equal(bridge.fetches.length, 1);
  assertClean(bridge);
});

test('appIcon falls back from rejected fetch to XHR blob with status zero or 200', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const icon = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
  for (const status of [0, 200]) {
    const { bridge, started } = makeXHRBridge();
    const pending = bridge.request('appIcon', { packageName: 'com.xhr.app' });
    const request = await started;
    assert.deepEqual(request.openArguments, ['GET', 'ksu://icon/com.xhr.app', true]);
    assert.equal(request.responseType, 'blob');
    assert.equal(request.timeout, 15000);
    assert.equal(request.sendCount, 1);
    assert.equal(bridge.timers.size, 1);
    request.status = status;
    request.response = new Blob([bytes], { type: 'image/png' });
    await request.onload();
    assert.deepEqual(await pending, { ok: true, packageName: 'com.xhr.app', icon });
    assert.equal((await bridge.request('appIcon', { packageName: 'com.xhr.app' })).icon, icon);
    assert.deepEqual(bridge.fetches.map((entry) => entry.url), ['ksu://icon/com.xhr.app']);
    assert.equal(request.sendCount, 1);
    assert.equal(request.abortCount, 0);
    assertCleanXHR(bridge, request);
  }
});

test('appIcon XHR HTTP, network, timeout and unsafe blob failures return cached null without leaks', async () => {
  for (const scenario of ['http404', 'http302', 'error', 'timeout', 'abort', 'svg', 'html', 'empty', 'oversized', 'decodeError']) {
    const { bridge, started } = makeXHRBridge();
    const pending = bridge.request('appIcon', { packageName: 'com.xhr.app' });
    const request = await started;
    request.status = scenario === 'http404' ? 404 : scenario === 'http302' ? 302 : 200;
    request.response = new Blob(['image'], { type: 'image/png' });
    if (scenario === 'svg') request.response = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    if (scenario === 'html') request.response = new Blob(['<html/>'], { type: 'text/html' });
    if (scenario === 'empty') request.response = new Blob([], { type: 'image/png' });
    if (scenario === 'oversized') request.response = new Blob([new Uint8Array(2097153)], { type: 'image/png' });
    if (scenario === 'decodeError') request.response = { type: 'image/png', size: 5, arrayBuffer: async () => { throw new Error('blob read failed'); } };
    if (['error', 'timeout', 'abort'].includes(scenario)) request['on' + scenario]();
    else await request.onload();
    assert.deepEqual(await pending, { ok: true, packageName: 'com.xhr.app', icon: null }, scenario);
    assert.equal((await bridge.request('appIcon', { packageName: 'com.xhr.app' })).icon, null);
    assert.equal(bridge.fetches.length, 1);
    assertCleanXHR(bridge, request);
  }
});

test('appIcon XHR independent timeout aborts silent transport or stalled blob decoding and ignores late results', async () => {
  for (const scenario of ['silent', 'stalledBlob']) {
    const { bridge, started } = makeXHRBridge();
    const pending = bridge.request('appIcon', { packageName: 'com.xhr.app' });
    const request = await started;
    const lateError = request.onerror;
    let completeBlob;
    let loading;
    if (scenario === 'stalledBlob') {
      const deferredBlob = new Promise((resolve) => { completeBlob = resolve; });
      request.status = 200;
      request.response = { type: 'image/png', size: 4, arrayBuffer: () => deferredBlob };
      loading = request.onload();
    }
    bridge.advance(14999);
    assert.equal(bridge.timers.size, 1);
    assert.equal(request.abortCount, 0);
    bridge.advance(1);
    assert.deepEqual(await pending, { ok: true, packageName: 'com.xhr.app', icon: null });
    assert.equal(request.abortCount, 1);
    assertCleanXHR(bridge, request);
    lateError();
    if (completeBlob) {
      completeBlob(Uint8Array.from([137, 80, 78, 71]).buffer);
      await loading;
    }
    assert.equal((await bridge.request('appIcon', { packageName: 'com.xhr.app' })).icon, null);
    assert.equal(bridge.fetches.length, 1);
    assertCleanXHR(bridge, request);
  }
});

test('appIcon XHR open or send exceptions clear timers and event handlers', async () => {
  for (const throwAt of ['open', 'send']) {
    const { bridge, started } = makeXHRBridge({ throwAt });
    const pending = bridge.request('appIcon', { packageName: 'com.xhr.app' });
    const request = await started;
    assert.deepEqual(await pending, { ok: true, packageName: 'com.xhr.app', icon: null });
    assert.equal(request.sendCount, throwAt === 'open' ? 0 : 1);
    assertCleanXHR(bridge, request);
    bridge.advance(15000);
    assert.equal(request.abortCount, 0);
    assertCleanXHR(bridge, request);
  }
});

// ---------- Tailscale ----------

function tailscaleGlobals() {
  const realm = { crypto: webcrypto };
  realm.globalThis = realm;
  vm.createContext(realm);
  for (const file of ['vendor/yaml.min.js', 'config.js', 'vendor/qrcode.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../webui/bridge', file), 'utf8'), realm);
  }
  return { mihomoConfig: realm.mihomoConfig, qrcode: realm.qrcode };
}

const tailscaleConfig = [
  'external-controller: 127.0.0.1:9090',
  'secret: "test-secret"',
  'proxies:',
  '  - {name: TS-A, type: tailscale, hostname: a, auth-key: tskey-test}',
  '  - {name: "TS B", type: tailscale, hostname: b, state-dir: ./ts-b}',
  '  - {name: Bad, type: tailscale, hostname: c, state-dir: /etc/ts}',
  'rules:',
  '  - MATCH,DIRECT',
  '',
].join('\n');

function tailscaleBridge(handler) {
  return makeBridge({
    globals: tailscaleGlobals(),
    handler(command) {
      if (command === scriptRoot + 'host.sh read-config') return result(Buffer.from(tailscaleConfig).toString('base64'));
      return handler ? handler(command) : undefined;
    },
  });
}

test('tailscaleRead reads and parses the configuration once without building unrelated forms', async () => {
  const globals = tailscaleGlobals();
  let parses = 0;
  const bridge = makeBridge({
    globals: { mihomoConfig: {
      tailscale(content) { parses++; return globals.mihomoConfig.tailscale(content); },
      schema() { throw new Error('full schema must not be built'); },
    } },
    handler(command) {
      if (command === scriptRoot + 'host.sh read-config') return result(Buffer.from(tailscaleConfig).toString('base64'));
    },
  });
  const response = await bridge.request('tailscaleRead');
  assert.equal(response.ok, true, response.error);
  assert.equal(response.content, tailscaleConfig);
  assert.equal(response.tailscale.length, 3);
  assert.equal(response.list.length, 3);
  assert.ok(response.tailscaleFields.length > 0);
  assert.equal(parses, 1);
  assert.equal(bridge.commands.filter((command) => command === scriptRoot + 'host.sh read-config').length, 1);
  assertClean(bridge);
});

test('tailscaleStatus skips controller and state requests when no Tailscale outbound exists', async () => {
  const bridge = makeBridge({
    globals: tailscaleGlobals(),
    handler(command) {
      assert.equal(command, scriptRoot + 'host.sh read-config');
      return result(Buffer.from('proxies: []\nrules: [MATCH,DIRECT]\n').toString('base64'));
    },
  });
  const response = await bridge.request('tailscaleStatus');
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(response.list, []);
  assert.equal(bridge.commands.length, 1);
  assertClean(bridge);
});

test('tailscaleStatus decodes only the login profile and resolves state-dir inside the data directory', async () => {
  const profiles = { dea8: { ID: 'dea8', Key: 'profile-dea8', NodeID: 'nX1', UserProfile: { LoginName: 'user@example.com' },
    NetworkProfile: { DomainName: 'example.ts.net', MagicDNSName: 'tail0000.ts.net' } } };
  const state = { ok: true, exists: true, current: Buffer.from('profile-dea8').toString('base64'), profiles: Buffer.from(JSON.stringify(profiles)).toString('base64') };
  const bridge = tailscaleBridge((command) => {
    if (command === scriptRoot + "tailscale.sh state '/data/adb/mihomo/tailscale'") return jsonResult(state);
    if (command === scriptRoot + "tailscale.sh state '/data/adb/mihomo/ts-b'") return jsonResult({ ok: true, exists: false });
    return undefined;
  });
  const response = await bridge.request('tailscaleStatus');
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(JSON.parse(JSON.stringify(response.list)), [
    { name: 'TS-A', stateDir: '/data/adb/mihomo/tailscale', authKey: true, kernel: false, loggedIn: true, login: 'user@example.com', tailnet: 'example.ts.net', magicDns: 'tail0000.ts.net' },
    { name: 'TS B', stateDir: '/data/adb/mihomo/ts-b', authKey: false, kernel: false, loggedIn: false, login: null, tailnet: null, magicDns: null },
    { name: 'Bad', stateDir: null, authKey: false, kernel: false, loggedIn: false, login: null, tailnet: null, magicDns: null },
  ]);
  assert.ok(!bridge.commands.some((command) => command.includes('/etc/ts')), 'state-dir outside the data directory is never read');
});

test('tailscaleLogin passes the controller secret by environment and returns the login URL', async () => {
  const bridge = tailscaleBridge((command) => (command.includes('tailscale.sh login') ? jsonResult({ ok: true, url: 'https://login.tailscale.com/a/abc123' }) : undefined));
  const response = await bridge.request('tailscaleLogin', { name: 'TS B', wait: 15 });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.url, 'https://login.tailscale.com/a/abc123');
  const command = bridge.commands.find((item) => item.includes('tailscale.sh login'));
  assert.equal(command, "MIHOMO_SECRET='test-secret' " + scriptRoot + "tailscale.sh login 'http://127.0.0.1:9090' 'TS%20B' 'TS B' '15'");
  assert.equal((await bridge.request('tailscaleLogin', { name: 'Nope' })).ok, false);
  assert.equal((await bridge.request('tailscaleLogin', { name: 'TS-A', wait: 600 })).ok, false);
});

test('tailscaleLogout refuses state directories outside the data directory', async () => {
  const bridge = tailscaleBridge();
  const bad = await bridge.request('tailscaleLogout', { name: 'Bad' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /数据目录/);
  assert.equal((await bridge.request('tailscaleLogout', { name: 'TS-A' })).ok, true);
  assert.ok(bridge.commands.includes(scriptRoot + "tailscale.sh logout '/data/adb/mihomo/tailscale'"));
});

test('tailscale operations use the kernel /tailscale API when the core provides it', async () => {
  const running = { ok: true, running: true, pid: 1, rss_kb: 1, uptime: 5, desired: 'manual', allowed: true, current_ssid: '' };
  const kernel = { tailscale: [
    { name: 'TS-A', state: 'Running', login: 'user@example.com', tailnet: 'example.ts.net', magicDNSSuffix: 'tail0000.ts.net',
      self: { hostName: 'a', dnsName: 'a.tail0000.ts.net.', ips: ['100.64.0.2'], online: true }, serve: [{ port: 80, target: 'unix:run/webui.sock' }] },
    { name: 'TS B', state: 'NeedsLogin', authURL: 'https://login.tailscale.com/a/xyz' },
  ] };
  const calls = [];
  const bridge = tailscaleBridge((command) => {
    if (command === scriptRoot + 'mihomo.sh status') return jsonResult(running);
    if (command.includes('tailscale.sh state')) return jsonResult({ ok: true, exists: false });
    if (command.includes('host.sh api')) {
      calls.push(command);
      if (command.includes("'GET' 'http://127.0.0.1:9090/tailscale'")) return result(JSON.stringify(kernel) + '\n__MIHOMO_HTTP__:200');
      if (command.includes('/tailscale/TS%20B/login?wait=15')) return result(JSON.stringify(kernel.tailscale[1]) + '\n__MIHOMO_HTTP__:200');
      if (command.includes('/tailscale/TS-A/logout')) return result('\n__MIHOMO_HTTP__:204');
    }
    return undefined;
  });
  const status = await bridge.request('tailscaleStatus');
  assert.equal(status.ok, true, status.error);
  assert.equal(status.kernel, true);
  const [a, b] = status.list;
  assert.equal(a.loggedIn, true);
  assert.equal(a.login, 'user@example.com');
  assert.equal(a.dnsName, 'a.tail0000.ts.net');
  assert.deepEqual(JSON.parse(JSON.stringify(a.ips)), ['100.64.0.2']);
  assert.equal(b.loggedIn, false);
  assert.equal(b.authUrl, 'https://login.tailscale.com/a/xyz');
  const login = await bridge.request('tailscaleLogin', { name: 'TS B', wait: 15 });
  assert.equal(login.ok, true, login.error);
  assert.equal(login.url, 'https://login.tailscale.com/a/xyz');
  assert.ok(calls.some((command) => command.includes("MIHOMO_API_TIMEOUT='25'") && command.includes("'POST'")), 'login waits longer than the default timeout');
  assert.ok(!bridge.commands.some((command) => command.includes('tailscale.sh login')), 'no log scraping with a new core');
  const logout = await bridge.request('tailscaleLogout', { name: 'TS-A' });
  assert.equal(logout.ok, true, logout.error);
  assert.ok(!bridge.commands.some((command) => command.includes('tailscale.sh logout')), 'logout keeps the state directory with a new core');
});

test('live Tailscale identity never falls back to an old saved account', async () => {
  for (const state of ['Running', 'NeedsLogin', 'NeedsMachineAuth', 'Stopped', 'NotStarted']) {
    for (const login of [undefined, 'current@example.com']) {
      const profiles = {
        old: { Key: 'profile-old', NodeID: 'old-node', UserProfile: { LoginName: 'teammate@example.com' } },
        current: { Key: 'profile-current', NodeID: 'current-node', UserProfile: { LoginName: 'saved@example.com' } },
      };
      const bridge = tailscaleBridge((command) => {
        if (command === scriptRoot + 'mihomo.sh status') return jsonResult({ ok: true, running: true });
        if (command.includes('host.sh api')) return httpResult({ tailscale: [{ name: 'TS-A', state, login }] });
        if (command.includes('tailscale.sh state')) return jsonResult({ ok: true, exists: true,
          current: Buffer.from('profile-current').toString('base64'), profiles: Buffer.from(JSON.stringify(profiles)).toString('base64') });
      });
      const response = await bridge.request('tailscaleStatus');
      assert.equal(response.ok, true, response.error);
      const entry = response.list[0];
      assert.equal(entry.login, state === 'NotStarted' ? 'saved@example.com' : (state === 'NeedsLogin' ? null : login || null), state);
      assert.equal(entry.kernel, true);
      assert.equal(response.list[1].kernel, false, 'an absent outbound uses saved state, not live identity');
      const reads = bridge.commands.filter((command) => command === scriptRoot + "tailscale.sh state '/data/adb/mihomo/tailscale'");
      assert.equal(reads.length, state === 'NotStarted' ? 1 : 0, 'live status must not read stale profile data');
      assertClean(bridge);
    }
  }
});

test('openUrl only accepts http(s) and qrCode returns a square module matrix', async () => {
  const bridge = tailscaleBridge();
  assert.equal((await bridge.request('openUrl', { url: 'javascript:alert(1)' })).ok, false);
  assert.equal((await bridge.request('openUrl', { url: 'https://login.tailscale.com/a/abc' })).ok, true);
  assert.ok(bridge.commands.includes(scriptRoot + "tailscale.sh open 'https://login.tailscale.com/a/abc'"));
  const qr = await bridge.request('qrCode', { text: 'https://login.tailscale.com/a/abc123' });
  assert.equal(qr.ok, true, qr.error);
  assert.ok(qr.size >= 21);
  assert.equal(qr.rows.length, qr.size);
  assert.ok(qr.rows.every((row) => row.length === qr.size && /^[01]+$/.test(row)));
  assert.equal(qr.rows[0].slice(0, 7), '1111111', 'finder pattern');
  assert.equal((await bridge.request('qrCode', { text: '' })).ok, false);
});

function remoteBridge(handler) {
  const runs = [];
  const bridge = makeBridge({
    remote: {},
    fetch: async (url, init) => {
      if (url === 'api/run') {
        const body = JSON.parse(init.body);
        runs.push({ body, init });
        const response = handler ? handler(body) : undefined;
        if (response && response.status) return { ok: false, status: response.status, json: async () => response.body || {} };
        const value = response || { errno: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
        return { ok: true, status: 200, json: async () => value };
      }
      if (url === 'api/session') return { ok: true, status: 200, json: async () => ({ ok: true, via: 'tailscale', login: 'alice@example.com', passwordless: true }) };
      if (url === 'http://192.168.1.5:9099/clash/version') return { status: 200, text: async () => '{"version":"x"}' };
      throw new Error('unexpected fetch ' + url);
    },
  });
  bridge.runs = runs;
  return bridge;
}

test('remote mode runs module scripts through api/run without composing shell commands', async () => {
  const bridge = remoteBridge((body) => {
    if (body.script === 'mihomo.sh') return { errno: 0, stdout: JSON.stringify({ ok: true, running: true, desired: 'manual', allowed: true }), stderr: '' };
    if (body.script === 'host.sh' && body.args[0] === 'controller') return { errno: 0, stdout: 'external-controller: 127.0.0.1:9090\nsecret: "s;$(id)"\nexternal-ui: ./dashboard', stderr: '' };
    if (body.script === 'host.sh' && body.args[0] === 'api') return { errno: 0, stdout: '{"version":"x"}\n__MIHOMO_HTTP__:200', stderr: '' };
    return undefined;
  });
  assert.equal((await bridge.request('status')).running, true);
  assert.deepEqual(bridge.runs[0].body, { script: 'mihomo.sh', args: ['status'], env: {}, timeout: 30000 });
  assert.equal(bridge.runs[0].init.headers['X-Mihomo-Request'], '1');
  assert.equal(bridge.runs[0].init.credentials, 'same-origin');
  assert.deepEqual(await bridge.request('controller', { path: '/version' }), { ok: true, data: { version: 'x' } });
  assert.equal(bridge.runs.length, 1, 'controller does not run shell commands or read secrets remotely');
  assert.deepEqual(bridge.commands, [], 'no ksu.exec in remote mode');
});

test('remote mode queues script runs instead of overrunning the web service slots', async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const bridge = makeBridge({
    remote: {},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      active++;
      peak = Math.max(peak, active);
      order.push(body.script + ' ' + body.args[0]);
      await new Promise((resolve) => setTimeout(resolve, body.args[0] === 'icon' ? 30 : 10));
      active--;
      const stdout = body.args[0] === 'icon' ? Buffer.from('GIF89a').toString('base64') : JSON.stringify({ ok: true, running: true, desired: 'manual', allowed: true });
      return { ok: true, status: 200, json: async () => ({ errno: 0, stdout, stderr: '' }) };
    },
  });
  const icons = ['https://a.invalid/1.png', 'https://a.invalid/2.png', 'https://a.invalid/3.png'].map((url) => bridge.request('proxyIcon', { url }));
  const reads = Array.from({ length: 6 }, () => bridge.request('status'));
  for (const result of await Promise.all(reads)) assert.equal(result.ok, true, result.error);
  await Promise.all(icons);
  assert.ok(peak <= 3, 'at most 3 concurrent api/run, got ' + peak);
  const firstStatus = order.indexOf('mihomo.sh status');
  assert.ok(order.slice(0, firstStatus).filter((entry) => entry === 'host.sh icon').length <= 1, 'icons never take more than one slot ahead of UI reads');
  assert.ok(order.lastIndexOf('mihomo.sh status') < order.lastIndexOf('host.sh icon'), 'UI reads are served before queued icons');
});

test('lightweight overview endpoints pass through without falling back to full snapshots', async () => {
  for (const path of ['/connections/summary', '/overview', '/ebpf/summary']) {
    const bridge = remoteBridge();
    bridge.context.fetch = async (url, init) => {
      assert.equal(url, 'http://192.168.1.5:9099/clash' + path);
      assert.equal(init.credentials, 'same-origin');
      return { status: 404, text: async () => '{"message":"Not Found"}' };
    };
    assertError(await bridge.request('controller', { path }), /404/);
    assert.deepEqual(bridge.runs, []);
    assert.deepEqual(bridge.commands, []);
    assertClean(bridge);
  }
});

test('remote mode reports expired sessions and opens links in the current browser', async () => {
  const bridge = remoteBridge(() => ({ status: 401, body: { error: '需要登录' } }));
  assertError(await bridge.request('status'), /登录/);
  assert.match(bridge.context.location.href, /^login\?next=/);
  const open = await remoteBridge().request('openUrl', { url: 'https://login.tailscale.com/a/x' });
  assert.equal(open.ok, true);
  const session = await remoteBridge().request('webuiSession');
  assert.deepEqual(session, { ok: true, remote: true, via: 'tailscale', login: 'alice@example.com', passwordless: true });
  assert.deepEqual(await makeBridge().request('webuiSession'), { ok: true, remote: false });
});

test('remote requests time out even if transport or response decoding never settles', { timeout: 2000 }, async () => {
  for (const operation of ['webuiSession', 'webuiLogout', 'status']) {
    for (const stage of ['fetch', 'body']) {
      for (const abortSupported of [true, false]) {
        const bridge = makeBridge({
          remote: {},
          globals: abortSupported ? {} : { AbortController: undefined },
          fetch: () => stage === 'fetch' ? new Promise(() => {}) : Promise.resolve({
            ok: true, status: 200, json: () => new Promise(() => {}),
          }),
        });
        const pending = bridge.request(operation);
        for (let tick = 0; tick < 5; tick++) await Promise.resolve();
        assert.equal(bridge.fetches.length, 1);
        bridge.advance(operation === 'status' ? 35000 : 10000);
        assertError(await pending, /超时/);
        if (abortSupported) assert.equal(bridge.fetches[0].init.signal.aborted, true);
        assert.equal(bridge.context.location.href, 'http://192.168.1.5:9099/');
        assertClean(bridge);
      }
    }
  }
});

test('session expiration redirects to login and failed logout does not report success', async () => {
  for (const operation of ['webuiSession', 'webuiLogout']) {
    const bridge = makeBridge({ remote: {}, fetch: async () => ({
      ok: false, status: 401, json: async () => ({ error: '需要登录' }),
    }) });
    assertError(await bridge.request(operation), /登录/);
    assert.match(bridge.context.location.href, /^login\?next=/);
    assertClean(bridge);
  }
  const bridge = makeBridge({ remote: {}, fetch: async () => ({
    ok: false, status: 503, json: async () => ({ error: '服务不可用' }),
  }) });
  assertError(await bridge.request('webuiLogout'), /服务不可用/);
  assert.equal(bridge.context.location.href, 'http://192.168.1.5:9099/');
  assertClean(bridge);
});

test('timed-out session reads allow retry and ignore late unauthorized responses', async () => {
  let finish;
  let attempts = 0;
  const bridge = makeBridge({ remote: {}, fetch: () => {
    if (++attempts === 1) return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ via: 'lan' }) });
  } });
  const pending = bridge.request('webuiSession');
  bridge.advance(10000);
  assertError(await pending, /超时/);
  assertClean(bridge);
  assert.equal((await bridge.request('webuiSession')).via, 'lan');
  finish({ ok: false, status: 401 });
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  assert.equal(bridge.context.location.href, 'http://192.168.1.5:9099/');
  assertClean(bridge);
});

test('dashboard builds a zashboard setup link for the manager and for remote access', async () => {
  const local = makeBridge({ handler: (command) => command === scriptRoot + 'host.sh controller' ? result('external-controller: 0.0.0.0:9090\nsecret: "k e"\nexternal-ui: ./dashboard') : undefined });
  const direct = await local.request('dashboard');
  assert.equal(direct.available, true);
  assert.equal(direct.url, 'http://127.0.0.1:9090/ui/#/setup?disableUpgradeCore=1&secret=k+e&hostname=127.0.0.1&port=9090');
  const remote = remoteBridge((body) => body.args[0] === 'controller' ? { errno: 0, stdout: 'external-controller: 127.0.0.1:9090\nexternal-ui: ui', stderr: '' } : undefined);
  const proxied = await remote.request('dashboard');
  assert.equal(proxied.url, 'http://192.168.1.5:9099/clash/ui/#/setup?disableUpgradeCore=1&hostname=192.168.1.5&port=9099&secondaryPath=%2Fclash&http=1');
  const none = makeBridge({ handler: (command) => command === scriptRoot + 'host.sh controller' ? result('external-controller: 127.0.0.1:9090') : undefined });
  assert.equal((await none.request('dashboard')).available, false);
});

test('diagnostics redacts links, secrets, UUIDs and public addresses', async () => {
  const raw = [
    'proxy-providers: url=https://sub.example.com/api?token=abcdef',
    'secret: "hunter2"', 'auth-key: tskey-auth-kAbCdEf123-XYZ', 'uuid 1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    'dial 203.0.113.9:443 via 192.168.1.2 and 100.64.0.7', 'v6 2408:8207:1234:5678::1',
    'blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w',
  ].join('\n');
  const bridge = makeBridge({ handler: (command) => command === scriptRoot + 'host.sh diag' ? result(raw) : undefined });
  const { content } = await bridge.request('diagnostics');
  assert.match(content, /^# mihomo-ebpf 诊断信息/);
  assert.match(content, /服务: 未运行/);
  for (const leaked of ['sub.example.com', 'hunter2', 'kAbCdEf123', '1b4e28ba', '203.0.113.9', '5678::1', 'QUJDREVG']) {
    assert.ok(!content.includes(leaked), leaked + ' leaked:\n' + content);
  }
  for (const kept of ['https://***', 'secret: ***', '203.0.x.x', '192.168.1.2', '100.64.0.7', '2408:8207:…']) {
    assert.ok(content.includes(kept), kept + ' missing:\n' + content);
  }
});

test('dashboardUpgrade asks the core to download the panel again', async () => {
  const bridge = makeBridge({
    status: { running: true, desired: 'manual' },
    handler: (command) => {
      if (command === scriptRoot + 'host.sh controller') return result('external-controller: 127.0.0.1:9090\nexternal-ui: ./ui');
      if (isCurl(command)) return result('{"status":"ok"}\n__MIHOMO_HTTP__:200');
      return undefined;
    },
  });
  assert.deepEqual(await bridge.request('dashboardUpgrade'), { ok: true });
  assert.ok(bridge.commands.some((command) => isCurl(command) && command.includes("'POST'") && command.includes('/upgrade/ui')), bridge.commands.join('\n'));
  const stopped = makeBridge({ handler: (command) => command === scriptRoot + 'host.sh controller' ? result('external-controller: 127.0.0.1:9090\nexternal-ui: ./ui') : undefined });
  assert.match((await stopped.request('dashboardUpgrade')).error, /没有运行/);
});

test('geoUpdate and providersUpdate refresh GEO data and only HTTP providers', async () => {
  const bridge = makeBridge({
    status: { running: true, desired: 'manual' },
    handler: (command) => {
      if (command === scriptRoot + 'host.sh controller') return result('external-controller: 127.0.0.1:9090');
      if (isCurl(command) && command.includes("'GET'") && command.includes('/providers/rules')) {
        return result(JSON.stringify({ providers: { cn: { vehicleType: 'HTTP' }, local: { vehicleType: 'File' }, bad: { vehicleType: 'HTTP' } } }) + '\n__MIHOMO_HTTP__:200');
      }
      if (isCurl(command) && command.includes('/providers/rules/bad')) return result('fail\n__MIHOMO_HTTP__:500');
      if (isCurl(command)) return result('\n__MIHOMO_HTTP__:204');
      return undefined;
    },
  });
  assert.deepEqual(await bridge.request('geoUpdate'), { ok: true });
  assert.ok(bridge.commands.some((command) => isCurl(command) && command.includes("'POST'") && command.includes('/configs/geo')), bridge.commands.join('\n'));
  assert.deepEqual(await bridge.request('providersUpdate', { kind: 'rules' }), { ok: true, total: 2, failed: ['bad'] });
  assert.ok(!bridge.commands.some((command) => command.includes('/providers/rules/local')), 'file provider must not be updated');
  assertError(await bridge.request('providersUpdate', { kind: 'x;id' }));
  const stopped = makeBridge({ handler: () => undefined });
  assert.match((await stopped.request('geoUpdate')).error, /没有运行/);
});

test('webui settings and password are validated and passed as Base64', async () => {
  const bridge = makeBridge();
  assert.equal((await bridge.request('webuiSet', { settings: { enabled: true, lan: true, allow_cidrs: ['192.168.1.0/24'] } })).ok, true);
  const command = bridge.commands.at(-1);
  assert.ok(command.startsWith(scriptRoot + 'webui.sh set '));
  const encoded = shellWords(command).at(-1);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), { enabled: true, lan: true, allow_cidrs: ['192.168.1.0/24'] });
  for (const settings of [{ password: 'x' }, { enabled: 'yes' }, { port: '80' }, { allow_cidrs: ['a b'] }, { tailscale_users: 'a' }]) {
    assertError(await bridge.request('webuiSet', { settings }));
  }
  assert.equal((await bridge.request('webuiPasswd', { password: "p'ss word" })).ok, true);
  assert.equal(Buffer.from(shellWords(bridge.commands.at(-1)).at(-1), 'base64').toString(), "p'ss word");
  assertError(await bridge.request('webuiPasswd', { password: 'short' }), /6/);
  assert.equal((await bridge.request('webuiPasswd', { password: '' })).ok, true);
});

test('proxyIcon downloads in the browser first, falls back to the module script and caches', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const storage = new Map();
  const localStorage = { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, value) };
  const browser = makeBridge({
    globals: { localStorage },
    fetch: async (url) => {
      if (url === 'https://cdn.example/ok.png') return { ok: true, status: 200, arrayBuffer: async () => png };
      throw new Error('CORS');
    },
    handler: (command) => command.startsWith(scriptRoot + 'host.sh icon ') ? result(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')) : undefined,
  });
  const direct = await browser.request('proxyIcon', { url: 'https://cdn.example/ok.png' });
  assert.equal(direct.icon, 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(storage.get('mihomo.icon:https://cdn.example/ok.png'), direct.icon);
  assert.equal(browser.commands.filter((command) => command.includes('host.sh icon')).length, 0);
  const fallback = await browser.request('proxyIcon', { url: 'https://other.example/a.svg' });
  assert.match(fallback.icon, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual(shellWords(browser.commands.at(-1)).slice(-2), ['icon', 'https://other.example/a.svg']);
  const inline = 'data:image/png;base64,AAAA';
  assert.equal((await browser.request('proxyIcon', { url: inline })).icon, inline);
  for (const url of ['file:///etc/passwd', 'https://a b', 'javascript:alert(1)']) assertError(await browser.request('proxyIcon', { url }));
  const broken = makeBridge({ handler: (command) => command.includes('host.sh icon') ? result('', 1, 'curl: (22) 404') : undefined });
  assertError(await broken.request('proxyIcon', { url: 'https://x.example/i.png' }), /404/);
});

test('enhanced settings reject remote callers and encode local settings without shell interpolation', async () => {
  const remote = makeBridge({ remote: {} });
  assertError(await remote.request('enhancedSet', { settings: { enabled: true } }), /本机/);
  assert.equal(remote.fetches.length, 0);
  const local = makeBridge();
  const settings = { enabled: true, password: "operation's password", scrcpy_port: 8080, scrcpy_mode: 'builtin' };
  assert.equal((await local.request('enhancedSet', { settings })).ok, true);
  const words = shellWords(local.commands.at(-1));
  assert.equal(words.at(-2), 'enhanced-set');
  assert.deepEqual(JSON.parse(Buffer.from(words.at(-1), 'base64').toString()), settings);
  for (const invalid of [{ enabled: 'true' }, { password: 'short' }, { scrcpy_port: 65536 }, { scrcpy_mode: 'unknown' }, { require_password: false }]) {
    assertError(await local.request('enhancedSet', { settings: invalid }));
  }
  assertClean(local);
});

test('local enhanced token stays in memory and clears on lock and settings changes', async () => {
  const local = makeBridge({ handler(command) {
    if (command.startsWith(scriptRoot + 'webui.sh enhanced-request ')) {
      const words = shellWords(command);
      return jsonResult(words.at(-2) === 'unlock' ? { ok: true, token: 'manager-token' } : { ok: true });
    }
  } });
  assert.equal((await local.request('enhanced', { action: 'unlock', payload: { password: 'operation-password' } })).ok, true);
  const tokenForLastCall = () => JSON.parse(Buffer.from(shellWords(local.commands.at(-1)).at(-1), 'base64').toString()).token;
  await local.request('enhanced', { action: 'battery' });
  assert.equal(tokenForLastCall(), 'manager-token');
  await local.request('enhanced', { action: 'lock' });
  await local.request('enhanced', { action: 'status' });
  assert.equal(tokenForLastCall(), '');
  await local.request('enhanced', { action: 'unlock', payload: { password: 'operation-password' } });
  await local.request('enhancedSet', { settings: { enabled: false } });
  await local.request('enhanced', { action: 'status' });
  assert.equal(tokenForLastCall(), '');
  assertClean(local);
});

test('remote enhanced actions use same-origin credentials and reject unknown operations', async () => {
  const remote = makeBridge({ remote: {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) });
  assert.equal((await remote.request('enhanced', { action: 'sms', payload: { limit: 20 } })).ok, true);
  const { url, init } = remote.fetches.at(-1);
  assert.equal(url, 'api/enhanced/sms');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Mihomo-Request'], '1');
  assert.deepEqual(JSON.parse(init.body), { limit: 20 });
  const requests = remote.fetches.length;
  assertError(await remote.request('enhanced', { action: '../run' }));
  assertError(await remote.request('enhanced', { action: 'battery', payload: { command: 'id' } }));
  assert.equal(remote.fetches.length, requests);
  assertClean(remote);
});

test('screen settings and stop use the authenticated enhanced action channel', async () => {
  const remote = makeBridge({ remote: {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) });
  const settings = { enabled: true, mode: 'builtin', max_size: 960, fps: 15, bit_rate: 1000000 };
  assert.equal((await remote.request('enhanced', { action: 'scrcpy-set', payload: settings })).ok, true);
  assert.equal(remote.fetches.at(-1).url, 'api/enhanced/scrcpy-set');
  assert.deepEqual(JSON.parse(remote.fetches.at(-1).init.body), settings);
  assert.equal((await remote.request('enhanced', { action: 'scrcpy-stop' })).ok, true);
  assert.equal(remote.fetches.at(-1).url, 'api/enhanced/scrcpy-stop');
  const requests = remote.fetches.length;
  assertError(await remote.request('enhanced', { action: 'scrcpy-stop', payload: { command: 'id' } }));
  assertError(await remote.request('enhanced', { action: 'scrcpy-set', payload: { executable: '/bin/sh' } }));
  assert.equal(remote.fetches.length, requests);
  assertClean(remote);
});
