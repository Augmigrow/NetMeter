// Offscreen Electron probe: verifies that Ctrl-dragging one tile never moves the others.
// Run with: node_modules/electron/dist/electron.exe scripts/drag-probe.cjs
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win = null;

function clampPosition(x, y) {
  return { x: Math.round(x), y: Math.round(y) };
}

function sendJson(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function log(message) {
  process.stderr.write('LOG ' + message + '\n');
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/' || pathname === '/index.html') {
    const html = await readFile(path.join(root, 'index.html'));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
    return;
  }
  if (pathname === '/blank') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>probe</title>');
    return;
  }
  if (pathname === '/api/status') return sendJson(response, { enabled: true, configured: true, address: '127.0.0.1:9097' });
  if (pathname === '/api/connections') return sendJson(response, { connections: [] });
  if (pathname === '/api/config') return sendJson(response, { ok: true, persisted: true });
  response.writeHead(404);
  response.end('not found');
});

const seedTight = {
  controllerEnabled: true,
  controllerAddress: '127.0.0.1:9097',
  proxyApp: 'Clash Verge',
  domains: ['alpha.test', 'bravo.test', 'charlie.test'],
  history: '30天',
  lightTheme: false,
  layoutOrder: ['alpha.test', 'bravo.test', 'charlie.test'],
  meterPositions: {
    'alpha.test': { x: 40, y: 320 },
    'bravo.test': { x: 240, y: 40 },
    'charlie.test': { x: 40, y: 180 }
  }
};

const seed = {
  controllerEnabled: true,
  controllerAddress: '127.0.0.1:9097',
  proxyApp: 'Clash Verge',
  domains: ['alpha.test', 'bravo.test', 'charlie.test'],
  history: '30天',
  lightTheme: false,
  layoutOrder: ['alpha.test', 'bravo.test', 'charlie.test'],
  meterPositions: {
    'alpha.test': { x: 62, y: 332 },
    'bravo.test': { x: 0, y: 0 },
    'charlie.test': { x: 0, y: 156 }
  }
};

async function waitForTiles() {
  for (let index = 0; index < 100; index += 1) {
    const count = await win.webContents.executeJavaScript("document.querySelectorAll('.meter').length");
    if (count === 3) return;
    await sleep(100);
  }
  throw new Error('tiles did not render');
}

async function reset(seedData, position) {
  win.setContentSize(900, 700);
  const target = position || { x: 180, y: 120 };
  win.setPosition(target.x, target.y);
  const payload = JSON.stringify(seedData || seed);
  await win.loadURL('http://127.0.0.1:' + global.port + '/blank');
  await win.webContents.executeJavaScript('localStorage.setItem("netmeter-controller-v2", ' + JSON.stringify(payload) + ')');
  await win.loadURL(pageUrl);
  await waitForTiles();
  await sleep(500);
  await win.webContents.executeJavaScript("Element.prototype.setPointerCapture = function () {}; Element.prototype.releasePointerCapture = function () {}; Element.prototype.hasPointerCapture = function () { return false; }; true");
  await win.webContents.executeJavaScript(`(() => {
    window.__moveCalls = [];
    window.__dragTrace = [];
    const originalMoveTo = window.moveTo.bind(window);
    window.moveTo = (x, y) => {
      const call = {
        requested: [x, y],
        before: [window.screenX, window.screenY],
        avail: [screen.availLeft, screen.availTop, screen.availWidth, screen.availHeight],
        outer: [window.outerWidth, window.outerHeight]
      };
      originalMoveTo(x, y);
      call.after = [window.screenX, window.screenY];
      window.__moveCalls.push(call);
    };
    return true;
  })()`);
}

async function snapshot() {
  const bounds = win.getBounds();
  const tiles = await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.meter')).map(meter => { const rect = meter.getBoundingClientRect(); return { host: meter.dataset.host, x: Math.round(rect.left), y: Math.round(rect.top) }; })");
  return {
    window: { x: bounds.x, y: bounds.y },
    tiles: tiles.map(tile => ({ host: tile.host, x: bounds.x + tile.x, y: bounds.y + tile.y }))
  };
}

