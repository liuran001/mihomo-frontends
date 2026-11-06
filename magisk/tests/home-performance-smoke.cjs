'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { installRoutes } = require('./live-smoke.cjs');

async function readCounts(page) {
  return page.evaluate(() => ({ ...window.__liveMock.reads }));
}

async function visibility(page, value) {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

async function scenario(browser, legacy) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const external = [];
  const missing = [];
  const errors = [];
  let page;
  try {
    await installRoutes(context, external, missing, { running: true, legacy, connectionCount: 10000 });
    await context.addInitScript(() => { localStorage.setItem('mihomo.home.exitip', '0'); });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'detached', timeout: 60000 });
    await page.waitForFunction(() => window.__liveMock?.reads['/ebpf/summary'] >= 1);
    await page.waitForTimeout(4500);
    const visible = await readCounts(page);
    const initialExternal = [...external];
    assert.equal(external.some(value => value.includes('https://fonts.gstatic.com/')), false, 'bundled UI must not fetch fallback fonts');
    assert.ok(visible['/connections/summary'] >= (legacy ? 1 : 3));
    assert.equal(visible['/overview'], 1, 'overview must not be polled at the traffic interval');
    assert.equal(visible['/ebpf/summary'], 1);
    for (const endpoint of ['/connections', '/proxies', '/providers/proxies', '/rules', '/ebpf', '/memory']) {
      assert.equal(visible[endpoint] || 0, 0, `${endpoint} must not be requested by the home overview`);
    }

    await visibility(page, 'hidden');
    await page.waitForTimeout(250);
    const hidden = await readCounts(page);
    await page.waitForTimeout(4500);
    assert.deepEqual(await readCounts(page), hidden, 'hidden home must stop polling');
    await visibility(page, 'visible');
    if (legacy) {
      await page.waitForTimeout(2500);
      assert.deepEqual(await readCounts(page), hidden, 'unsupported summaries must not be retried or replaced with full snapshots');
    } else {
      await page.waitForFunction(count => window.__liveMock.reads['/connections/summary'] > count, hidden['/connections/summary']);
    }

    const details = page.getByRole('button', { name: '详细诊断', exact: true });
    for (let attempt = 0; attempt < 12 && !await details.isVisible(); attempt++) {
      await page.mouse.move(900, 720);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(150);
    }
    await details.click({ force: true });
    await page.waitForFunction(() => window.__liveMock.reads['/ebpf'] === 1);
    assert.deepEqual(await page.evaluate(() => window.__liveMock.writes), []);
    assert.deepEqual(await page.evaluate(() => window.__liveMock.unexpected), []);
    assert.deepEqual(missing, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, initialExternal, 'connectivity probes run only once, never on a poll');
    for (const host of ['www.baidu.com', 'www.gstatic.com', 'github.githubassets.com', 'www.youtube.com']) {
      assert.equal(external.filter(value => value.includes(`https://${host}/`)).length, 1, `${host} must only be probed once`);
    }
    return { legacy, visible, hidden: 'no polling', resumed: legacy ? 'no fallback' : 'summary only', detailed: 'manual only' };
  } catch (error) {
    if (page) console.error(JSON.stringify({ legacy, external, calls: await readCounts(page).catch(() => null), accessibility: await page.locator('body').ariaSnapshot().catch(() => '') }));
    throw error;
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-background-networking'] });
  try {
    const results = [];
    for (const legacy of [false, true]) results.push(await scenario(browser, legacy));
    console.log(JSON.stringify({ result: 'PASS', backend: 'mocked', results }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
