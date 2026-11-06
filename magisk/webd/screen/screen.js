'use strict';

(() => {
  const element = name => document.getElementById(name);
  const status = element('status');
  const video = element('video');
  const canvas = element('canvas');
  const controls = [...document.querySelectorAll('[data-key]'), element('rotate'), element('send-text'), element('paste')];
  let socket = null;
  let decoder = null;
  let muxer = null;
  let connectController = null;
  let startTimer = null;
  let generation = 0;
  let playerGeneration = 0;
  let width = 0;
  let height = 0;
  let framesPerSecond = 24;
  let configuration = null;
  let lastTimestamp = null;
  let pendingFrame = null;
  let useWebCodecs = false;
  let acceptingFrames = false;
  let pointer = null;
  let lastMove = 0;

  function report(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  function resetPlayer() {
    playerGeneration++;
    if (decoder) { if (decoder.state !== 'closed') decoder.close(); decoder = null; }
    if (muxer) { muxer.destroy(); muxer = null; }
    configuration = null;
    lastTimestamp = null;
    pendingFrame = null;
    acceptingFrames = false;
    video.pause();
    video.removeAttribute('src');
    video.replaceChildren();
    video.load();
    canvas.width = 0;
    canvas.height = 0;
  }

  function stop(message, error = false) {
    generation++;
    if (connectController) { connectController.abort(); connectController = null; }
    clearTimeout(startTimer);
    startTimer = null;
    const previous = socket;
    socket = null;
    if (previous) { previous.onclose = null; previous.onerror = null; previous.onmessage = null; previous.close(); }
    resetPlayer();
    width = 0;
    height = 0;
    pointer = null;
    element('paste').value = '';
    element('start').disabled = false;
    element('stop').disabled = true;
    element('empty').hidden = false;
    controls.forEach(control => { control.disabled = true; });
    if (message) report(message, error);
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 32768) { stop('网络拥堵，屏幕服务已停止，请重新连接', true); return; }
    socket.send(JSON.stringify(message));
  }

  function sequenceParameters(data) {
    for (let offset = 0; offset < data.length - 7; offset++) {
      if (data[offset] !== 0 || data[offset + 1] !== 0) continue;
      const start = data[offset + 2] === 1 ? offset + 3 : data[offset + 2] === 0 && data[offset + 3] === 1 ? offset + 4 : -1;
      if (start >= 0 && (data[start] & 31) === 7 && start + 3 < data.length) {
        return 'avc1.' + [...data.subarray(start + 1, start + 4)].map(value => value.toString(16).padStart(2, '0')).join('');
      }
    }
    throw new Error('屏幕编码器未提供 H.264 SPS');
  }

  function createMuxer() {
    const current = playerGeneration;
    muxer = new JMuxer({
      node: video, mode: 'video', fps: framesPerSecond, flushingTime: 0, maxDelay: 500, clearBuffer: true,
      onError: () => { if (current === playerGeneration) stop('浏览器无法播放屏幕流，请重连或使用支持 H.264 的浏览器', true); },
      onUnsupportedCodec: () => { if (current === playerGeneration) stop('浏览器不支持 H.264 解码', true); },
    });
  }

  function configure(data) {
    if (data.length > 65536) throw new Error('视频配置超过大小限制');
    const current = ++playerGeneration;
    configuration = data.slice();
    acceptingFrames = false;
    pendingFrame = null;
    lastTimestamp = null;
    if (useWebCodecs) {
      if (decoder && decoder.state !== 'closed') decoder.close();
      decoder = new VideoDecoder({
        output: frame => {
          try {
            if (current !== playerGeneration) return;
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
            }
            canvas.getContext('2d', { alpha: false }).drawImage(frame, 0, 0);
            element('empty').hidden = true;
          } finally { frame.close(); }
        },
        error: () => { if (current === playerGeneration) stop('浏览器解码失败，请切换浏览器后重试', true); },
      });
      decoder.configure({ codec: sequenceParameters(data), optimizeForLatency: true });
    } else {
      if (muxer) muxer.destroy();
      createMuxer();
    }
  }

  function renderPacket(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 13 || buffer.byteLength > 2097164) throw new Error('屏幕数据无效');
    const header = new DataView(buffer);
    const flags = header.getUint32(0);
    if (header.getUint32(8) !== buffer.byteLength - 12) throw new Error('屏幕帧长度不匹配');
    const data = new Uint8Array(buffer, 12);
    if (flags & 0x40000000) { configure(data); return; }
    const timestamp = (flags & 0x1fffffff) * 4294967296 + header.getUint32(4);
    const keyframe = (flags & 0x20000000) !== 0;
    if (!configuration || (!acceptingFrames && !keyframe)) return;
    let frameData = data;
    if (!acceptingFrames) {
      frameData = new Uint8Array(configuration.length + data.length);
      frameData.set(configuration);
      frameData.set(data, configuration.length);
      acceptingFrames = true;
    }
    clearTimeout(startTimer);
    startTimer = null;
    controls.forEach(control => { control.disabled = false; });
    if (useWebCodecs) {
      if (decoder.decodeQueueSize > 6) { stop('屏幕解码跟不上，已停止；请降低帧率或分辨率', true); return; }
      decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp, data: frameData }));
    } else {
      if (pendingFrame) {
        const controller = muxer.bufferControllers?.video;
        const queued = (controller?.queue?.byteLength || 0) + (muxer.remuxController?.tracks?.video?.mp4track?.len || 0);
        if (queued > 4194304) { stop('屏幕播放缓存积压，已停止；请降低码率后重连', true); return; }
        if (controller) controller.cleanOffset = 5;
        const duration = Math.max(1, Math.min(2000, (timestamp - lastTimestamp) / 1000));
        muxer.feed({ video: pendingFrame, duration, isLastVideoFrameComplete: true });
        if (!muxer) return;
      }
      pendingFrame = frameData.slice();
      lastTimestamp = timestamp;
      if (video.paused) video.play().catch(() => {});
      if (video.readyState >= 2) element('empty').hidden = true;
    }
  }

  async function start() {
    stop();
    if (document.hidden) return;
    const current = generation;
    element('start').disabled = true;
    element('stop').disabled = false;
    report('验证权限并启动屏幕服务…');
    const controller = new AbortController();
    connectController = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/enhanced/status', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const session = await response.json();
      if (current !== generation) return;
      if (!response.ok || !session.enabled || !session.unlocked || !session.scrcpy) throw new Error('请返回设备控制，使用主密码登录并解锁增强功能');
      if (session.scrcpy_mode !== 'builtin' || !session.screen_service?.installed) throw new Error('内置屏幕服务未安装，请重新安装完整模块');
      element('public-warning').hidden = !session.public_access;
      framesPerSecond = session.scrcpy_fps || 24;
      useWebCodecs = typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function' && globalThis.isSecureContext;
      if (!useWebCodecs && !(globalThis.MediaSource || globalThis.ManagedMediaSource)) throw new Error('浏览器不支持屏幕解码，请使用新版 Chrome、Edge 或 Safari');
      video.hidden = useWebCodecs;
      canvas.hidden = !useWebCodecs;
      const url = new URL('stream', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const connected = new WebSocket(url);
      socket = connected;
      connected.binaryType = 'arraybuffer';
      startTimer = setTimeout(() => { if (socket === connected) stop('屏幕启动超时，已停止服务，请检查设备编码器支持', true); }, 20000);
      connected.onmessage = event => {
        if (current !== generation || socket !== connected) return;
        try {
          if (typeof event.data !== 'string') { renderPacket(event.data); return; }
          const message = JSON.parse(event.data);
          if (message.type === 'error') { stop(message.error || '屏幕服务出错', true); return; }
          if (message.type === 'size') {
            if (!Number.isInteger(message.width) || !Number.isInteger(message.height) || message.width < 1 || message.height < 1 || message.width > 8192 || message.height > 8192) throw new Error('屏幕尺寸无效');
            width = message.width;
            height = message.height;
            video.width = width;
            video.height = height;
            report(`已连接 · ${width} × ${height} · ${useWebCodecs ? '低延迟解码' : '兼容播放'} · 关闭页面即停止`);
          }
        } catch (failure) { stop(failure.message || '屏幕流处理失败', true); }
      };
      connected.onerror = () => { if (socket === connected) stop('屏幕连接失败；请确认增强功能已解锁且无其他屏幕会话', true); };
      connected.onclose = () => { if (socket === connected) stop('屏幕服务已停止，可能已锁定、达到 15 分钟或网络断开'); };
    } catch (failure) {
      if (current === generation) stop(failure.name === 'AbortError' ? '权限验证超时' : failure.message, true);
    } finally {
      clearTimeout(timeout);
      if (connectController === controller) connectController = null;
    }
  }

  function coordinates(event, target) {
    const bounds = target.getBoundingClientRect();
    const scale = Math.min(bounds.width / width, bounds.height / height);
    const left = bounds.left + (bounds.width - width * scale) / 2;
    const top = bounds.top + (bounds.height - height * scale) / 2;
    return { x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - left) / scale))), y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - top) / scale))) };
  }

  for (const target of [video, canvas]) {
    target.addEventListener('pointerdown', event => {
      if (!acceptingFrames || !width || !height || pointer !== null || event.button !== 0) return;
      event.preventDefault();
      target.focus();
      pointer = event.pointerId;
      target.setPointerCapture(pointer);
      send({ type: 'touch', action: 0, ...coordinates(event, target) });
    });
    target.addEventListener('pointermove', event => {
      if (pointer !== event.pointerId || performance.now() - lastMove < 1000 / 45) return;
      lastMove = performance.now();
      send({ type: 'touch', action: 2, ...coordinates(event, target) });
    });
    const release = event => {
      if (pointer !== event.pointerId) return;
      send({ type: 'touch', action: 1, ...coordinates(event, target) });
      if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
      pointer = null;
    };
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', release);
    target.addEventListener('contextmenu', event => event.preventDefault());
    target.addEventListener('keydown', event => {
      const keys = { Enter: 66, Backspace: 67, Escape: 4, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Tab: 61, Home: 3 };
      if (keys[event.key] && acceptingFrames && !event.repeat) { event.preventDefault(); send({ type: 'key', key: keys[event.key] }); }
    });
  }
  element('start').addEventListener('click', start);
  element('stop').addEventListener('click', () => stop('已停止，设备端录屏进程随连接退出'));
  element('fullscreen').addEventListener('click', () => {
    const result = document.fullscreenElement ? document.exitFullscreen() : element('display').requestFullscreen?.();
    if (result) result.catch(() => report('浏览器未允许全屏'));
  });
  document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => send({ type: 'key', key: Number(button.dataset.key) })));
  element('rotate').addEventListener('click', () => send({ type: 'rotate' }));
  element('send-text').addEventListener('click', () => {
    const input = element('paste');
    if (input.value && new TextEncoder().encode(input.value).length <= 4096) { send({ type: 'text', text: input.value }); input.value = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop('页面已隐藏，屏幕服务已停止；返回后请手动连接'); });
  window.addEventListener('pagehide', () => stop());
  window.addEventListener('beforeunload', () => stop());
})();
