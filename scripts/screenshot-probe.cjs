// Offscreen Electron probe: renders the Chinese and English interfaces with
// seeded data and writes the README screenshots into docs/screenshots.
// Run with: node_modules/electron/dist/electron.exe scripts/screenshot-probe.cjs
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shotsDir = path.join(root, 'docs', 'screenshots');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const errors = [];
const log = [];
const logPath = path.join(root, 'scripts', 'screenshot-probe.log');

function flushLog() {
  try { writeFileSync(logPath, log.join('\n'), 'utf8'); } catch { /* ignore */ }
}

function sendJson(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function check(name, ok, detail) {
  results.push({ name, ok });
  const line = (ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail;
  log.push(line);
  console.log(line);
  flushLog();
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/' || pathname === '/index.html') {
    const html = await readFile(path.join(root, 'index.html'));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    response.end(html);
    return;
  }
  if (pathname === '/api/status') return sendJson(response, { enabled: true, configured: true, address: '127.0.0.1:9097' });
  if (pathname === '/api/config') return sendJson(response, { ok: true, persisted: true });
  if (pathname === '/api/connections') {
    const at = Date.now();
    return sendJson(response, {
      connections: [
        { id: 'a', metadata: { host: 'github.com' }, download: 1000 * (at / 1000), upload: 0 },
        { id: 'b', metadata: { host: 'cdn.jsdelivr.net' }, download: 1000 * (at / 1000) * 0.35, upload: 1000 * (at / 1000) * 0.08 }
      ]
    });
  }
  response.writeHead(404);
  response.end('not found');
});

process.on('uncaughtException', error => {
  log.push('UNCAUGHT ' + (error && error.stack ? error.stack : String(error)));
  flushLog();
  app.exit(1);
});
process.on('unhandledRejection', reason => {
  log.push('UNHANDLED ' + (reason && reason.stack ? reason.stack : String(reason)));
  flushLog();
  app.exit(1);
});

const SEED_SETTINGS = `(() => {
  localStorage.setItem('netmeter-controller-v2', JSON.stringify({
    controllerEnabled: true,
    controllerAddress: '127.0.0.1:9097',
    proxyApp: 'Clash Verge',
    domains: ['github.com', 'cdn.jsdelivr.net'],
    history: '7天',
    avgWindow: '5分钟',
    lightTheme: false,
    historyTotals: {
      'github.com': { down: 1284639021, up: 38647210 },
      'cdn.jsdelivr.net': { down: 642118340, up: 12830412 }
    },
    meterPositions: { 'github.com': { x: 8, y: 8 }, 'cdn.jsdelivr.net': { x: 198, y: 8 } }
  }));
  return true;
})()`;

const SEED_HISTORY = `(async () => {
  const db = await new Promise(resolve => {
    const request = indexedDB.open('netmeter-history-v1', 1);
    request.onsuccess = () => resolve(request.result);
  });
  const store = db.transaction('samples', 'readwrite').objectStore('samples');
  const minute = 60000;
  const now = Date.now();
  for (const target of ['github.com', 'cdn.jsdelivr.net']) {
    for (let index = 1439; index >= 0; index -= 1) {
      const at = Math.floor((now - index * minute) / minute) * minute;
      const wave = Math.sin(index / 110) * 0.5 + 0.5;
      const scale = target === 'github.com' ? 1 : 0.42;
      store.put({
        id: target + '|' + at,
        target,
        at,
        down: Math.round((320000 + wave * 1250000) * scale),
        up: Math.round((90000 + wave * 260000) * scale),
        downSeconds: 60,
        upSeconds: 60
      });
    }
  }
  await new Promise(resolve => {
    const tx = db.transaction('samples', 'readwrite');
    tx.oncomplete = resolve;
  });
  db.close();
  return true;
})()`;

