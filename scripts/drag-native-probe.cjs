// Hidden acceptance probe for the independent tile drag.
//
// The probe imports the real production main process with an isolated
// temporary profile and an isolated port. Every window stays hidden, unfocused
// and non topmost. Native geometry calls are recorded and then delegated to the
// real Electron methods, and the pointer input is injected into the probe owned
// web contents only.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const profile = mkdtempSync(join(tmpdir(), 'netmeter-native-drag-'));
app.setPath('appData', profile);
app.setPath('userData', join(profile, 'user-data'));
process.env.PORT = '4197';

const log = [];
let failed = 0;
let skipped = 0;

function check(name, pass, detail) {
  log.push((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail));
  if (!pass) failed++;
  writeFileSync(join(__dirname, 'drag-native-probe.log'), log.join('\n'));
}

function skip(name, detail) {
  skipped += 1;
  log.push('SKIP ' + name + ' :: ' + JSON.stringify(detail));
  writeFileSync(join(__dirname, 'drag-native-probe.log'), log.join('\n'));
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep every window hidden and unfocused. The interceptor records the request
// instead of replacing the code under test.
const showCalls = [];
BrowserWindow.prototype.show = function () { showCalls.push(this.id); };
BrowserWindow.prototype.focus = function () {};
const nativeTop = BrowserWindow.prototype.setAlwaysOnTop;
BrowserWindow.prototype.setAlwaysOnTop = function () { nativeTop.call(this, false); };

// Record native geometry calls while delegating to the real method.
const positionCalls = [];
const nativeSetPosition = BrowserWindow.prototype.setPosition;
BrowserWindow.prototype.setPosition = function (x, y) {
  positionCalls.push({ id: this.id, x, y });
  return nativeSetPosition.call(this, x, y);
};
const shapeCalls = [];
const nativeSetShape = BrowserWindow.prototype.setShape;
BrowserWindow.prototype.setShape = function (rects) {
  shapeCalls.push({ id: this.id, rects: rects.map(rect => ({ ...rect })) });
  return nativeSetShape.call(this, rects);
};

// The injected pointer is the only cursor the main process may read. The
// production code still asks the Electron screen module for one consistent
// logical desktop position. The screen module may only be touched after the
// app is ready, so the replacement is installed below.
const cursor = { x: 0, y: 0 };

setTimeout(() => { console.error('Probe hard deadline'); app.exit(2); }, 120000);

function tileKeyOf(win) {
  try {
    return new URL(win.webContents.getURL()).searchParams.get('key') || '';
  } catch {
    return '';
  }
}

function tileWindows() {
  return BrowserWindow.getAllWindows().filter(win => tileKeyOf(win));
}

function settingsWindow() {
  return BrowserWindow.getAllWindows().find(win => /view=settings/.test(win.webContents.getURL()));
}

function windowById(id) {
  return BrowserWindow.getAllWindows().find(win => win.id === id);
}

async function waitFor(predicate, timeout = 20000, step = 60) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(step);
  }
  return null;
}

function pointer(win, type, desktopX, desktopY, modifiers) {
  const bounds = win.getBounds();
  const x = Math.round(desktopX - bounds.x);
  const y = Math.round(desktopY - bounds.y);
  cursor.x = desktopX;
  cursor.y = desktopY;
  win.webContents.sendInputEvent({
    type,
    x,
    y,
    button: 'left',
    clickCount: 1,
    modifiers: modifiers || []
  });
}

async function dragTile(win, { from, to, via = [], ctrl = false, ctrlAfterDown = false, steps = 24, hold = 18 }) {
  const downModifiers = ctrl ? ['control'] : [];
  const moveModifiers = [...downModifiers, 'leftButtonDown'];
  pointer(win, 'mouseDown', from.x, from.y, downModifiers);
  await pause(40);
  if (ctrlAfterDown) {
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true })); void 0;`);
    await pause(30);
  }
  let current = from;
  let minWindowX = win.getBounds().x;
  for (const destination of [...via, to]) {
    for (let step = 1; step <= steps; step++) {
      const target = {
        x: current.x + (destination.x - current.x) * step / steps,
        y: current.y + (destination.y - current.y) * step / steps
      };
      pointer(win, 'mouseMove', target.x, target.y, moveModifiers);
      await pause(hold);
      minWindowX = Math.min(minWindowX, win.getBounds().x);
    }
    current = destination;
  }
  if (ctrlAfterDown) {
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true })); void 0;`);
    await pause(30);
  }
  return { downModifiers, moveModifiers, minWindowX };
}

