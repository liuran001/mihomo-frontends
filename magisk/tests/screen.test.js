'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../webd/screen/screen.js'), 'utf8');

function fixture(options = {}) {
  const timers = new Map();
  const requests = [];
  const sockets = [];
  const decoders = [];
  const muxers = [];
  const events = {};
  const elements = {};
  let nextTimer = 0;
  let now = 100;
  const session = { enabled: true, unlocked: true, scrcpy: true, scrcpy_mode: 'builtin', scrcpy_fps: 24, screen_service: { installed: true }, ...options.session };
  for (const name of ['status', 'video', 'canvas', 'rotate', 'send-text', 'paste', 'start', 'stop', 'empty', 'public-warning', 'fullscreen', 'display', 'home']) {
    elements[name] = {
      value: '', dataset: {}, handlers: {}, hidden: false, width: 0, height: 0, disabled: name === 'home', paused: true, readyState: 2,
      addEventListener(event, handler) { this.handlers[event] = handler; },
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
      removeAttribute() {}, replaceChildren() {}, load() {}, focus() {}, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return true; },
      getBoundingClientRect: () => ({ width: 320, height: 480, left: 0, top: 0 }),
      getContext() { return { drawImage: () => { this.draws = (this.draws || 0) + 1; } }; },
    };
  }
  elements.home.dataset.key = '3';
  const document = {
    hidden: false, getElementById: name => elements[name], querySelectorAll: () => [elements.home],
    addEventListener: (event, handler) => { events[event] = handler; },
  };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = String(url); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    message(data) { this.onmessage?.({ data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }); }
  }
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.frames = []; decoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(frame) { this.frames.push(frame); }
    close() { this.state = 'closed'; }
  }
  class Muxer {
    constructor(config) { this.config = config; this.frames = []; this.bufferControllers = { video: { queue: new Uint8Array() } }; muxers.push(this); }
    feed(frame) { this.frames.push(frame); }
    destroy() { this.destroyed = true; }
  }
  const context = vm.createContext({
    document, window: { addEventListener: (event, handler) => { events[event] = handler; } },
    location: { href: 'https://device.invalid/enhanced/scrcpy/', protocol: 'https:' },
    WebSocket: Socket, VideoDecoder: options.mse ? undefined : Decoder, EncodedVideoChunk: class { constructor(data) { Object.assign(this, data); } },
    JMuxer: Muxer, MediaSource: {}, isSecureContext: true,
    URL, ArrayBuffer, Uint8Array, DataView, AbortController, TextEncoder,
    performance: { now: () => now },
    setTimeout: (handler, duration) => { timers.set(++nextTimer, { handler, duration }); return nextTimer; },
    clearTimeout: timer => timers.delete(timer),
    fetch: async (url, init) => { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : { ok: true, json: async () => session }; },
  });
  vm.runInContext(source, context);
  return { elements, events, document, requests, sockets, decoders, muxers, timers, session,
    start: () => elements.start.handlers.click(), stop: () => elements.stop.handlers.click(),
    advance: elapsed => { now += elapsed; },
    configure() {
      const socket = sockets.at(-1);
      socket.message({ type: 'size', width: 640, height: 960 });
      socket.message(packet(0x40000000, 0, [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0]));
      socket.message(packet(0x20000000, 1000));
      return socket;
    },
  };
}

function packet(flags, timestamp, data = [0, 0, 0, 1, 0x65, 0]) {
  const buffer = new ArrayBuffer(12 + data.length);
  const header = new DataView(buffer);
  header.setUint32(0, flags);
  header.setUint32(4, timestamp);
  header.setUint32(8, data.length);
  new Uint8Array(buffer, 12).set(data);
  return buffer;
}

test('screen never starts requests, timers or capture until explicitly requested', async () => {
  const state = fixture();
  assert.equal(state.requests.length, 0);
  assert.equal(state.sockets.length, 0);
  assert.equal(state.timers.size, 0);
  state.document.hidden = true;
  await state.start();
  assert.equal(state.requests.length, 0);
  state.document.hidden = false;
  await state.start();
  assert.equal(state.requests[0].init.credentials, 'same-origin');
  assert.equal(state.sockets[0].url, 'wss://device.invalid/enhanced/scrcpy/stream');
  state.stop();
  assert.equal(state.timers.size, 0);
});

test('screen refuses locked or missing built-in services without opening a websocket', async () => {
  for (const session of [{ unlocked: false }, { enabled: false }, { scrcpy: false }, { scrcpy_mode: 'external' }, { screen_service: { installed: false } }]) {
    const state = fixture({ session });
    await state.start();
    assert.equal(state.sockets.length, 0);
    assert.equal(state.elements.status.dataset.error, 'true');
    assert.equal(state.elements.start.disabled, false);
  }
});

