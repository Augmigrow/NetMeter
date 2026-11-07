// Offscreen Electron probe: verifies that the Chinese and English interfaces
// both render, that switching the language repaints the tiles and the history
// panel, and that the widget window follows a language switch.
// Run with: node_modules/electron/dist/electron.exe scripts/i18n-probe.cjs
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile, writeFile } = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const errors = [];
const log = [];
const logPath = path.join(root, 'scripts', 'i18n-probe.log');

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
    return sendJson(response, { connections: [{ id: 'probe', metadata: { host: 'example.com' }, download: 1000 * (at / 1000), upload: 0 }] });
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

async function seedSettings(win, base) {
  await win.loadURL(base + '/?view=widget');
  await sleep(300);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem('netmeter-controller-v2', JSON.stringify({
      controllerEnabled: true,
      controllerAddress: '127.0.0.1:9097',
      domains: ['example.com'],
      history: '7天',
      avgWindow: '5分钟',
      lightTheme: false
    }));
    return true;
  })()`);
}

async function seedHistory(win) {
  await win.webContents.executeJavaScript(`(async () => {
    const db = await new Promise(resolve => {
      const request = indexedDB.open('netmeter-history-v1', 1);
      request.onsuccess = () => resolve(request.result);
    });
    const store = db.transaction('samples', 'readwrite').objectStore('samples');
    const minute = 60000;
    const now = Date.now();
    for (let index = 1439; index >= 0; index -= 1) {
      const at = Math.floor((now - index * minute) / minute) * minute;
      const wave = Math.sin(index / 90) * 0.5 + 0.5;
      store.put({
        id: 'example.com|' + at,
        target: 'example.com',
        at,
        down: Math.round(400000 + wave * 900000),
        up: Math.round(120000 + wave * 260000),
        downSeconds: 60,
        upSeconds: 60
      });
    }
    await new Promise(resolve => {
      const tx = db.transaction('samples', 'readwrite');
      tx.oncomplete = resolve;
    });
    db.close();
    return true;
  })()`);
}

function readTile(win) {
  return win.webContents.executeJavaScript(`(() => {
    const meter = document.querySelector('.meter');
    if (!meter) return null;
    return {
      labels: [...meter.querySelectorAll('.rate-label')].map(node => node.textContent.trim()),
      statName: meter.querySelector('.stat-name').textContent.trim(),
      mode: meter.querySelector('.mode-toggle').textContent.trim(),
      modeTitle: meter.querySelector('.mode-toggle').title,
      settingsLabel: meter.querySelector('.settings-button').getAttribute('aria-label'),
      hostTitle: meter.querySelector('.host-button').title,
      lang: document.documentElement.lang
    };
  })()`);
}

function readStatLayout(win) {
  return win.webContents.executeJavaScript(`(() => {
    const meter = document.querySelector('.meter');
    if (!meter) return null;
    const rows = [...meter.querySelectorAll('.stat')];
    const measure = row => {
      const label = row.querySelector('.stat-name, .mode-toggle');
      const firstValue = row.querySelector('.stat-value');
      if (!label || !firstValue) return null;
      const labelBox = label.getBoundingClientRect();
      const valueBox = firstValue.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      const textBox = range.getBoundingClientRect();
      return {
        label: label.textContent.trim(),
        labelWidth: Math.round(labelBox.width),
        textWidth: label.scrollWidth,
        textRight: Math.round(textBox.right),
        valueLeft: Math.round(valueBox.left),
        labelRight: Math.round(labelBox.right),
        overflow: Math.round(labelBox.right - valueBox.left),
        gap: Math.round(valueBox.left - textBox.right)
      };
    };
    return { total: measure(rows[1]), average: measure(rows[0]) };
  })()`);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setContentSize(380, 306);
  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  await seedSettings(win, base);
  await win.loadURL(base + '/?view=widget');
  await sleep(500);

  const zhTile = await readTile(win);
  check('the tile renders chinese labels by default', zhTile && zhTile.labels.join('/') === '下载/上传' && zhTile.statName === '累计' && zhTile.mode === '均速', JSON.stringify(zhTile));
  check('the document language defaults to chinese', zhTile && zhTile.lang === 'zh-CN', String(zhTile && zhTile.lang));
  const zhLayout = await readStatLayout(win);
  check('the chinese stat labels stay inside their column', zhLayout && zhLayout.total.overflow <= 0 && zhLayout.average.overflow <= 0, JSON.stringify(zhLayout));
  check('the chinese stat labels keep a gap before the arrow', zhLayout && zhLayout.total.gap >= 3 && zhLayout.average.gap >= 3, JSON.stringify(zhLayout));

  // Switch to English the way the settings page does it.
  await win.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('language');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);

  const enTile = await readTile(win);
  check('the tile repaints in english', enTile && enTile.labels.join('/') === 'Down/Up' && enTile.statName === 'Total' && enTile.mode === 'Avg', JSON.stringify(enTile));
  check('the document language switches to english', enTile && enTile.lang === 'en', String(enTile && enTile.lang));
  check('the english titles are localised', enTile && enTile.modeTitle === 'Switch to peak' && enTile.settingsLabel === 'Open settings' && enTile.hostTitle === 'View traffic history', JSON.stringify(enTile));
  const enLayout = await readStatLayout(win);
  check('the english stat labels stay inside their column', enLayout && enLayout.total.overflow <= 0 && enLayout.average.overflow <= 0, JSON.stringify(enLayout));
  check('the english stat labels keep a gap before the arrow', enLayout && enLayout.total.gap >= 3 && enLayout.average.gap >= 3, JSON.stringify(enLayout));

  const stored = await win.webContents.executeJavaScript(`localStorage.getItem('netmeter-language')`);
  check('the language choice is stored', stored === 'en', String(stored));

  // Open the history panel and check both tabs in english.
  await win.webContents.executeJavaScript(`document.querySelector('.host-button').click()`);
  await sleep(700);

  const enHistory = await win.webContents.executeJavaScript(`(() => ({
    kicker: document.querySelector('.history-kicker').textContent.trim(),
    range: document.querySelector('#historyRange option:checked').textContent.trim(),
    tabs: [...document.querySelectorAll('.history-tab')].map(button => button.textContent.trim()),
    summary: [...document.querySelectorAll('.history-item small')].map(node => node.textContent.trim()),
    title: document.getElementById('dialogTitle').textContent.trim()
  }))()`);
  check('the history panel is localised', enHistory.range === 'Last 24 hours' && enHistory.kicker.includes(' — ') && enHistory.tabs.join('/') === 'Traffic/Average speed', JSON.stringify(enHistory));
  check('the history summary columns are localised', enHistory.summary.join('/') === 'Down total/Up total/Down average/Up average', JSON.stringify(enHistory.summary));
  check('the history title still shows the domain only', enHistory.title === 'example.com', String(enHistory.title));

  await win.webContents.executeJavaScript(`document.getElementById('historyTabSpeed').click()`);
  await sleep(400);
  const enCurve = await win.webContents.executeJavaScript(`(() => {
    const svg = document.querySelector('#historySpeedChart svg');
    return {
      label: svg ? svg.getAttribute('aria-label') : '',
      paths: document.querySelectorAll('#historySpeedChart .history-speed-line').length,
      peakText: document.getElementById('historySpeedChart').textContent.includes('peak')
    };
  })()`);
  check('the average speed curve is labelled in english', enCurve.label === 'Historical average speed curve' && enCurve.paths === 2, JSON.stringify(enCurve));
  check('the curve never reports a peak instead of the average', enCurve.peakText === false, JSON.stringify(enCurve));

  const enTip = await win.webContents.executeJavaScript(`(() => {
    const svg = document.querySelector('#historySpeedChart svg');
    const box = svg.getBoundingClientRect();
    svg.dispatchEvent(new MouseEvent('mousemove', { clientX: document.getElementById('historyScroll').getBoundingClientRect().left + 180, clientY: box.top + box.height * 0.5, bubbles: true }));
    const tip = document.querySelector('#historyPanel .history-speed-tip');
    return { hidden: tip ? tip.hidden : true, text: tip ? tip.textContent.trim() : '' };
  })()`);
  check('the curve hover reads the average speed', enTip.hidden === false && enTip.text.includes('Down avg') && enTip.text.includes('Up avg') && !enTip.text.includes('peak'), JSON.stringify(enTip));

  // Switch back to chinese and confirm the panel follows.
  await win.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('language');
    select.value = 'zh';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const zhAgain = await win.webContents.executeJavaScript(`(() => ({
    kicker: document.querySelector('.history-kicker').textContent.trim(),
    range: document.querySelector('#historyRange option:checked').textContent.trim(),
    tabs: [...document.querySelectorAll('.history-tab')].map(button => button.textContent.trim()),
    summary: [...document.querySelectorAll('.history-item small')].map(node => node.textContent.trim()),
    labels: [...document.querySelectorAll('.meter .rate-label')].map(node => node.textContent.trim())
  }))()`);
  check('switching back restores chinese everywhere', zhAgain.range === '最近 24 小时' && zhAgain.kicker.includes(' — ') && zhAgain.tabs.join('/') === '历史流量/历史均速' && zhAgain.summary.join('/') === '下载累计/上传累计/下载均速/上传均速' && zhAgain.labels.join('/') === '下载/上传', JSON.stringify(zhAgain));

  // A second window (the settings window) must follow the language change.
  const settings = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  settings.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await settings.loadURL(base + '/?view=settings');
  await sleep(400);
  await win.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('language');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const otherWindow = await settings.webContents.executeJavaScript(`(() => ({
    heading: document.querySelector('.settings h2').textContent.trim(),
    lang: document.documentElement.lang,
    save: document.querySelector('.button.primary').textContent.trim(),
    optionText: [...document.querySelectorAll('#avgWindow option')].map(option => option.textContent.trim()),
    windowLabel: document.querySelector('#avgWindow').previousElementSibling.textContent.trim(),
    status: document.getElementById('controllerStatus').textContent.trim(),
    secretPlaceholder: document.getElementById('controllerSecret').placeholder,
    secretNote: document.getElementById('secretStorageNote').textContent.trim(),
    addressToggle: document.getElementById('toggleAddressVisibility').title,
    secretToggle: document.getElementById('toggleSecretVisibility').title
  }))()`);
  const titles = await settings.webContents.executeJavaScript('document.title');
  check('the settings window title is localised', titles === 'NetMeter Settings', String(titles));
  check('another window follows the language change', otherWindow.lang === 'en' && otherWindow.heading === 'External controller' && otherWindow.save === 'Save', JSON.stringify(otherWindow));
  check('the select option labels are translated but keep their stored values', otherWindow.optionText.join('/') === 'Last 2 minutes/Last 5 minutes/Last 10 minutes', JSON.stringify(otherWindow.optionText));
  check('the settings status keeps its own initial wording', otherWindow.status === 'Waiting for configuration', JSON.stringify(otherWindow.status));
  check('the secret placeholder and note follow the language', otherWindow.secretPlaceholder === 'Saved securely, leave empty to keep' && otherWindow.secretNote.startsWith('The key is encrypted'), JSON.stringify(otherWindow));
  check('the visibility buttons keep a readable english title', otherWindow.addressToggle === 'Hide listen address' && otherWindow.secretToggle === 'Show access key', JSON.stringify(otherWindow));

  // The settings page must still be able to show the chinese interface.
  await settings.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('language');
    select.value = 'zh';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const zhSettings = await settings.webContents.executeJavaScript(`(() => ({
    heading: document.querySelector('.settings h2').textContent.trim(),
    lang: document.documentElement.lang,
    optionText: [...document.querySelectorAll('#avgWindow option')].map(option => option.textContent.trim()),
    status: document.getElementById('controllerStatus').textContent.trim(),
    secretPlaceholder: document.getElementById('controllerSecret').placeholder,
    secretNote: document.getElementById('secretStorageNote').textContent.trim(),
    addressToggle: document.getElementById('toggleAddressVisibility').title,
    secretToggle: document.getElementById('toggleSecretVisibility').title
  }))()`);
  check('the settings page switches back to chinese', zhSettings.heading === '外部控制器' && zhSettings.lang === 'zh-CN' && zhSettings.optionText.join('/') === '最近 2 分钟/最近 5 分钟/最近 10 分钟', JSON.stringify(zhSettings));
  check('the chinese secret wording returns', zhSettings.status === '等待保存配置' && zhSettings.secretPlaceholder === '已安全保存，留空继续使用' && zhSettings.secretNote.startsWith('密钥已使用'), JSON.stringify(zhSettings));
  check('the visibility buttons return to chinese', zhSettings.addressToggle === '隐藏监听地址' && zhSettings.secretToggle === '显示访问密钥', JSON.stringify(zhSettings));

  check('no renderer script errors', errors.length === 0, errors.join(' | ') || 'none');

  const failed = results.filter(item => !item.ok);
  log.push('');
  log.push((results.length - failed.length) + '/' + results.length + ' checks passed');
  await writeFile(logPath, log.join('\n'), 'utf8');
  server.close();
  app.exit(failed.length ? 1 : 0);
})();
