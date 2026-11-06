'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const origin = process.env.SCREEN_QA_URL || 'http://127.0.0.1:18780';
const headers = { 'Content-Type': 'application/json', 'X-Mihomo-Request': '1' };
const adbPath = process.env.SCREEN_QA_ADB;
const emulator = process.env.SCREEN_QA_SERIAL;

function android(command) {
  return execFileSync(adbPath, ['-s', emulator, 'shell', command], { encoding: 'utf8', timeout: 15000 });
}

async function authenticate(context) {
  const logged = await context.request.post(origin + '/api/login', { headers, data: { password: process.env.SCREEN_QA_PASSWORD || 'qa-main-password' } });
  assert.equal(logged.status(), 200, await logged.text());
  const status = await (await context.request.get(origin + '/api/enhanced/status')).json();
  if (status.has_password) {
    const unlocked = await context.request.post(origin + '/api/enhanced/unlock', { headers, data: { password: process.env.SCREEN_QA_OPERATION_PASSWORD || 'qa-operation-password' } });
    assert.equal(unlocked.status(), 200, await unlocked.text());
  }
}

async function connect(page, mode = 'webcodecs') {
  await page.getByRole('button', { name: '开始连接', exact: true }).click();
  await page.waitForFunction(mode => {
    if (document.getElementById('status').dataset.error === 'true') throw new Error(document.getElementById('status').textContent);
    if (mode === 'mse') return document.querySelector('video').videoWidth > 0 && document.querySelector('video').currentTime > 0;
    return document.querySelector('canvas').width > 0 && document.getElementById('empty').hidden;
  }, mode, { timeout: 30000 });
}

async function stopped(context) {
  await assertEventually(async () => !(await (await context.request.get(origin + '/api/enhanced/status')).json()).screen_service?.running);
  if (adbPath) assert.doesNotMatch(android('ps -A -o ARGS'), /com\.genymobile\.scrcpy\.Server/);
}

async function run(browser, mode) {
  const context = await browser.newContext({ viewport: { width: mode === 'mse' ? 393 : 1440, height: 1000 } });
  await authenticate(context);
  const page = await context.newPage();
  if (mode === 'mse') await page.addInitScript(() => { window.VideoDecoder = undefined; window.EncodedVideoChunk = undefined; });
  const errors = [];
  const streamMessages = [];
  const sent = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framereceived', frame => { if (typeof frame.payload === 'string') streamMessages.push(frame.payload); });
    socket.on('framesent', frame => { if (typeof frame.payload === 'string') sent.push(JSON.parse(frame.payload)); });
  });
  try {
    const before = await (await context.request.get(origin + '/api/enhanced/status')).json();
    assert.equal(before.screen_service.running, false);
    if (adbPath) android('input keyevent 224; wm dismiss-keyguard; am start -W -a android.settings.SETTINGS');
    await page.goto(origin + '/enhanced/scrcpy/');
    await connect(page, mode);
    const running = await (await context.request.get(origin + '/api/enhanced/status')).json();
    assert.equal(running.screen_service.running, true);
    assert.equal(running.screen_service.ready, true);
    if (adbPath) assert.match(android('ps -A -o ARGS'), /app_process \/system\/bin com\.genymobile\.scrcpy\.Server/);
    await page.getByRole('button', { name: '主页', exact: true }).click();
    if (adbPath) await assertEventually(async () => /(?:topResumedActivity=|ResumedActivity:).*launcher/.test(android('dumpsys activity activities')));
    const surface = page.locator(mode === 'mse' ? '#video' : '#canvas');
    const bounds = await surface.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.65);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.35, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.ok(sent.some(message => message.type === 'key' && message.key === 3));
    assert.ok(sent.some(message => message.type === 'touch' && message.action === 0));
    assert.ok(sent.some(message => message.type === 'touch' && message.action === 1));
    await page.screenshot({ path: `dist/scrcpy-device-${mode}.png` });
    await page.getByRole('button', { name: '停止连接', exact: true }).click();
    await stopped(context);
    assert.deepEqual(errors, []);
    return { mode, rendered: true, inputSent: true, homeConfirmedOnAndroid: !!adbPath, stopped: true, status: streamMessages };
  } catch (error) {
    console.error(JSON.stringify({ mode, streamMessages, errors, status: await page.locator('#status').textContent().catch(() => ''), service: await (await context.request.get(origin + '/api/enhanced/status')).json() }));
    await page.screenshot({ path: `dist/scrcpy-device-failed-${mode}.png` }).catch(() => {});
    throw error;
  } finally {
    await context.request.post(origin + '/api/enhanced/scrcpy-stop', { headers, data: {} }).catch(() => {});
    await context.close();
  }
}