test('hiding a page cancels a pending authorization and ignores its late result', async () => {
  let resolveFetch;
  const state = fixture({ fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const pending = state.start();
  state.document.hidden = true;
  state.events.visibilitychange();
  assert.equal(state.requests[0].init.signal.aborted, true);
  resolveFetch({ ok: true, json: async () => state.session });
  await pending;
  assert.equal(state.sockets.length, 0);
  assert.equal(state.timers.size, 0);
  state.document.hidden = false;
  state.events.visibilitychange();
  assert.equal(state.requests.length, 1);
});

test('screen clears video, clipboard and decoder resources on hide and page exit', async () => {
  for (const event of ['visibilitychange', 'pagehide', 'beforeunload']) {
    const state = fixture();
    await state.start();
    const socket = state.configure();
    const decoder = state.decoders[0];
    assert.equal(decoder.config.codec, 'avc1.42c01f');
    assert.equal(decoder.frames.length, 1);
    state.elements.paste.value = 'private text';
    state.document.hidden = true;
    state.events[event]();
    assert.equal(socket.readyState, 3);
    assert.equal(decoder.state, 'closed');
    assert.equal(state.elements.canvas.width, 0);
    assert.equal(state.elements.paste.value, '');
    assert.equal(state.elements.home.disabled, true);
    assert.equal(state.timers.size, 0);
  }
});

test('stale decoder callbacks cannot redraw or stop a newer screen connection', async () => {
  const state = fixture();
  await state.start();
  const previous = state.configure();
  const oldDecoder = state.decoders[0];
  await state.start();
  const current = state.configure();
  let closed = false;
  oldDecoder.callbacks.output({ displayWidth: 640, displayHeight: 960, close: () => { closed = true; } });
  oldDecoder.callbacks.error(new Error('old decoder'));
  assert.equal(previous.readyState, 3);
  assert.equal(current.readyState, 1);
  assert.equal(state.elements.canvas.draws, undefined);
  assert.equal(closed, true);
  state.stop();
});

test('screen rejects malformed or oversized frames and stops when decoder falls behind', async () => {
  for (const invalid of [new ArrayBuffer(2), new ArrayBuffer(2097165), (() => { const data = packet(0, 1); new DataView(data).setUint32(8, 123); return data; })()]) {
    const state = fixture();
    await state.start();
    const socket = state.configure();
    socket.message(invalid);
    assert.equal(socket.readyState, 3);
    assert.equal(state.elements.status.dataset.error, 'true');
  }
  const state = fixture();
  await state.start();
  const socket = state.configure();
  state.decoders[0].decodeQueueSize = 7;
  socket.message(packet(0, 2000));
  assert.equal(socket.readyState, 3);
  assert.match(state.elements.status.textContent, /解码跟不上/);
});

test('screen input bounds pointer rate and clipboard bytes without an unbounded send queue', async () => {
  const state = fixture();
  await state.start();
  const socket = state.configure();
  const target = state.elements.canvas;
  const event = { pointerId: 1, button: 0, clientX: 500, clientY: -100, preventDefault() {} };
  target.handlers.pointerdown(event);
  target.handlers.pointermove(event);
  target.handlers.pointermove(event);
  state.advance(30);
  target.handlers.pointermove(event);
  target.handlers.pointerup(event);
  assert.equal(socket.sent.filter(message => message.action === 2).length, 2);
  assert.equal(socket.sent[0].x, 639);
  assert.equal(socket.sent[0].y, 0);
  assert.equal(socket.sent.at(-1).action, 1);
  state.elements.paste.value = '界'.repeat(2000);
  state.elements['send-text'].handlers.click();
  assert.equal(socket.sent.filter(message => message.type === 'text').length, 0);
  state.elements.paste.value = '测试';
  state.elements['send-text'].handlers.click();
  assert.equal(socket.sent.at(-1).text, '测试');
  assert.equal(state.elements.paste.value, '');
  socket.bufferedAmount = 32769;
  state.elements.home.handlers.click();
  assert.equal(socket.readyState, 3);
  assert.match(state.elements.status.textContent, /网络拥堵/);
});

test('MSE compatibility keeps only a pending frame and destroys its buffers on stop', async () => {
  const state = fixture({ mse: true });
  await state.start();
  const socket = state.configure();
  assert.equal(state.elements.video.hidden, false);
  assert.equal(state.decoders.length, 0);
  socket.message(packet(0, 42000));
  socket.message(packet(0, 83000));
  const muxer = state.muxers[0];
  assert.equal(muxer.frames.length, 2);
  assert.equal(muxer.frames[0].duration, 41);
  assert.equal(muxer.frames[0].isLastVideoFrameComplete, true);
  assert.equal(muxer.config.flushingTime, 0);
  assert.equal(muxer.config.clearBuffer, true);
  assert.equal(muxer.bufferControllers.video.cleanOffset, 5);
  state.stop();
  assert.equal(muxer.destroyed, true);
  assert.equal(state.timers.size, 0);
});

test('MSE stops instead of indefinitely buffering a stalled source buffer', async () => {
  const state = fixture({ mse: true });
  await state.start();
  const socket = state.configure();
  const muxer = state.muxers[0];
  muxer.bufferControllers.video.queue = new Uint8Array(4194305);
  socket.message(packet(0, 42000));
  assert.equal(socket.readyState, 3);
  assert.equal(muxer.destroyed, true);
  assert.match(state.elements.status.textContent, /缓存积压/);
});

test('screen startup deadline and upstream errors release connection resources', async () => {
  for (const upstreamError of [false, true]) {
    const state = fixture();
    await state.start();
    if (upstreamError) state.sockets[0].message({ type: 'error', error: '编码器不可用' });
    else [...state.timers.values()].find(timer => timer.duration === 20000).handler();
    assert.equal(state.sockets[0].readyState, 3);
    assert.equal(state.elements.start.disabled, false);
    assert.equal(state.timers.size, 0);
    assert.equal(state.elements.status.dataset.error, 'true');
  }
});
