// Offscreen Electron probe: verifies the history speed curve renders as a real
// curve inside the widget window, with both tabs switching correctly.
// Run with: node_modules/electron/dist/electron.exe scripts/history-curve-probe.cjs
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
const logPath = path.join(root, 'scripts', 'history-curve-probe.log');

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

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // Match the real history window exactly: 380x306 content area.
  win.setContentSize(380, 306);
  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  // Load once so the page has a real origin, then seed settings and reload.
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

  await win.loadURL(base + '/?view=widget');
  await sleep(400);

  // Seed the history database with minute-level samples so the curve has data.
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

  // Open the history panel for the seeded domain.
  await win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.host-button');
    if (!host) return false;
    host.click();
    return true;
  })()`);
  await sleep(700);

  const traffic = await win.webContents.executeJavaScript(`(() => {
    const chart = document.getElementById('historyChart');
    return {
      hidden: chart.hidden,
      bars: chart.querySelectorAll('.history-hour').length,
      title: document.getElementById('dialogTitle').textContent,
      tabs: [...document.querySelectorAll('.history-tab')].map(button => ({ tab: button.dataset.tab, selected: button.getAttribute('aria-selected') }))
    };
  })()`);
  check('history traffic tab shows 24 hourly bars', !traffic.hidden && traffic.bars === 24, JSON.stringify(traffic));
  check('title shows the domain only', traffic.title === 'example.com', String(traffic.title));
  check('both tabs are present with traffic selected', traffic.tabs.length === 2 && traffic.tabs[0].selected === 'true' && traffic.tabs[1].selected === 'false', JSON.stringify(traffic.tabs));

  // Switch to the speed tab.
  await win.webContents.executeJavaScript(`document.getElementById('historyTabSpeed').click()`);
  await sleep(400);

  const speed = await win.webContents.executeJavaScript(`(() => {
    const chart = document.getElementById('historySpeedChart');
    const svg = chart.querySelector('svg');
    const down = chart.querySelector('.history-speed-line.down');
    const up = chart.querySelector('.history-speed-line.up');
    const box = svg ? svg.getBoundingClientRect() : null;
    return {
      hidden: chart.hidden,
      trafficHidden: document.getElementById('historyChart').hidden,
      hasSvg: Boolean(svg),
      downPath: down ? down.getAttribute('d') : '',
      upPath: up ? up.getAttribute('d') : '',
      commands: down ? (down.getAttribute('d').match(/[ML]/g) || []).length : 0,
      width: box ? box.width : 0,
      height: box ? box.height : 0,
      selected: document.getElementById('historyTabSpeed').getAttribute('aria-selected')
    };
  })()`);
  check('speed tab shows the curve and hides the bars', !speed.hidden && speed.trafficHidden && speed.hasSvg, JSON.stringify({ hidden: speed.hidden, trafficHidden: speed.trafficHidden, hasSvg: speed.hasSvg }));
  check('speed tab is marked selected', speed.selected === 'true', String(speed.selected));
  check('both series are drawn as paths', speed.downPath.includes('M') && speed.upPath.includes('M'), JSON.stringify({ down: speed.downPath.slice(0, 40), up: speed.upPath.slice(0, 40) }));
  check('the curve is drawn with many points', speed.commands > 100, 'commands=' + speed.commands);
  check('the curve fills the chart area', speed.width > 200 && speed.height > 80, JSON.stringify({ width: speed.width, height: speed.height }));

  const noNaN = !speed.downPath.includes('NaN') && !speed.upPath.includes('NaN');
  check('the curve contains no NaN coordinates', noNaN, 'down=' + speed.downPath.slice(0, 60));

  // Hovering the curve must report the average speed of that minute, never the
  // peak of the surrounding hour.
  const hover = await win.webContents.executeJavaScript(`(async () => {
    const svg = document.querySelector('#historySpeedChart svg');
    const box = svg.getBoundingClientRect();
    const read = ratio => {
      svg.dispatchEvent(new MouseEvent('mousemove', { clientX: box.left + box.width * ratio, clientY: box.top + box.height * 0.5, bubbles: true }));
      const tip = document.querySelector('#historySpeedChart .history-speed-tip');
      return { hidden: tip.hidden, text: tip.textContent.trim(), at: tip.dataset.at, down: tip.dataset.down, up: tip.dataset.up };
    };
    const db = await new Promise(resolve => { const request = indexedDB.open('netmeter-history-v1', 1); request.onsuccess = () => resolve(request.result); });
    const samples = await new Promise(resolve => {
      const out = [];
      const request = db.transaction('samples', 'readonly').objectStore('samples').openCursor();
      request.onsuccess = () => { const cursor = request.result; if (cursor) { out.push(cursor.value); cursor.continue(); } else resolve(out); };
    });
    db.close();
    const minute = 60000;
    const spanMinutes = 5;
    const expected = at => {
      const slice = samples.filter(sample => sample.at <= at && sample.at > at - spanMinutes * minute);
      const bytes = slice.reduce((sum, sample) => sum + sample.down, 0);
      const seconds = slice.reduce((sum, sample) => sum + (sample.downSeconds || 60), 0);
      return seconds > 0 ? bytes / seconds : null;
    };
    const peakAround = at => {
      const slice = samples.filter(sample => sample.at <= at && sample.at > at - 60 * minute);
      return slice.reduce((max, sample) => Math.max(max, sample.down / Math.max(1, sample.downSeconds || 60)), 0);
    };
    const first = read(0.25);
    const second = read(0.75);
    return {
      first, second,
      expectedFirst: expected(Number(first.at)),
      peakFirst: peakAround(Number(first.at)),
      expectedSecond: expected(Number(second.at)),
      peakSecond: peakAround(Number(second.at)),
      samples: samples.length
    };
  })()`);
  check('the hover readout is visible and shows the average speed', hover.first.hidden === false && hover.second.hidden === false && hover.first.down !== '' && hover.second.down !== '', JSON.stringify({ first: hover.first, second: hover.second }));
  const matchesAverage = Math.abs(Number(hover.first.down) - hover.expectedFirst) < 1 && Math.abs(Number(hover.second.down) - hover.expectedSecond) < 1;
  check('the hover readout equals the average speed of that minute', matchesAverage, JSON.stringify({ shown: hover.first.down, expected: hover.expectedFirst, shown2: hover.second.down, expected2: hover.expectedSecond }));
  const differsFromPeak = Math.abs(Number(hover.first.down) - hover.peakFirst) > 1 || Math.abs(Number(hover.second.down) - hover.peakSecond) > 1;
  check('the hover readout is not a peak value', differsFromPeak, JSON.stringify({ shown: hover.first.down, peak: hover.peakFirst, shown2: hover.second.down, peak2: hover.peakSecond }));
  check('the hover readout is not static across the curve', hover.first.down !== hover.second.down, JSON.stringify({ first: hover.first.down, second: hover.second.down }));

  // The history window is a fixed 380x306; the added tab row must not push the
  // chart out of view or leave the panel overflowing.
  const layout = await win.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('historyPanel');
    const chart = document.getElementById('historySpeedChart');
    const tabs = document.querySelector('.history-tabs');
    const svg = chart.querySelector('svg');
    const panelBox = panel.getBoundingClientRect();
    const chartBox = chart.getBoundingClientRect();
    const svgBox = svg ? svg.getBoundingClientRect() : null;
    const tabsBox = tabs.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      panelHeight: panelBox.height,
      panelScrollHeight: panel.scrollHeight,
      chartBottom: chartBox.bottom,
      svgHeight: svgBox ? svgBox.height : 0,
      svgBottom: svgBox ? svgBox.bottom : 0,
      tabsTop: tabsBox.top,
      tabsHeight: tabsBox.height
    };
  })()`);
  check('the history panel does not overflow the fixed window', layout.panelScrollHeight <= layout.panelHeight + 1, JSON.stringify(layout));
  check('the curve stays inside the visible window', layout.svgBottom <= layout.viewportHeight + 1 && layout.svgHeight > 80, JSON.stringify(layout));
  check('the tab row sits below the summary', layout.tabsTop > 60, JSON.stringify({ tabsTop: layout.tabsTop }));

  const image = await win.webContents.capturePage();
  await require('node:fs/promises').writeFile(path.join(root, 'scripts', 'history-curve-probe.png'), image.toPNG());

  // Capture the traffic tab as well so both views can be inspected visually.
  await win.webContents.executeJavaScript(`document.getElementById('historyTabTraffic').click()`);
  await sleep(400);
  const trafficImage = await win.webContents.capturePage();
  await require('node:fs/promises').writeFile(path.join(root, 'scripts', 'history-traffic-probe.png'), trafficImage.toPNG());
  const trafficAfter = await win.webContents.executeJavaScript(`(() => ({
    barsVisible: !document.getElementById('historyChart').hidden,
    speedHidden: document.getElementById('historySpeedChart').hidden,
    bars: document.querySelectorAll('#historyChart .history-hour').length
  }))()`);
  check('switching back restores the traffic bars', trafficAfter.barsVisible && trafficAfter.speedHidden && trafficAfter.bars === 24, JSON.stringify(trafficAfter));

  const readTab = () => win.webContents.executeJavaScript(`(() => ({
    selected: document.querySelector('.history-tab[aria-selected="true"]')?.dataset.tab,
    trafficHidden: document.getElementById('historyChart').hidden,
    speedHidden: document.getElementById('historySpeedChart').hidden,
    stored: localStorage.getItem('netmeter-history-tab')
  }))()`);
  const trafficChoice = await readTab();
  check('choosing traffic remembers traffic', trafficChoice.selected === 'traffic' && trafficChoice.stored === 'traffic', JSON.stringify(trafficChoice));

  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('historyTabSpeed').click();
    document.getElementById('closeDialog').click();
    document.querySelector('.host-button').click();
  })()`);
  await sleep(400);
  const reopenedSpeed = await readTab();
  check('reopening history restores the speed tab', reopenedSpeed.selected === 'speed' && reopenedSpeed.trafficHidden && !reopenedSpeed.speedHidden && reopenedSpeed.stored === 'speed', JSON.stringify(reopenedSpeed));

  await win.loadURL(base + '/?view=widget');
  await sleep(500);
  await win.webContents.executeJavaScript(`document.querySelector('.host-button').click()`);
  await sleep(500);
  const restartedSpeed = await readTab();
  check('the speed tab survives a widget reload', restartedSpeed.selected === 'speed' && restartedSpeed.trafficHidden && !restartedSpeed.speedHidden, JSON.stringify(restartedSpeed));

  await win.webContents.executeJavaScript(`document.getElementById('historyTabTraffic').click()`);
  await win.loadURL(base + '/?view=widget');
  await sleep(500);
  await win.webContents.executeJavaScript(`document.querySelector('.host-button').click()`);
  await sleep(500);
  const restartedTraffic = await readTab();
  check('choosing traffic survives a widget reload', restartedTraffic.selected === 'traffic' && !restartedTraffic.trafficHidden && restartedTraffic.speedHidden && restartedTraffic.stored === 'traffic', JSON.stringify(restartedTraffic));

  check('no renderer script errors', errors.length === 0, errors.join(' | ') || 'none');

  const failed = results.filter(item => !item.ok);
  log.push('');
  log.push((results.length - failed.length) + '/' + results.length + ' checks passed');
  await writeFile(logPath, log.join('\n'), 'utf8');
  server.close();
  app.exit(failed.length ? 1 : 0);
})();
