'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/backend.js', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() + `
        (() => {
          const original = window.mihomoBridge.request;
          window.__loadingCalls = [];
          window.mihomoBridge = { request(operation, payload) {
            window.__loadingCalls.push(operation);
            if (['tailscaleRead', 'webuiSession'].includes(operation)) return new Promise(() => {});
            return original(operation, payload);
          } };
        })();
      ` });
    });
    await page.goto(process.env.WEBUI_URL || 'http://127.0.0.1:8790/', { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'detached', timeout: 60000 });
    await page.getByRole('button', { name: '设置', exact: true }).click({ force: true });
    await page.waitForTimeout(600);
    const management = page.getByRole('button', { name: /^网页管理/ });
    for (let attempt = 0; attempt < 10 && !await management.count(); attempt++) {
      await page.mouse.move(215, 700);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(300);
    }
    await management.click({ force: true });
    const refresh = page.getByRole('button', { name: '重新读取', exact: true });
    await page.waitForFunction(() => window.__loadingCalls.includes('webuiStatus'));
    await refresh.waitFor();
    for (let attempt = 0; attempt < 30 && !await refresh.isEnabled(); attempt++) await page.waitForTimeout(100);
    await page.waitForTimeout(600);
    assert.equal(await refresh.isEnabled(), true, 'refresh must not wait for Tailscale or session loading');
    const previous = await page.evaluate(() => window.__loadingCalls.filter((operation) => operation === 'webuiStatus').length);
    await refresh.click({ force: true });
    await page.waitForFunction((count) => window.__loadingCalls.filter((operation) => operation === 'webuiStatus').length > count, previous);
    await page.waitForTimeout(600);
    const port = page.getByRole('button', { name: /^端口/ });
    await port.click({ force: true });
    await page.getByRole('textbox').waitFor();
    const calls = await page.evaluate(() => window.__loadingCalls);
    assert.equal(calls.filter((operation) => operation === 'tailscaleRead').length, 1, 'refresh must not duplicate a pending Tailscale request');
    assert.equal(calls.filter((operation) => operation === 'webuiSession').length, 1, 'refresh must not duplicate a pending session request');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', backend: 'mocked', blocked: ['tailscaleRead', 'webuiSession'], refresh: 'enabled', portDialog: 'opened' }));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