async function dispatchDrag(host, deltaX, deltaY, steps, release) {
  const script = `(() => {
    const host = ${JSON.stringify(host)};
    const deltaX = ${deltaX};
    const deltaY = ${deltaY};
    const steps = ${steps};
    const release = ${release ? 'true' : 'false'};
    const meter = document.querySelector('.meter[data-host="' + host + '"]');
    const rect = meter.getBoundingClientRect();
    const baseX = Math.round(rect.left + 60);
    const baseY = Math.round(rect.top + 40);
    const make = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
      ctrlKey: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y
    });
    window.__probeTrail = [];
    const record = label => window.__probeTrail.push({ label, x: window.screenX, y: window.screenY });
    meter.dispatchEvent(make('pointerdown', baseX, baseY));
    record('down');
    for (let step = 1; step <= steps; step += 1) {
      document.dispatchEvent(make('pointermove', Math.round(baseX + deltaX * step / steps), Math.round(baseY + deltaY * step / steps)));
      record('move' + step);
    }
    if (release) {
      document.dispatchEvent(make('pointerup', Math.round(baseX + deltaX), Math.round(baseY + deltaY)));
      record('up');
    }
    return true;
  })()`;
  return win.webContents.executeJavaScript(script);
}

async function watch(ms) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < ms) {
    samples.push(await snapshot());
    await sleep(250);
  }
  samples.push(await snapshot());
  return samples;
}