async function lifecycle(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await authenticate(context);
  let page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const status = () => context.request.get(origin + '/api/enhanced/status').then(response => response.json());
  try {
    await page.goto(origin + '/enhanced/scrcpy/');
    await page.waitForTimeout(1500);
    assert.equal((await status()).screen_service.running, false);
    await connect(page);
    const duplicate = await page.evaluate(() => new Promise(resolve => {
      const socket = new WebSocket(new URL('stream', location.href));
      socket.onopen = () => { socket.close(); resolve('opened'); };
      socket.onerror = () => resolve('rejected');
    }));
    assert.equal(duplicate, 'rejected');
    assert.equal((await status()).screen_service.running, true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await stopped(context);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    assert.equal((await status()).screen_service.running, false);
    await connect(page);
    await page.close();
    await stopped(context);
    page = await context.newPage();
    await page.goto(origin + '/enhanced/scrcpy/');
    await connect(page);
    const configured = await context.request.post(origin + '/api/enhanced/scrcpy-set', { headers, data: { fps: 15, max_size: 960, bit_rate: 1000000 } });
    assert.equal(configured.status(), 200, await configured.text());
    await stopped(context);
    await page.waitForFunction(() => !document.getElementById('start').disabled);
    await connect(page);
    const resized = await page.locator('#canvas').evaluate(canvas => Math.max(canvas.width, canvas.height));
    assert.ok(resized <= 960, 'quality settings were not applied');
    const independent = (await status()).has_password;
    assert.equal(independent, true, 'lifecycle test requires an independent operation password');
    const locked = await context.request.post(origin + '/api/enhanced/lock', { headers, data: {} });
    assert.equal(locked.status(), 200, await locked.text());
    await assertEventually(async () => await page.locator('#start').isEnabled(), 8000);
    if (adbPath) assert.doesNotMatch(android('ps -A -o ARGS'), /com\.genymobile\.scrcpy\.Server/);
    assert.equal((await context.request.get(origin + '/enhanced/scrcpy/screen.js')).status(), 403);
    const unlocked = await context.request.post(origin + '/api/enhanced/unlock', { headers, data: { password: process.env.SCREEN_QA_OPERATION_PASSWORD || 'qa-operation-password' } });
    assert.equal(unlocked.status(), 200, await unlocked.text());
    await stopped(context);
    await connect(page);
    const loggedOut = await context.request.post(origin + '/api/logout', { headers, data: {} });
    assert.equal(loggedOut.status(), 200, await loggedOut.text());
    await assertEventually(async () => await page.locator('#start').isEnabled(), 8000);
    if (adbPath) assert.doesNotMatch(android('ps -A -o ARGS'), /com\.genymobile\.scrcpy\.Server/);
    await authenticate(context);
    await stopped(context);
    assert.deepEqual(errors, []);
    return { noAutomaticStart: true, singleSession: true, hiddenStop: true, closeStop: true, settingsStop: true, appliedMaxSize: resized, independentLockStop: true, logoutStop: true };
  } finally {
    await authenticate(context).catch(() => {});
    await context.request.post(origin + '/api/enhanced/scrcpy-set', { headers, data: { fps: 24, max_size: 1280, bit_rate: 2000000 } }).catch(() => {});
    await context.close();
  }
}

async function assertEventually(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('expected Android or screen state did not arrive before its deadline');
}

(async () => {
  if (adbPath) {
    assert.match(emulator || '', /^emulator-[0-9]+$/);
    assert.equal(android('getprop ro.kernel.qemu').trim(), '1', 'device automation is restricted to a disposable emulator');
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    const results = [];
    for (const mode of ['webcodecs', 'mse']) results.push(await run(browser, mode));
    const resourceLifecycle = await lifecycle(browser);
    console.log(JSON.stringify({ result: 'PASS', backend: 'Android emulator, actual scrcpy encoder', results, resourceLifecycle }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