async function setLanguage(win, language) {
  await win.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('language');
    select.value = ${JSON.stringify(language)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
}

async function capture(win, name) {
  const image = await win.webContents.capturePage();
  const target = path.join(shotsDir, name);
  await writeFile(target, image.toPNG());
  return target;
}

// The widget window is sized by the main process: the canvas follows the tiles,
// and the history panel is a fixed 380x306.
const TILE_CANVAS = { width: 384, height: 162 };
const HISTORY_SIZE = { width: 380, height: 306 };

(async () => {
  await mkdir(shotsDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  await app.whenReady();

  // --- The floating tiles in both languages ---------------------------------
  const widget = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  widget.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await widget.loadURL(base + '/?view=widget');
  await sleep(300);
  await widget.webContents.executeJavaScript(SEED_SETTINGS);
  await widget.loadURL(base + '/?view=widget');
  await sleep(900);
  await widget.webContents.executeJavaScript(SEED_HISTORY);

  for (const [language, suffix] of [['zh', 'zh'], ['en', 'en']]) {
    await setLanguage(widget, language);
    await sleep(500);
    widget.setContentSize(TILE_CANVAS.width, TILE_CANVAS.height);
    await sleep(300);
    const target = await capture(widget, 'tiles-' + suffix + '.png');
    check('captured the ' + language + ' tiles', Boolean(target), target);
  }

  // --- The history panel in both languages ----------------------------------
  await setLanguage(widget, 'zh');
  await widget.webContents.executeJavaScript(`document.querySelector('.host-button').click()`);
  await sleep(900);
  widget.setContentSize(HISTORY_SIZE.width, HISTORY_SIZE.height);
  await sleep(400);
  for (const [language, suffix] of [['zh', 'zh'], ['en', 'en']]) {
    await setLanguage(widget, language);
    await sleep(400);
    widget.setContentSize(HISTORY_SIZE.width, HISTORY_SIZE.height);
    await sleep(300);
    await widget.webContents.executeJavaScript(`document.getElementById('historyTabTraffic').click()`);
    await sleep(500);
    let target = await capture(widget, 'history-traffic-' + suffix + '.png');
    check('captured the ' + language + ' traffic chart', Boolean(target), target);
    await widget.webContents.executeJavaScript(`document.getElementById('historyTabSpeed').click()`);
    await sleep(500);
    // Hover the curve so the screenshot shows the average speed readout of the
    // hovered minute instead of a peak value.
    await widget.webContents.executeJavaScript(`(() => {
      const svg = document.querySelector('#historySpeedChart svg');
      const box = svg.getBoundingClientRect();
      svg.dispatchEvent(new MouseEvent('mousemove', { clientX: box.left + box.width * 0.62, clientY: box.top + box.height * 0.45, bubbles: true }));
      const tip = document.querySelector('#historySpeedChart .history-speed-tip');
      return tip ? tip.textContent.trim() : '';
    })()`);
    await sleep(400);
    target = await capture(widget, 'history-speed-' + suffix + '.png');
    check('captured the ' + language + ' average speed curve', Boolean(target), target);
  }

  const hover = await widget.webContents.executeJavaScript(`(() => {
    const tip = document.querySelector('#historySpeedChart .history-speed-tip');
    return { visible: Boolean(tip) && tip.hidden === false, text: tip ? tip.textContent.trim() : '', down: tip ? tip.dataset.down : '' };
  })()`);
  check('the captured curve shows the hovered average speed', hover.visible === true && hover.down !== '' && !/peak|峰值/i.test(hover.text), JSON.stringify(hover));

  const curve = await widget.webContents.executeJavaScript(`(() => {
    const chart = document.getElementById('historySpeedChart');
    const svg = chart.querySelector('svg');
    const box = svg ? svg.getBoundingClientRect() : null;
    return {
      paths: chart.querySelectorAll('.history-speed-line').length,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0
    };
  })()`);
  check('the captured curve is drawn', curve.paths === 2 && curve.width > 200 && curve.height > 80, JSON.stringify(curve));

  // --- The settings page in both languages ----------------------------------
  const settings = new BrowserWindow({
    show: false,
    width: 560,
    height: 740,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settings.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await settings.loadURL(base + '/?view=settings');
  await sleep(300);
  await settings.webContents.executeJavaScript(SEED_SETTINGS);
  await settings.loadURL(base + '/?view=settings');
  await sleep(700);
  for (const [language, suffix] of [['zh', 'zh'], ['en', 'en']]) {
    await setLanguage(settings, language);
    await sleep(400);
    // The real settings window is 560x740 and scrolls; the documentation
    // screenshot is taller so the whole form, including the language picker,
    // is visible in one image.
    const height = await settings.webContents.executeJavaScript('document.documentElement.scrollHeight');
    settings.setContentSize(560, Math.min(1400, Math.max(740, height + 8)));
    await sleep(400);
    const target = await capture(settings, 'settings-' + suffix + '.png');
    check('captured the ' + language + ' settings page', Boolean(target), target);
  }

  check('no renderer script errors', errors.length === 0, errors.join(' | ') || 'none');

  const failed = results.filter(item => !item.ok);
  log.push('');
  log.push((results.length - failed.length) + '/' + results.length + ' checks passed');
  await writeFile(logPath, log.join('\n'), 'utf8');
  server.close();
  app.exit(failed.length ? 1 : 0);
})();