function reportWatch(name, samples) {
  const hosts = samples[0].tiles.map(tile => tile.host);
  const swings = hosts.map(host => {
    const xs = samples.map(sample => sample.tiles.find(tile => tile.host === host).x);
    const ys = samples.map(sample => sample.tiles.find(tile => tile.host === host).y);
    return { host, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  process.stdout.write('PROBE ' + JSON.stringify({
    scenario: name,
    windowStart: samples[0].window,
    windowEnd: samples[samples.length - 1].window,
    swings,
    jitter: swings.some(item => item.minX !== item.maxX || item.minY !== item.maxY)
  }) + '\n');
}

async function dispatchDragPlain(host, deltaX, deltaY, steps) {
  const script = `(() => {
    const host = ${JSON.stringify(host)};
    const deltaX = ${deltaX};
    const deltaY = ${deltaY};
    const steps = ${steps};
    const meter = document.querySelector('.meter[data-host="' + host + '"]');
    const rect = meter.getBoundingClientRect();
    const baseX = Math.round(rect.left + 60);
    const baseY = Math.round(rect.top + 40);
    const make = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
      ctrlKey: false, pointerId: 9, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y
    });
    meter.dispatchEvent(make('pointerdown', baseX, baseY));
    for (let step = 1; step <= steps; step += 1) {
      document.dispatchEvent(make('pointermove', Math.round(baseX + deltaX * step / steps), Math.round(baseY + deltaY * step / steps)));
    }
    document.dispatchEvent(make('pointerup', Math.round(baseX + deltaX), Math.round(baseY + deltaY)));
    return true;
  })()`;
  return win.webContents.executeJavaScript(script);
}

async function drag(host, deltaX, deltaY, steps, release) {
  const before = await snapshot();
  await dispatchDrag(host, deltaX, deltaY, steps, release);
  await sleep(450);
  const during = await snapshot();
  if (release) {
    await sleep(500);
  }
  const after = await snapshot();
  return { before, during, after };
}

async function readViewportRects() {
  return win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.meter')).map(meter => { const rect = meter.getBoundingClientRect(); return { host: meter.dataset.host, x: rect.left, y: rect.top }; })");
}

async function frameDrag(host, deltaX, deltaY, steps) {
  const before = await snapshot();
  const tile = before.tiles.find(item => item.host === host);
  const startScreenX = tile.x + 60;
  const startScreenY = tile.y + 40;
  const startClientX = startScreenX - before.window.x;
  const startClientY = startScreenY - before.window.y;
  const pointer = (type, clientX, clientY) => win.webContents.executeJavaScript(`(() => {
    const target = ${JSON.stringify(type)} === 'pointerdown'
      ? document.querySelector('.meter[data-host="' + ${JSON.stringify(host)} + '"]')
      : document;
    target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      bubbles: true, cancelable: true, composed: true, button: 0,
      buttons: ${JSON.stringify(type)} === 'pointerup' ? 0 : 1, ctrlKey: true, pointerId: 7,
      pointerType: 'mouse', isPrimary: true,
      clientX: ${clientX}, clientY: ${clientY}, screenX: window.screenX + ${clientX}, screenY: window.screenY + ${clientY}
    }));
    return true;
  })()`);
  const samples = [];
  const sample = async () => {
    const bounds = win.getBounds();
    const rects = await readViewportRects();
    samples.push({
      t: Date.now(),
      window: { x: bounds.x, y: bounds.y },
      tiles: rects.map(tile => ({ host: tile.host, x: bounds.x + tile.x, y: bounds.y + tile.y }))
    });
  };
  let error = null;
  try {
    await pointer('pointerdown', startClientX, startClientY);
    await sample();
    for (let step = 1; step <= steps; step += 1) {
      const bounds = win.getBounds();
      const screenX = Math.round(startScreenX + deltaX * step / steps);
      const screenY = Math.round(startScreenY + deltaY * step / steps);
      await pointer('pointermove', screenX - bounds.x, screenY - bounds.y);
      await sleep(20);
      await sample();
    }
  } catch (caught) {
    error = String(caught && caught.stack || caught);
  }
  const finalBounds = win.getBounds();
  await pointer('pointerup', Math.round(startScreenX + deltaX) - finalBounds.x, Math.round(startScreenY + deltaY) - finalBounds.y);
  await sleep(350);
  await sample();
  return { before, frames: samples, error };
}
function reportFrames(name, result, hosts) {
  const frames = result.frames || [];
  const summary = hosts.map(host => {
    const xs = frames.map(frame => frame.tiles.find(tile => tile.host === host).x);
    const ys = frames.map(frame => frame.tiles.find(tile => tile.host === host).y);
    return { host, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), swings: new Set(xs.map(value => String(value))).size + new Set(ys.map(value => String(value))).size - 2 };
  });
  process.stdout.write('PROBE ' + JSON.stringify({ scenario: name, frameCount: frames.length, summary, error: result.error || null, jitter: summary.some(item => item.minX !== item.maxX || item.minY !== item.maxY) }) + '\n');
  if (result.error || summary.some(item => item.maxX - item.minX > 1 || item.maxY - item.minY > 1)) throw new Error(name + ': stationary tiles moved');
}

function movedTiles(result, hosts) {
  return hosts.map(host => {
    const start = result.before.tiles.find(item => item.host === host);
    const end = result.after.tiles.find(item => item.host === host);
    return { host, from: start, to: end, moved: start.x !== end.x || start.y !== end.y };
  });
}

function report(name, result, others) {
  if (movedTiles(result, others).some(item => item.moved)) throw new Error(name + ': stationary tiles moved');
  const start = result.before.tiles.find(item => item.host === 'alpha.test');
  const end = result.after.tiles.find(item => item.host === 'alpha.test');
  const during = result.during.tiles.find(item => item.host === 'alpha.test');
  process.stdout.write('PROBE ' + JSON.stringify({
    scenario: name,
    window: { before: result.before.window, during: result.during.window, after: result.after.window },
    dragged: { start, during, end },
    others: movedTiles(result, others),
    othersMoved: movedTiles(result, others).some(item => item.moved),
    othersMovedDuringDrag: others.some(host => {
      const base = result.before.tiles.find(item => item.host === host);
      const mid = result.during.tiles.find(item => item.host === host);
      return base.x !== mid.x || base.y !== mid.y;
    })
  }) + '\n');
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  log('server:' + port);

  win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    width: 900,
    height: 700,
    x: 180,
    y: 120,
    webPreferences: {
      preload: path.join(root, 'scripts', 'drag-probe-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  ipcMain.on('probe:move-fast', (event, payload) => {
    const position = clampPosition(payload.x, payload.y);
    win.setPosition(position.x, position.y);
  });

  ipcMain.handle('probe:position', () => {
    const bounds = win.getBounds();
    return { x: bounds.x, y: bounds.y };
  });

  ipcMain.on('probe:move-sync', (event, payload) => {
    const before = win.getBounds();
    win.setPosition(Math.round(payload.x), Math.round(payload.y));
    const bounds = win.getBounds();
    event.returnValue = { x: bounds.x, y: bounds.y, deltaX: bounds.x - before.x, deltaY: bounds.y - before.y };
  });

  ipcMain.handle('probe:move', (event, payload) => {
    const position = clampPosition(payload.x, payload.y);
    win.setPosition(position.x, position.y);
    const bounds = win.getBounds();
    return { x: bounds.x, y: bounds.y };
  });

  ipcMain.handle('probe:resize', (event, payload) => {
    win.setContentSize(Math.max(192, Math.round(payload.width)), Math.max(160, Math.round(payload.height)));
    const bounds = win.getBounds();
    return { width: bounds.width, height: bounds.height };
  });

  global.port = port;
  global.pageUrl = 'http://127.0.0.1:' + port + '/?view=widget';
  await win.loadURL(global.pageUrl);
  log('loaded');

  const selfBefore = win.getBounds();
  const selfReport = await win.webContents.executeJavaScript('(() => { const info = { availLeft: screen.availLeft, availTop: screen.availTop, availWidth: screen.availWidth, availHeight: screen.availHeight, outerWidth, outerHeight, sx: screenX, sy: screenY }; window.moveTo(400, 300); return { info, afterX: screenX, afterY: screenY }; })()');
  await sleep(300);
  log('moveToTest=' + JSON.stringify({ before: selfBefore, report: selfReport, after: win.getBounds() }));

  await reset();
  const left = await drag('alpha.test', -180, 0, 12, true);
  report('drag-left-past-window-edge', left, ['bravo.test', 'charlie.test']);
  log('moveCalls=' + JSON.stringify(await win.webContents.executeJavaScript('window.__moveCalls')));
  log('dragTrace=' + JSON.stringify(await win.webContents.executeJavaScript('window.__dragTrace')));

  await reset();
  const up = await drag('alpha.test', 0, -240, 12, true);
  report('drag-up-past-window-edge', up, ['bravo.test', 'charlie.test']);

  await reset();
  const onto = await drag('alpha.test', -62, -176, 12, true);
  report('drag-onto-neighbour', onto, ['bravo.test', 'charlie.test']);

  await reset();
  const nearby = await drag('alpha.test', -56, -170, 12, true);
  report('drag-near-neighbour', nearby, ['bravo.test', 'charlie.test']);

  await reset();
  const midDrag = await drag('alpha.test', -180, 0, 12, false);
  report('drag-left-without-release', midDrag, ['bravo.test', 'charlie.test']);

  await reset();
  const otherTile = await drag('bravo.test', 90, 60, 10, true);
  report('drag-second-tile', otherTile, ['alpha.test', 'charlie.test']);

  await reset(seedTight);
  const tightened = await drag('alpha.test', 60, 40, 10, true);
  report('drag-with-tighten-pass', tightened, ['bravo.test', 'charlie.test']);

  await reset(seedTight);
  const idleSamples = await watch(3000);
  reportWatch('idle-after-reset-tight-seed', idleSamples);

  await reset();
  const farDrag = await drag('alpha.test', 320, 0, 16, true);
  report('drag-far-right', farDrag, ['bravo.test', 'charlie.test']);
  const afterFarSamples = await watch(2500);
  reportWatch('idle-after-far-right-drag', afterFarSamples);

  await reset();
  const frameLeft = await frameDrag('alpha.test', -180, 0, 30);
  reportFrames('frames-drag-left-past-edge', frameLeft, ['bravo.test', 'charlie.test']);

  await reset();
  const frameOnto = await frameDrag('alpha.test', -62, -176, 30);
  reportFrames('frames-drag-onto-neighbour', frameOnto, ['bravo.test', 'charlie.test']);

  const secondary = screen.getDisplayNearestPoint({ x: -1548, y: 417 });
  log('secondary scale=' + secondary.scaleFactor + ' bounds=' + JSON.stringify(secondary.bounds));
  await reset();
  const plainBefore = await snapshot();
  await dispatchDragPlain('alpha.test', 100, 80, 10);
  await sleep(700);
  const plainAfter = await snapshot();
  process.stdout.write('PROBE ' + JSON.stringify({
    scenario: 'plain-drag-moves-whole-widget',
    windowDelta: { x: plainAfter.window.x - plainBefore.window.x, y: plainAfter.window.y - plainBefore.window.y },
    tiles: plainAfter.tiles.map(tile => {
      const start = plainBefore.tiles.find(item => item.host === tile.host);
      return { host: tile.host, dx: tile.x - start.x, dy: tile.y - start.y };
    })
  }) + '\n');

  await reset();
  const lateBefore = await snapshot();
  await win.webContents.executeJavaScript(`(() => {
    const meter = document.querySelector('.meter[data-host="alpha.test"]');
    const rect = meter.getBoundingClientRect();
    const sx = Math.round(rect.left + 60), sy = Math.round(rect.top + 40);
    const make = (type, x, y, ctrl) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
      ctrlKey: ctrl, pointerId: 11, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y
    });
    meter.dispatchEvent(make('pointerdown', sx, sy, false));
    document.dispatchEvent(make('pointermove', sx + 20, sy, false));
    return true;
  })()`);
  await sleep(200);
  const lateClass1 = await win.webContents.executeJavaScript('document.body.className');
  const lateLeft1 = await win.webContents.executeJavaScript('document.querySelector(".meter[data-host=\'alpha.test\']").style.left');
  const lateAfterWindow = await snapshot();
  await win.webContents.executeJavaScript(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
    const meter = document.querySelector('.meter[data-host="alpha.test"]');
    const rect = meter.getBoundingClientRect();
    const sx = Math.round(rect.left + 60), sy = Math.round(rect.top + 40);
    const make = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
      ctrlKey: true, pointerId: 11, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y
    });
    document.dispatchEvent(make('pointermove', sx + 60, sy));
    document.dispatchEvent(make('pointermove', sx + 120, sy));
    document.dispatchEvent(make('pointerup', sx + 120, sy));
    return true;
  })()`);
  await sleep(500);
  const lateClass2 = await win.webContents.executeJavaScript('document.body.className');
  const lateLeft2 = await win.webContents.executeJavaScript('document.querySelector(".meter[data-host=\'alpha.test\']").style.left');
  const lateAfter = await snapshot();
  log('lateTrace=' + JSON.stringify({ lateClass1, lateLeft1, lateClass2, lateLeft2 }));
  process.stdout.write('PROBE ' + JSON.stringify({
    scenario: 'mouse-then-ctrl-converts',
    window: { before: lateBefore.window, afterFirstMove: lateAfterWindow.window, after: lateAfter.window },
    tiles: lateBefore.tiles.map(tile => {
      const mid = lateAfterWindow.tiles.find(item => item.host === tile.host);
      const end = lateAfter.tiles.find(item => item.host === tile.host);
      return { host: tile.host, firstDx: mid.x - tile.x, secondDx: end.x - mid.x, secondDy: end.y - mid.y };
    })
  }) + '\n');

  await reset(seed, { x: -1548, y: 417 });
  const dpr = await win.webContents.executeJavaScript('window.devicePixelRatio');
  log('secondary devicePixelRatio=' + dpr);
  const frameSecondary = await frameDrag('alpha.test', -180, 0, 30);
  reportFrames('frames-on-secondary-display', frameSecondary, ['bravo.test', 'charlie.test']);

  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    const leftmost = displays.reduce((left, display) => display.bounds.x < left.bounds.x ? display : left);
    const rightmost = displays.reduce((right, display) => display.bounds.x > right.bounds.x ? display : right);
    await reset(seed, { x: rightmost.workArea.x + 120, y: rightmost.workArea.y + 120 });
    const beforeCross = await snapshot();
    const targetX = leftmost.workArea.x + Math.min(160, leftmost.workArea.width - 200);
    const targetY = leftmost.workArea.y + 160;
    const tile = beforeCross.tiles.find(item => item.host === 'alpha.test');
    const fromX = tile.x + 60, fromY = tile.y + 40;
    const crossing = await frameDrag('alpha.test', targetX - fromX, targetY - fromY, 100);
    reportFrames('frames-crossing-display-seam', crossing, ['bravo.test', 'charlie.test']);
    const afterCross = await snapshot();
    const landed = afterCross.tiles.find(item => item.host === 'alpha.test');
    if (Math.abs(landed.x - (targetX - 60)) > 2 || Math.abs(landed.y - (targetY - 40)) > 2) {
      throw new Error('Ctrl-drag did not land on the secondary display: ' + JSON.stringify({ landed, targetX, targetY }));
    }
    process.stdout.write('PROBE ' + JSON.stringify({
      scenario: 'ctrl-drag-crosses-display-boundary-in-one-gesture',
      displays: displays.map(display => display.bounds),
      expectedDisplay: leftmost.bounds,
      before: beforeCross.window,
      after: afterCross.window,
      tile: landed,
      expectedTile: { x: targetX - 60, y: targetY - 40 }
    }) + '\n');
    const returnTile = afterCross.tiles.find(item => item.host === 'alpha.test');
    const returning = await frameDrag('alpha.test', tile.x - returnTile.x, tile.y - returnTile.y, 100);
    reportFrames('frames-returning-across-display-seam', returning, ['bravo.test', 'charlie.test']);
    const returned = (await snapshot()).tiles.find(item => item.host === 'alpha.test');
    if (Math.abs(returned.x - tile.x) > 2 || Math.abs(returned.y - tile.y) > 2) throw new Error('Return Ctrl-drag missed target');
    if (BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isAlwaysOnTop())) throw new Error('Probe window became visible or topmost');
  }
}

app.whenReady().then(main).catch(error => {
  process.stderr.write('PROBE ERROR ' + (error && error.stack || error) + '\n');
  process.exitCode = 1;
}).finally(() => {
  server.close();
  app.quit();
});

