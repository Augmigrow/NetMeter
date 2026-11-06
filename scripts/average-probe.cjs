// Offscreen Electron probe: verifies the windowed active-second average in a real widget window.
// Run with: node_modules/electron/dist/electron.exe scripts/average-probe.cjs
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const errors = [];
let phaseStart = Date.now();
let frozen = false;
let frozenAt = 0;

function sendJson(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + detail);
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
  if (pathname === '/__probe/reset') {
    phaseStart = Date.now();
    frozen = false;
    return sendJson(response, { ok: true });
  }
  if (pathname === '/__probe/freeze') {
    frozenAt = Date.now();
    frozen = true;
    return sendJson(response, { ok: true });
  }
  if (pathname === '/api/connections') {
    // Download grows by exactly 100 bytes/second; upload never moves.
    const at = frozen ? frozenAt : Date.now();
    const down = Math.max(0, 100 * (at - phaseStart) / 1000);
    return sendJson(response, { connections: [{ id: 'probe', metadata: { host: 'example.com' }, download: down, upload: 0 }] });
  }
  response.writeHead(404);
  response.end('not found');
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 760,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  async function load(urlPath) {
    await win.loadURL(base + urlPath);
    await sleep(350);
  }

  await load('/?view=settings');
  const defaults = await win.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('avgWindow');
    return { value: select.value, options: [...select.options].map(option => option.value) };
  })()`);
  check('设置页均速窗口默认 5 分钟且提供 2/5/10 三档',
    defaults.value === '5分钟' && defaults.options.join(',') === '2分钟,5分钟,10分钟',
    JSON.stringify(defaults));

  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('controllerEnabled').checked = true;
    document.getElementById('controllerAddress').value = '127.0.0.1:9097';
    document.getElementById('domains').value = 'example.com';
    const select = document.getElementById('avgWindow');
    select.value = '2分钟';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('preferences').requestSubmit();
  })()`);
  await sleep(700);
  const stored = await win.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('netmeter-controller-v2') || '{}')`);
  check('保存后 avgWindow 写入本地设置', stored.avgWindow === '2分钟', JSON.stringify({ avgWindow: stored.avgWindow, domains: stored.domains }));

  await load('/?view=settings');
  const restored = await win.webContents.executeJavaScript(`document.getElementById('avgWindow').value`);
  check('重新载入设置页恢复已选窗口', restored === '2分钟', String(restored));

  await fetch(base + '/__probe/reset');
  await load('/?view=widget');
  const widgetWindow = await win.webContents.executeJavaScript(`document.getElementById('avgWindow').value`);
  check('悬浮窗读取到 2 分钟统计窗口', widgetWindow === '2分钟', String(widgetWindow));

  await sleep(4500);
  const readTile = `(() => {
    const meter = document.querySelector('.meter');
    if (!meter) return null;
    return {
      averageDown: meter.querySelector('.average-down').textContent,
      averageUp: meter.querySelector('.average-up').textContent,
      liveDown: meter.querySelector('.speed.down').textContent
    };
  })()`;
  const active = await win.webContents.executeJavaScript(readTile);
  const activeDown = Number.parseFloat(active ? active.averageDown : '');
  check('只有下载有流量时，下载均速约 100B/s、上传均速显示「—」',
    Boolean(active) && activeDown > 60 && activeDown < 160 && active.averageUp === '—',
    JSON.stringify(active));

  await fetch(base + '/__probe/freeze');
  await sleep(4500);
  const idle = await win.webContents.executeJavaScript(readTile);
  const idleDown = Number.parseFloat(idle ? idle.averageDown : '');
  check('停止流量后均速不被空闲秒摊薄', idleDown > 60 && idleDown < 160, JSON.stringify(idle));

  await win.webContents.executeJavaScript(`document.querySelector('.mode-toggle').click()`);
  const peak = await win.webContents.executeJavaScript(readTile);
  const peakDown = Number.parseFloat(peak ? peak.averageDown : '');
  check('切换到峰值时显示窗口内最高单次速度，上传方向仍为「—」',
    peakDown > 60 && peakDown < 200 && peak.averageUp === '—',
    JSON.stringify(peak));

  // Jump the renderer clock past the selected 2-minute window: both the average
  // and the peak must drop to "—" once their samples slide out of the window.
  await win.webContents.executeJavaScript(`(() => {
    const realNow = Date.now;
    window.__probeRestoreClock = () => { Date.now = realNow; };
    Date.now = () => realNow() + 180000;
  })()`);
  await sleep(1600);
  const expiredPeak = await win.webContents.executeJavaScript(readTile);
  check('样本滑出窗口后峰值回落为「—」', expiredPeak.averageDown === '—' && expiredPeak.averageUp === '—', JSON.stringify(expiredPeak));
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.mode-toggle').click(); })()`);
  const expiredAverage = await win.webContents.executeJavaScript(readTile);
  check('同一窗口过期后均速也为「—」', expiredAverage.averageDown === '—' && expiredAverage.averageUp === '—', JSON.stringify(expiredAverage));
  await win.webContents.executeJavaScript(`window.__probeRestoreClock()`);

  check('运行期间无脚本报错', errors.length === 0, errors.join(' | ') || '无');

  const passed = results.every(result => result.ok);
  console.log(passed ? 'PROBE PASS ' + results.length + '/' + results.length : 'PROBE FAIL ' + results.filter(result => result.ok).length + '/' + results.length);
  win.destroy();
  server.close();
  app.quit();
  process.exit(passed ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
