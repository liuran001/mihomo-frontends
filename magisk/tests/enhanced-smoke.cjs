'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function seek(page, locator, amount = 500) {
  for (let attempt = 0; attempt < 18; attempt++) {
    const bounds = await locator.boundingBox({ timeout: 500 }).catch(() => null);
    if (bounds && bounds.y > 70 && bounds.y + bounds.height < page.viewportSize().height - 30) return;
    await page.mouse.move(page.viewportSize().width * 0.7, page.viewportSize().height * 0.7);
    await page.mouse.wheel(0, amount);
    await page.waitForTimeout(200);
  }
  throw new Error(`control not reached: ${locator}`);
}

async function click(page, locator) {
  await locator.waitFor();
  await locator.click({ force: true });
  await page.waitForTimeout(300);
}

const button = (page, name) => page.getByRole('button', { name, exact: true });

async function enhancedScenario(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto((process.env.WEBUI_URL || 'http://127.0.0.1:8790/') + '?enhanced=1&remote=1&public=1#enhanced');
    await page.locator('#loading').waitFor({ state: 'detached', timeout: 60000 });
    await page.getByRole('textbox').click({ force: true });
    await page.keyboard.type('operation-password', { delay: 20 });
    await click(page, button(page, '解锁'));
    await button(page, '读取电量').waitFor();
    const lockBounds = await button(page, '立即锁定').boundingBox();
    const calls = await page.evaluate(() => window.__previewCalls);
    assert.equal(calls.filter(call => call.operation === 'enhanced' && !['status', 'unlock'].includes(call.payload.action)).length, 0);
    await click(page, button(page, '读取电量'));
    assert.match(await page.locator('body').ariaSnapshot(), /73%/);
    await seek(page, button(page, '读取最近短信'));
    await click(page, button(page, '读取最近短信'));
    await seek(page, page.getByText('QA-SMS-NOT-A-REAL-MESSAGE'));
    assert.match(await page.locator('body').ariaSnapshot(), /QA-SMS-NOT-A-REAL-MESSAGE/);
    await seek(page, button(page, '清除显示'), -450);
    await click(page, button(page, '清除显示'));
    assert.doesNotMatch(await page.locator('body').ariaSnapshot(), /QA-SMS-NOT-A-REAL-MESSAGE/);
    await seek(page, button(page, '执行命令'));
    await page.getByRole('textbox').first().click({ force: true });
    await page.keyboard.type('printf QA', { delay: 20 });
    await click(page, button(page, '执行命令'));
    await click(page, button(page, '执行'));
    await page.waitForFunction(() => window.__previewCalls.some(call => call.payload.action === 'terminal'));
    const terminalCall = await page.evaluate(() => window.__previewCalls.find(call => call.payload.action === 'terminal'));
    assert.deepEqual(terminalCall.payload.payload, { command: 'printf QA', timeout: 15 });
    await page.mouse.move(width * 0.7, 650);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `dist/enhanced-terminal-${width}.png` });
    await page.mouse.wheel(0, -1000000);
    await page.waitForTimeout(500);
    await page.mouse.click(lockBounds.x + lockBounds.width / 2, lockBounds.y + lockBounds.height / 2);
    await page.waitForFunction(() => window.__previewCalls.some(call => call.payload.action === 'lock'));
    await page.waitForTimeout(500);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `dist/enhanced-locked-${width}.png` });
    return { width, onDemand: true, passwordGate: true, terminal: 'mocked', locked: true, displayVerification: 'screenshots; popup accessibility tree remains stale in Compose 1.12.0' };
  } catch (failure) {
    console.error(JSON.stringify({ width, accessibility: await page.locator('body').ariaSnapshot(), calls: await page.evaluate(() => window.__previewCalls) }));
    throw failure;
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const results = [];
    for (const width of [1440, 393]) results.push(await enhancedScenario(browser, width));
    console.log(JSON.stringify({ result: 'PASS', backend: 'mocked', results }));
  } finally { await browser.close(); }
})().catch(failure => { console.error(failure); process.exitCode = 1; });