function releaseTile(win, at, ctrl = false) {
  pointer(win, 'mouseUp', at.x, at.y, ctrl ? ['control'] : []);
}

async function pointerAcknowledged(win, type, at) {
  const channel = { mouseDown: 'tile:drag-down', mouseMove: 'tile:drag-move', mouseUp: 'tile:drag-up' }[type];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, listener);
      reject(new Error('Missing production IPC acknowledgement: ' + type));
    }, 5000);
    function listener(event) {
      if (event.sender !== win.webContents) return;
      clearTimeout(timer);
      ipcMain.removeListener(channel, listener);
      resolve();
    }
    ipcMain.on(channel, listener);
    pointer(win, type, at.x, at.y, type === 'mouseMove' ? ['control', 'leftButtonDown'] : ['control']);
  });
}

function tileBounds(win) {
  const bounds = win.getBounds();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function lastShape(win) {
  return [...shapeCalls].reverse().find(call => call.id === win.id)?.rects || [];
}

function regionBounds(rects) {
  if (!rects.length) return null;
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

async function clickElement(win, selector) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const bounds = win.getBounds();
  const desktopPoint = { x: bounds.x + point.x, y: bounds.y + point.y };
  pointer(win, 'mouseDown', desktopPoint.x, desktopPoint.y);
  await pause(40);
  pointer(win, 'mouseUp', desktopPoint.x, desktopPoint.y);
}

(async () => {
  // The absolute layout has to exist before the main process reads it.
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, 'tile-layout.json'), JSON.stringify({
    version: 2,
    tiles: {
      'alpha.test': { x: 100, y: 100 },
      'bravo.test': { x: 400, y: 100 },
      'charlie.test': { x: 100, y: 600 }
    }
  }, null, 2));

  await import(pathToFileURL(join(root, 'main.mjs')).href);
  await app.whenReady();

  const nativeCursor = screen.getCursorScreenPoint;
  screen.getCursorScreenPoint = function () { return { x: cursor.x, y: cursor.y }; };
  check('the probe controls the cursor source the main process reads',
    screen.getCursorScreenPoint().x === cursor.x && nativeCursor !== screen.getCursorScreenPoint,
    { patched: true });

  const settings = await waitFor(() => {
    const win = settingsWindow();
    return win && !win.webContents.isLoading() ? win : null;
  });
  if (!settings) throw new Error('The settings window never became ready');
  const bootPort = new URL(settings.webContents.getURL()).port;
  const bootStatus = await fetch('http://127.0.0.1:' + bootPort + '/').then(response => response.status).catch(error => String(error));
  check('the local collector server is reachable for the hidden windows',
    bootStatus === 200, { port: bootPort, status: bootStatus });

  // Seed the shared domain list and the absolute tile layout.
  const seed = {
    controllerEnabled: false,
    domains: ['alpha.test', 'bravo.test', 'charlie.test'],
    domainEntries: [
      { url: 'alpha.test', visible: true },
      { url: 'bravo.test', visible: true },
      { url: 'charlie.test', visible: true }
    ],
    history: '7天',
    avgWindow: '5分钟',
    lightTheme: false,
    meterPositions: {}
  };
  await settings.webContents.executeJavaScript('localStorage.setItem("netmeter-controller-v2",' + JSON.stringify(JSON.stringify(seed)) + ')');
  settings.webContents.reload();

  const tiles = await waitFor(() => {
    const found = tileWindows();
    return found.length === 3 ? found : null;
  });
  if (!tiles) throw new Error('The tile windows never appeared');
  let alpha = tiles.find(win => tileKeyOf(win) === 'alpha.test');
  const bravo = tiles.find(win => tileKeyOf(win) === 'bravo.test');
  const charlie = tiles.find(win => tileKeyOf(win) === 'charlie.test');

  check('every visible domain owns an independent native window',
    tiles.length === 3 && new Set(tiles.map(tileKeyOf)).size === 3,
    tiles.map(win => ({ key: tileKeyOf(win), bounds: tileBounds(win) })));

  const alphaRect = await alpha.webContents.executeJavaScript('(() => { const r = document.querySelector(".meter").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()');
  check('the tile keeps the 180 by 148 content box inside its own window',
    alphaRect.width === 180 && alphaRect.height === 148, alphaRect);

  const alphaTile = await alpha.webContents.executeJavaScript('(() => { const meter = document.querySelector(".meter"); return { host: meter?.dataset.host, label: meter?.querySelector(".host-button")?.textContent, down: meter?.querySelector(".average-down")?.textContent, gear: Boolean(meter?.querySelector(".settings-button")) }; })()');
  check('the tile window renders its own domain with the shared statistics rows',
    alphaTile.host === 'alpha.test' && alphaTile.label === 'alpha.test' && alphaTile.gear === true,
    alphaTile);
  const guidesAttached = await alpha.webContents.executeJavaScript(`({ x: document.getElementById('verticalAlignmentGuide')?.parentElement?.id === 'meters', y: document.getElementById('horizontalAlignmentGuide')?.parentElement?.id === 'meters' })`);
  check('the X and Y alignment guides remain attached after tile rendering', guidesAttached.x && guidesAttached.y, guidesAttached);

  check('the tiles start at the seeded absolute positions',
    Math.abs(alpha.getBounds().x + 6 - 100) <= 1 && Math.abs(bravo.getBounds().x + 6 - 400) <= 1,
    { alpha: tileBounds(alpha), bravo: tileBounds(bravo) });

  const normalShapes = tiles.map(win => ({ key: tileKeyOf(win), bounds: regionBounds(lastShape(win)) }));
  check('each tile has a rounded native hit region smaller than its transparent window bounds',
    normalShapes.length === 3 && normalShapes.every(item => item.bounds?.x === 3 && item.bounds?.y === 3 && item.bounds?.width === 186 && item.bounds?.height === 154),
    normalShapes);

  await clickElement(alpha, '.host-button');
  const historyOpened = await waitFor(() => alpha.getBounds().width === 380 && alpha.getBounds().height === 306 ? true : null);
  const historyShape = regionBounds(lastShape(alpha));
  check('opening history expands the native hit region over the full panel',
    Boolean(historyOpened) && historyShape?.x === 0 && historyShape?.y === 0 && historyShape?.width === 380 && historyShape?.height === 306,
    { opened: Boolean(historyOpened), shape: historyShape });
  await clickElement(alpha, '#closeDialog');
  const historyClosed = await waitFor(() => alpha.getBounds().width === 192 && alpha.getBounds().height === 160 ? true : null);
  const closedShape = regionBounds(lastShape(alpha));
  check('closing history restores the tile-only hit region without a stale panel region',
    Boolean(historyClosed) && closedShape?.x === 3 && closedShape?.y === 3 && closedShape?.width === 186 && closedShape?.height === 154,
    { closed: Boolean(historyClosed), shape: closedShape });

  const xAxisGrabBounds = alpha.getBounds();
  const xAxisGrab = { x: xAxisGrabBounds.x + 60, y: xAxisGrabBounds.y + 40 };
  check('starting the X-only native drag', true, { bounds: xAxisGrabBounds, from: xAxisGrab, to: { x: xAxisGrab.x + 296, y: xAxisGrab.y + 30 } });
  await dragTile(alpha, { from: xAxisGrab, to: { x: xAxisGrab.x + 296, y: xAxisGrab.y + 30 }, ctrl: true, steps: 30, hold: 16 });
  check('the X-only native drag input sequence completed', true, tileBounds(alpha));
  const xAxisSettled = await waitFor(() => {
    const bounds = tileBounds(alpha);
    return Math.abs(bounds.x + 6 - 400) <= 1 && Math.abs(bounds.y + 6 - 130) <= 1 ? bounds : null;
  }, 5000, 30);
  check('the X-only native position settles before mouse-up', Boolean(xAxisSettled), xAxisSettled || tileBounds(alpha));
  const xAxisGuides = await Promise.race([
    alpha.webContents.executeJavaScript(`({ x: document.getElementById('verticalAlignmentGuide').classList.contains('show'), y: document.getElementById('horizontalAlignmentGuide').classList.contains('show') })`).catch(error => ({ error: String(error.message) })),
    pause(5000).then(() => ({ timeout: true }))
  ]);
  releaseTile(alpha, { x: xAxisGrab.x + 296, y: xAxisGrab.y + 30 }, true);
  await pause(160);
  const xAxisResult = tileBounds(alpha);
  check('a native X-only snap aligns X while preserving the free Y position',
    Boolean(xAxisGuides?.x && !xAxisGuides.y) && Math.abs(xAxisResult.x + 6 - 400) <= 1 && Math.abs(xAxisResult.y + 6 - 130) <= 1,
    { guides: xAxisGuides, content: { x: xAxisResult.x + 6, y: xAxisResult.y + 6 } });
  alpha.setPosition(94, 94);
  await pause(80);

  const yAxisGrabBounds = alpha.getBounds();
  const yAxisGrab = { x: yAxisGrabBounds.x + 60, y: yAxisGrabBounds.y + 40 };
  await dragTile(alpha, { from: yAxisGrab, to: { x: yAxisGrab.x + 30, y: yAxisGrab.y + 496 }, ctrl: true, steps: 36, hold: 16 });
  const yAxisSettled = await waitFor(() => {
    const bounds = tileBounds(alpha);
    return Math.abs(bounds.x + 6 - 130) <= 1 && Math.abs(bounds.y + 6 - 600) <= 1 ? bounds : null;
  }, 5000, 30);
  check('the Y-only native position settles before mouse-up', Boolean(yAxisSettled), yAxisSettled || tileBounds(alpha));
  const yAxisGuides = await Promise.race([
    alpha.webContents.executeJavaScript(`({ x: document.getElementById('verticalAlignmentGuide').classList.contains('show'), y: document.getElementById('horizontalAlignmentGuide').classList.contains('show') })`).catch(error => ({ error: String(error.message) })),
    pause(5000).then(() => ({ timeout: true }))
  ]);
  releaseTile(alpha, { x: yAxisGrab.x + 30, y: yAxisGrab.y + 496 }, true);
  await pause(160);
  const yAxisResult = tileBounds(alpha);
  check('a native Y-only snap aligns Y while preserving the free X position',
    !yAxisGuides.x && yAxisGuides.y && Math.abs(yAxisResult.x + 6 - 130) <= 1 && Math.abs(yAxisResult.y + 6 - 600) <= 1,
    { guides: yAxisGuides, content: { x: yAxisResult.x + 6, y: yAxisResult.y + 6 } });
  alpha.setPosition(94, 94);
  await pause(80);

  // Unlike the older overlapping cases, these paths keep a real gap between
  // cards. Each cursor sample waits for the production IPC handler, so the next
  // injected sample cannot overwrite the cursor before the current one is read.
  const separatedCases = [
    { name: 'X below', raw: { x: 404, y: 272 }, expected: { x: 400, y: 272 }, axis: 'x', free: 'y', direction: 1 },
    { name: 'X above', raw: { x: 404, y: -72 }, expected: { x: 400, y: -72 }, axis: 'x', free: 'y', direction: -1 },
    { name: 'Y right', raw: { x: 604, y: 104 }, expected: { x: 604, y: 100 }, axis: 'y', free: 'x', direction: 1 },
    { name: 'Y left', raw: { x: 196, y: 104 }, expected: { x: 196, y: 100 }, axis: 'y', free: 'x', direction: -1 }
  ];
  for (const scenario of separatedCases) {
    alpha.setPosition(94, 94);
    await pause(100);
    const start = alpha.getBounds();
    const grabOffset = { x: 60, y: 40 };
    const from = { x: start.x + grabOffset.x, y: start.y + grabOffset.y };
    await pointerAcknowledged(alpha, 'mouseDown', from);
    await pointerAcknowledged(alpha, 'mouseMove', { x: from.x + 12, y: from.y });
    const firstWrite = positionCalls.length;
    const frames = [];
    let at;
    let expected;
    for (const drift of [0, 2, 6]) {
      const raw = { ...scenario.raw, [scenario.free]: scenario.raw[scenario.free] + drift * scenario.direction };
      expected = { ...scenario.expected, [scenario.free]: raw[scenario.free] };
      at = { x: raw.x - 6 + grabOffset.x, y: raw.y - 6 + grabOffset.y };
      await pointerAcknowledged(alpha, 'mouseMove', at);
      const settled = await waitFor(() => {
        const bounds = alpha.getBounds();
        return bounds.x + 6 === expected.x && bounds.y + 6 === expected.y;
      }, 2000, 20);
      const guides = await alpha.webContents.executeJavaScript(`({ x: document.getElementById('verticalAlignmentGuide').classList.contains('show'), y: document.getElementById('horizontalAlignmentGuide').classList.contains('show') })`);
      frames.push({ settled: Boolean(settled), bounds: tileBounds(alpha), guides });
    }
    if (scenario.name === 'X below' || scenario.name === 'Y right') {
      const imagePath = join(profile, scenario.axis + '-only-alignment.png');
      writeFileSync(imagePath, (await alpha.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
      console.log('alignment-capture=' + imagePath);
    }
    const siblingWrites = positionCalls.slice(firstWrite).filter(call => call.id !== alpha.id);
    await pointerAcknowledged(alpha, 'mouseUp', at);
    const saved = await waitFor(() => {
      try {
        const position = JSON.parse(readFileSync(join(userData, 'tile-layout.json'), 'utf8')).tiles['alpha.test'];
        return position?.x === expected.x && position?.y === expected.y;
      } catch { return false; }
    }, 3000, 20);
    check('separated ' + scenario.name + ' alignment keeps the other axis free through release',
      frames.every(frame => frame.settled && frame.guides[scenario.axis] && !frame.guides[scenario.free]) &&
        siblingWrites.length === 0 && Boolean(saved),
      { frames, siblingWrites: siblingWrites.length, saved: Boolean(saved), expected });
  }
  alpha.setPosition(94, 94);
  await pause(100);

  // Instrument the renderer so the real Chromium capture can be observed.
  await alpha.webContents.executeJavaScript('window.__inputEvents=[]; for (const type of ["pointerdown","pointermove","pointerup","gotpointercapture","lostpointercapture"]) document.addEventListener(type,event=>window.__inputEvents.push({type,trusted:event.isTrusted,pointerId:event.pointerId,captured:!!event.target.hasPointerCapture?.(event.pointerId)})); void 0;');

  const alphaBounds = alpha.getBounds();
  const grab = { x: alphaBounds.x + 60, y: alphaBounds.y + 40 };

  // A1/A3: a Ctrl drag towards the neighbour really snaps and never writes a
  // sibling window.
  const beforeSingle = positionCalls.length;
  await dragTile(alpha, { from: grab, to: { x: grab.x + 306, y: grab.y }, ctrl: true, steps: 30, hold: 16 });
  const duringSnap = positionCalls.slice(beforeSingle);
  const siblingWrites = duringSnap.filter(call => {
    const win = windowById(call.id);
    return win && tileKeyOf(win) && tileKeyOf(win) !== 'alpha.test';
  });
  const alphaWrites = duringSnap.filter(call => {
    const win = windowById(call.id);
    return win && tileKeyOf(win) === 'alpha.test';
  });
  check('a single drag writes the dragged window and no sibling window',
    alphaWrites.length > 0 && siblingWrites.length === 0,
    { alphaWrites: alphaWrites.length, siblingWrites: siblingWrites.length, siblingWritesDetail: siblingWrites.slice(0, 5) });
  const bravoBefore = tileBounds(bravo);
  releaseTile(alpha, { x: grab.x + 306, y: grab.y }, true);
  await pause(200);
  check('the sibling native bounds never change during a single drag',
    tileBounds(bravo).x === bravoBefore.x && tileBounds(bravo).y === bravoBefore.y,
    { before: bravoBefore, after: tileBounds(bravo) });

  const snappedAlpha = alpha.getBounds();
  check('the dragged tile really snapped to the neighbour edge',
    Math.abs((snappedAlpha.x + 6) - 400) <= 1 && Math.abs((snappedAlpha.y + 6) - 100) <= 1,
    { alpha: { x: snappedAlpha.x, y: snappedAlpha.y }, expectedContent: { x: 400, y: 100 } });

  // A4: dragging far away detaches from the snap again.
  const detachBounds = alpha.getBounds();
  const detachGrab = { x: detachBounds.x + 60, y: detachBounds.y + 40 };
  const beforeDetach = positionCalls.length;
  await dragTile(alpha, { from: detachGrab, to: { x: detachGrab.x + 120, y: detachGrab.y }, ctrl: true, steps: 20, hold: 16 });
  releaseTile(alpha, { x: detachGrab.x + 120, y: detachGrab.y }, true);
  await pause(200);
  const detached = alpha.getBounds();
  const detachWrites = positionCalls.slice(beforeDetach).filter(call => {
    const win = windowById(call.id);
    return win && tileKeyOf(win) && tileKeyOf(win) !== 'alpha.test';
  });
  check('the tile detaches from the snap and follows the pointer again',
    Math.abs((detached.x + 6) - 520) <= 3 && detachWrites.length === 0,
    { detached: { x: detached.x, y: detached.y }, siblingWrites: detachWrites.length });

  // A2: the distant tile is never a candidate.
  const charlieBefore = tileBounds(charlie);
  const distantBounds = alpha.getBounds();
  const distantGrab = { x: distantBounds.x + 60, y: distantBounds.y + 40 };
  const beforeDistant = positionCalls.length;
  await dragTile(alpha, { from: distantGrab, to: { x: distantGrab.x + 40, y: distantGrab.y + 30 }, ctrl: true, steps: 10, hold: 16 });
  releaseTile(alpha, { x: distantGrab.x + 40, y: distantGrab.y + 30 }, true);
  await pause(200);
  const distantWrites = positionCalls.slice(beforeDistant).filter(call => {
    const win = windowById(call.id);
    return win && tileKeyOf(win) && tileKeyOf(win) !== 'alpha.test';
  });
  check('a tile that is far away on the other axis never becomes a candidate',
    distantWrites.length === 0 && tileBounds(charlie).x === charlieBefore.x && tileBounds(charlie).y === charlieBefore.y,
    { charlieBefore, charlieAfter: tileBounds(charlie), siblingWrites: distantWrites.length });

  // A5: ctrl pressed after the mouse button also selects the single drag.
  const groupBounds = alpha.getBounds();
  const groupGrab = { x: groupBounds.x + 60, y: groupBounds.y + 40 };
  const beforeCtrlAfter = positionCalls.length;
  await dragTile(alpha, { from: groupGrab, to: { x: groupGrab.x + 60, y: groupGrab.y }, ctrl: false, ctrlAfterDown: true, steps: 12, hold: 16 });
  const ctrlAfterWrites = positionCalls.slice(beforeCtrlAfter).filter(call => {
    const win = windowById(call.id);
    return win && tileKeyOf(win) && tileKeyOf(win) !== 'alpha.test';
  });
  releaseTile(alpha, { x: groupGrab.x + 60, y: groupGrab.y }, true);
  await pause(200);
  check('ctrl pressed after the mouse button still drags only the tile under the pointer',
    ctrlAfterWrites.length === 0, { siblingWrites: ctrlAfterWrites.length });

  // A plain drag moves the whole group by the same displacement.
  const plainBounds = alpha.getBounds();
  const plainGrab = { x: plainBounds.x + 60, y: plainBounds.y + 40 };
  const bravoBeforeGroup = tileBounds(bravo);
  const charlieBeforeGroup = tileBounds(charlie);
  await dragTile(alpha, { from: plainGrab, to: { x: plainGrab.x + 36, y: plainGrab.y + 24 }, ctrl: false, steps: 12, hold: 16 });
  releaseTile(alpha, { x: plainGrab.x + 36, y: plainGrab.y + 24 }, false);
  await pause(200);
  const alphaAfterGroup = tileBounds(alpha);
  const bravoAfterGroup = tileBounds(bravo);
  const charlieAfterGroup = tileBounds(charlie);
  check('a plain drag moves every visible tile by the same displacement',
    alphaAfterGroup.x - plainBounds.x === bravoAfterGroup.x - bravoBeforeGroup.x &&
    alphaAfterGroup.x - plainBounds.x === charlieAfterGroup.x - charlieBeforeGroup.x &&
    alphaAfterGroup.y - plainBounds.y === bravoAfterGroup.y - bravoBeforeGroup.y &&
    alphaAfterGroup.y - plainBounds.y === charlieAfterGroup.y - charlieBeforeGroup.y,
    { alpha: [plainBounds.x, alphaAfterGroup.x], bravo: [bravoBeforeGroup.x, bravoAfterGroup.x], charlie: [charlieBeforeGroup.x, charlieAfterGroup.x] });

  // A8: Escape cancels the gesture and restores the affected tiles.
  const cancelBounds = alpha.getBounds();
  const cancelGrab = { x: cancelBounds.x + 60, y: cancelBounds.y + 40 };
  await dragTile(alpha, { from: cancelGrab, to: { x: cancelGrab.x + 80, y: cancelGrab.y + 40 }, ctrl: true, steps: 8, hold: 16 });
  alpha.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await pause(200);
  alpha.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await pause(120);
  const afterCancel = tileBounds(alpha);
  check('Escape cancels the gesture and restores the dragged tile',
    Math.abs(afterCancel.x - cancelBounds.x) <= 1 && Math.abs(afterCancel.y - cancelBounds.y) <= 1,
    { before: cancelBounds, after: afterCancel });

  // A9: the absolute layout is persisted in the main process.
  await pause(400);
  const layoutPath = join(userData, 'tile-layout.json');
  const storedLayout = existsSync(layoutPath) ? JSON.parse(readFileSync(layoutPath, 'utf8')) : null;
  check('the layout store keeps versioned absolute tile positions',
    Boolean(storedLayout) && storedLayout.version === 2 &&
    Number.isFinite(storedLayout.tiles['alpha.test']?.x) && Number.isFinite(storedLayout.tiles['alpha.test']?.y),
    storedLayout);

  // A10: two different tiles request the same singleton settings window.
  const settingsShowBefore = showCalls.length;
  await alpha.webContents.executeJavaScript('window.netmeterDesktop.openSettings(); void 0;');
  await pause(150);
  await bravo.webContents.executeJavaScript('window.netmeterDesktop.openSettings(); void 0;');
  await pause(150);
  const settingsWindows = BrowserWindow.getAllWindows().filter(win => /view=settings/.test(win.webContents.getURL()));
  const settingsId = settingsWindows[0]?.id;
  const settingsShows = showCalls.slice(settingsShowBefore).filter(id => id === settingsId);
  check('the settings request from two tiles reaches one singleton settings window',
    settingsWindows.length === 1 && settingsShows.length === 2,
    { settingsWindows: settingsWindows.length, shows: settingsShows.length, allShows: showCalls.slice(settingsShowBefore) });
  const settingsEntries = await settings.webContents.executeJavaScript('document.querySelectorAll(".domain-entry").length');
  check('the singleton settings window shows the complete shared domain list',
    settingsEntries === 3, { entries: settingsEntries });

  const alphaBeforeVisibility = tileBounds(alpha);
  const bravoBeforeVisibility = tileBounds(bravo);
  const charlieBeforeVisibility = tileBounds(charlie);
  const retainedAlphaPosition = { x: alphaBeforeVisibility.x + 6, y: alphaBeforeVisibility.y + 6 };
  await settings.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.domain-entry')].find(item => item.querySelector('.domain-url').value === 'alpha.test');
    const checkbox = row.querySelector('.domain-visible');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('preferences').requestSubmit();
    return true;
  })()`);
  const hiddenAlphaRetired = await waitFor(() => alpha.isDestroyed() && tileWindows().length === 2 ? true : null);
  const hiddenLayoutPath = join(userData, 'tile-layout.json');
  const hiddenLayout = await waitFor(() => {
    if (!existsSync(hiddenLayoutPath)) return null;
    try {
      const value = JSON.parse(readFileSync(hiddenLayoutPath, 'utf8'));
      return value.tiles?.['alpha.test']?.x === retainedAlphaPosition.x &&
        value.tiles?.['alpha.test']?.y === retainedAlphaPosition.y ? value : null;
    } catch {
      return null;
    }
  });
  const hiddenCollectorState = await fetch('http://127.0.0.1:' + process.env.PORT + '/api/collector/state')
    .then(response => response.json()).catch(() => null);
  const hiddenTargets = (hiddenCollectorState?.metrics || []).map(item => item.target);
  check('unchecking a saved domain closes only its tile and preserves its position and collection',
    Boolean(hiddenAlphaRetired) && Boolean(hiddenLayout) &&
      tileBounds(bravo).x === bravoBeforeVisibility.x && tileBounds(bravo).y === bravoBeforeVisibility.y &&
      tileBounds(charlie).x === charlieBeforeVisibility.x && tileBounds(charlie).y === charlieBeforeVisibility.y &&
      hiddenTargets.includes('alpha.test'),
    { retired: Boolean(hiddenAlphaRetired), tiles: tileWindows().map(win => tileKeyOf(win)),
      retainedPosition: hiddenLayout?.tiles?.['alpha.test'], hiddenTargets });

  await settings.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.domain-entry')].find(item => item.querySelector('.domain-url').value === 'alpha.test');
    const checkbox = row.querySelector('.domain-visible');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('preferences').requestSubmit();
    return true;
  })()`);
  const restoredAlpha = await waitFor(() => tileWindows().find(win => tileKeyOf(win) === 'alpha.test'));
  if (restoredAlpha) alpha = restoredAlpha;
  const restoredAlphaBounds = restoredAlpha ? tileBounds(restoredAlpha) : null;
  check('re-enabling a saved domain recreates its tile at the retained position',
    Boolean(restoredAlpha) &&
      Math.abs(restoredAlphaBounds.x + 6 - retainedAlphaPosition.x) <= 1 &&
      Math.abs(restoredAlphaBounds.y + 6 - retainedAlphaPosition.y) <= 1 &&
      tileBounds(bravo).x === bravoBeforeVisibility.x && tileBounds(bravo).y === bravoBeforeVisibility.y &&
      tileBounds(charlie).x === charlieBeforeVisibility.x && tileBounds(charlie).y === charlieBeforeVisibility.y,
    { restored: restoredAlphaBounds, expectedContentPosition: retainedAlphaPosition });
  await alpha.webContents.executeJavaScript('window.__inputEvents=[]; for (const type of ["pointerdown","pointermove","pointerup","gotpointercapture","lostpointercapture"]) document.addEventListener(type,event=>window.__inputEvents.push({type,trusted:event.isTrusted,pointerId:event.pointerId,captured:!!event.target.hasPointerCapture?.(event.pointerId)})); void 0;');

  // A11: saving the settings reconciles the tiles without moving the others.
  const alphaBeforeSave = tileBounds(alpha);
  const bravoBeforeSave = tileBounds(bravo);
  await settings.webContents.executeJavaScript(`
    document.getElementById('addDomain').click();
    const rows = document.querySelectorAll('.domain-entry');
    const last = rows[rows.length - 1];
    last.querySelector('.domain-url').value = 'delta.test';
    last.querySelector('.domain-url').dispatchEvent(new Event('input', { bubbles: true }));
    last.querySelector('.domain-visible').checked = true;
    document.getElementById('preferences').requestSubmit();
    void 0;
  `);
  const reconciled = await waitFor(() => {
    const found = tileWindows();
    return found.length === 4 ? found : null;
  }, 15000);
  check('saving the settings creates the new tile window',
    Boolean(reconciled), { tiles: tileWindows().map(win => tileKeyOf(win)) });
  if (reconciled) {
    const alphaAfterSave = tileBounds(alpha);
    const bravoAfterSave = tileBounds(bravo);
    check('saving the settings keeps the established placement of the other tiles',
      alphaAfterSave.x === alphaBeforeSave.x && alphaAfterSave.y === alphaBeforeSave.y &&
      bravoAfterSave.x === bravoBeforeSave.x && bravoAfterSave.y === bravoBeforeSave.y,
      { alpha: [alphaBeforeSave.x, alphaAfterSave.x], bravo: [bravoBeforeSave.x, bravoAfterSave.x] });
  }

  // A11: one collector and one ledger serve every tile.
  const serverPort = new URL(alpha.webContents.getURL()).port;
  const collectorState = await fetch('http://127.0.0.1:' + serverPort + '/api/collector/state').then(response => response.json()).catch(() => null);
  const targets = (collectorState?.metrics || []).map(item => item.target);
  check('the shared collector reports every target exactly once',
    Array.isArray(targets) && new Set(targets).size === targets.length,
    { targets, collector: collectorState?.collector });

  // A6: the available monitor topology decides whether a seam can be crossed.
  const displays = screen.getAllDisplays();
  if (displays.length < 2) {
    skip('crossing a monitor seam', { displays: displays.length, reason: 'only one display is available' });
  } else {
    const left = displays.reduce((a, b) => (a.bounds.x <= b.bounds.x ? a : b));
    const right = displays.reduce((a, b) => (a.bounds.x >= b.bounds.x ? a : b));
    const seamBounds = alpha.getBounds();
    const seamGrab = { x: seamBounds.x + 60, y: seamBounds.y + 40 };
    const beforeSeam = positionCalls.length;
    const returned = { x: right.workArea.x + 180, y: seamGrab.y };
    const seamPath = await dragTile(alpha, {
      from: seamGrab,
      via: [{ x: left.workArea.x + 120, y: seamGrab.y }],
      to: returned,
      ctrl: true,
      steps: 30,
      hold: 16
    });
    releaseTile(alpha, returned, true);
    await pause(200);
    const seamWrites = positionCalls.slice(beforeSeam).filter(call => {
      const win = windowById(call.id);
      return win && tileKeyOf(win) && tileKeyOf(win) !== 'alpha.test';
    });
    const crossed = alpha.getBounds();
    check('one held drag crosses the monitor seam without touching a sibling',
      seamWrites.length === 0 && seamPath.minWindowX < right.bounds.x && crossed.x >= right.bounds.x,
      { displays: displays.map(display => display.bounds), crossedLeft: seamPath.minWindowX, returned: { x: crossed.x, y: crossed.y }, siblingWrites: seamWrites.length });
  }

  const inputEvents = await alpha.webContents.executeJavaScript('window.__inputEvents');
  check('the real Chromium pointer capture stayed enabled and the input was trusted',
    inputEvents.some(event => event.type === 'gotpointercapture') && inputEvents.every(event => event.trusted),
    { events: inputEvents.length, captures: inputEvents.filter(event => event.type === 'gotpointercapture').length });

  check('all production main test windows stay hidden, unfocused and non topmost',
    BrowserWindow.getAllWindows().every(win => !win.isVisible() && !win.isAlwaysOnTop()),
    BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), topmost: win.isAlwaysOnTop(), key: tileKeyOf(win) })));

  console.log(log.join('\n'));
  console.log('skipped=' + skipped);
  if (process.argv.includes('--force-failure')) check('intentional exit-code verification', false, {});
  app.once('will-quit', event => {
    if (!failed) return;
    event.preventDefault();
    app.exit(1);
  });
  // The probe never leaves a process behind, even if the graceful shutdown of
  // the production main process takes longer than expected.
  setTimeout(() => app.exit(failed ? 1 : 0), 8000);
  app.quit();
})().catch(error => { console.error(error.stack); console.log(log.join('\n')); app.exit(1); });
