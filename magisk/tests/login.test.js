'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../webd/login.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function fixture(target, fetch) {
  const elements = { form: { addEventListener: (_, handler) => { elements.onSubmit = handler; } }, submit: {}, error: {}, password: { value: 'example-password' } };
  let timeout;
  const context = vm.createContext({ URL, URLSearchParams, AbortController,
    document: { getElementById: name => elements[name] },
    location: { origin: 'http://localhost:9099', search: '?next=' + encodeURIComponent(target), replace: value => { elements.redirect = value; } },
    fetch, setTimeout: handler => { timeout = handler; return 1; }, clearTimeout: () => {},
  });
  vm.runInContext(source, context);
  return { context, elements, expire: () => timeout() };
}

test('login redirects only to a same-origin relative path', () => {
  for (const target of ['//evil.invalid/', '/\\evil.invalid/', '/\t/evil.invalid', 'https://evil.invalid']) {
    assert.equal(vm.runInContext('next()', fixture(target).context), '/');
  }
  assert.equal(vm.runInContext('next()', fixture('/#enhanced').context), '/#enhanced');
  assert.equal(vm.runInContext('next()', fixture('/clash/ui/?one=two#setup').context), '/clash/ui/?one=two#setup');
});

test('login deadline covers stalled headers and body even if transport ignores abort', async () => {
  for (const bodyStalls of [false, true]) {
    const state = fixture('/', () => bodyStalls ? Promise.resolve({ ok: true, json: () => new Promise(() => {}) }) : new Promise(() => {}));
    const pending = state.elements.onSubmit({ preventDefault() {} });
    await Promise.resolve();
    state.expire();
    await pending;
    assert.equal(state.elements.submit.disabled, false);
    assert.match(state.elements.error.textContent, /超时/);
    assert.equal(state.elements.redirect, undefined);
  }
});
