// Real Electron app, isolated profile and synthetic minute records.
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
app.disableHardwareAcceleration();
// Native windows stay hidden. Test the production windows; re-render their DOM offscreen for PNGs.
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
const nativeSetAlwaysOnTop = BrowserWindow.prototype.setAlwaysOnTop;
BrowserWindow.prototype.setAlwaysOnTop = function () { nativeSetAlwaysOnTop.call(this, false); };
app.on('browser-window-created', (_event, window) => {
  nativeSetAlwaysOnTop.call(window, false);
  window.on('close', () => app.exit(2));
});
setTimeout(() => app.exit(2), 60000);
const { mkdtempSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const profile = mkdtempSync(path.join(tmpdir(), 'netmeter-timeline-probe-'));
app.setPath('appData', profile);
app.setPath('userData', path.join(profile, 'user-data'));
process.env.PORT = '4196';
const log = [], errors = [];
let failed = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, ok, detail) { if (!ok) failed += 1; log.push((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail)); }
function flush() { for (const name of ['history-timeline-probe.log', 'history-curve-probe.log']) writeFileSync(path.join(__dirname, name), log.join('\n')); }
(async () => {
  await import(pathToFileURL(path.join(root, 'main.mjs')).href);
  await app.whenReady();
  let win;
  for (let i = 0; i < 100; i += 1) {
    win = BrowserWindow.getAllWindows().find(w => /view=widget/.test(w.webContents.getURL()));
    if (win && !win.webContents.isLoading()) break;
    await pause(100);
  }
  if (!win) throw Error('Real widget did not start');
  const settings = BrowserWindow.getAllWindows().find(w => /view=settings/.test(w.webContents.getURL()));
  // The settings window is independent, but this fixture never displays it.
  settings.show();
  const run = async code => {
    const result = await win.webContents.executeJavaScript(code);
    // Hidden Chromium can defer native scroll events. These are DOM-interaction checks,
    // not an OS-input acceptance test: flush the scroll handler without showing a window.
    await win.webContents.executeJavaScript("document.getElementById('historyScroll')?.dispatchEvent(new Event('scroll')); void 0;");
    return result;
  };
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await run(`localStorage.setItem('netmeter-controller-v2', JSON.stringify({ controllerEnabled: false, domains: ['example.com'], history: '30天', avgWindow: '5分钟', historyTotals: { 'example.com': { down: 920483901, up: 204902300 } }, lightTheme: false })); localStorage.setItem('netmeter-history-tab', 'traffic'); localStorage.setItem('netmeter-history-range', '24h'); localStorage.setItem('netmeter-history-visible-spans', JSON.stringify({ traffic: 3600000, speed: 300000 }));`);
  await win.webContents.reload();
  await pause(600);
  await run(`(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('netmeter-history-v1', 1); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('samples', 'readwrite');
    const store = tx.objectStore('samples');
    const now = Math.floor(Date.now() / 60000) * 60000;
    window.__fixture = [];
    for (let i = 2400; i >= 0; i -= 1) {
      const at = now - i * 60000;
      const sample = { id: 'example.com|' + at, target: 'example.com', at, down: Math.round(1200000 + (Math.sin(i / 12) + 1) * 2200000), up: Math.round(400000 + (Math.cos(i / 9) + 1) * 600000), downSeconds: 6, upSeconds: 3 };
      store.put(sample); window.__fixture.push(sample);
    }
    await new Promise(resolve => { tx.oncomplete = resolve; });
    db.close();
  })()`);
  await run(`(async () => { for (let offset = 0; offset < window.__fixture.length; offset += 25) {
    const response = await fetch('/api/collector/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({samples:window.__fixture.slice(offset,offset+25)}) });
    if (!response.ok) throw Error('fixture_import_failed');
  } })()`);
  await run("document.querySelector('.host-button').click()");
  await pause(400);
  const state = () => run(`(() => { const s = document.getElementById('historyScroll'); const p = document.getElementById('historyPanel'); return { left: s.scrollLeft, width: s.scrollWidth, client: s.clientWidth, height: s.clientHeight, scrollHeight: s.scrollHeight, range: document.getElementById('historyRange').value, bars: document.querySelectorAll('.history-hour').length, paths: document.querySelectorAll('.history-speed-line').length, label: document.getElementById('historyRangeLabel').textContent, visible: document.getElementById('historyVisibleSpan').textContent, visibleStart: Number(document.getElementById('historyRangeLabel').dataset.start), visibleEnd: Number(document.getElementById('historyRangeLabel').dataset.end), ticks: document.querySelectorAll('.history-axis span').length, bottom: p.getBoundingClientRect().bottom, outerWidth: document.documentElement.scrollWidth, innerWidth, innerHeight }; })()`);
  async function zoomWheel(deltaY, ratio = .6, deltaMode = 0) {
    const result = await run(`(() => {
      const s = document.getElementById('historyScroll'), box = s.getBoundingClientRect();
      const before = { left: s.scrollLeft, width: s.scrollWidth, client: s.clientWidth };
      const anchor = s.clientWidth * ${ratio};
      const event = new WheelEvent('wheel', { deltaY: ${deltaY}, deltaMode: ${deltaMode}, ctrlKey: true, clientX: box.left + anchor, clientY: box.top + 60, bubbles: true, cancelable: true });
      s.dispatchEvent(event);
      const after = { left: s.scrollLeft, width: s.scrollWidth, client: s.clientWidth };
      return { before, after, canceled: event.defaultPrevented, errorPixels: Math.abs((before.left + anchor) / before.width - (after.left + anchor) / after.width) * after.width };
    })()`);
    await pause(30);
    return result;
  }
  let data = await state();
  check('actual history window retains 380x306 and independent settings without displaying test windows', win.getContentSize().join('x') === '380x306' && !settings.isDestroyed() && settings.netmeterShowRequested && !settings.isVisible() && !win.isVisible(), win.getContentSize());
  check('24h traffic initially displays its entire selected range', data.bars === 24 && data.width === data.client && data.left === 0, data);
  check('range header shows visible dated time boundaries and duration', /\d+\/\d+ \d{2}:\d{2} — \d+\/\d+ \d{2}:\d{2}/.test(data.label) && /可视/.test(data.visible) && data.visibleEnd - data.visibleStart < 24 * 3600000, data);
  check('only timeline overflows, never the outer window or vertically', data.outerWidth === data.innerWidth && data.scrollHeight <= data.height && data.bottom <= data.innerHeight, data);
  const captureWindow = new BrowserWindow({ show: false, width: 380, height: 306, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  for (const language of ['zh', 'en']) {
    await run(`(() => { const select = document.getElementById('language'); select.value = '${language}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (const tab of ['traffic', 'speed']) {
      await run(`document.getElementById('historyTab${tab === 'traffic' ? 'Traffic' : 'Speed'}').click()`); await pause(180);
      const initial = await state();
      check(language + ' ' + tab + ' defaults to the full 24h point extent', initial.width === initial.client && initial.left === 0 && initial.visibleEnd - initial.visibleStart === 1439 * 60000, initial);
      const html = await run("(() => { const node = document.documentElement.cloneNode(true); node.querySelectorAll('script').forEach(script => script.remove()); document.querySelectorAll('select').forEach((select, i) => { Array.from(node.querySelectorAll('select')[i].options).forEach(option => option.toggleAttribute('selected', option.value === select.value)); }); return '<!doctype html>' + node.outerHTML; })()");
      await captureWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); await pause(120);
      writeFileSync(path.join(root, 'docs', 'screenshots', 'history-' + tab + '-' + language + '.png'), (await captureWindow.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    }
  }
  await run("(() => { const select = document.getElementById('language'); select.value = 'zh'; select.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('historyTabTraffic').click(); })()"); await pause(180);
  await zoomWheel(-240); await zoomWheel(-240);
  await run("document.getElementById('historyScroll').scrollLeft = 1000000"); await pause(80);
  data = await state();
  await run("document.getElementById('historyScroll').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }))");
  await pause(100);
  check('ordinary mouse wheel scrolls to older traffic', (await state()).left < data.left, await state());
  await run("document.getElementById('historyScroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
  check('Home reaches the oldest part', (await state()).left === 0, await state());
  await run("document.getElementById('historyScroll').scrollLeft = 180"); await pause(50);
  const trafficBytes = await run("JSON.stringify(Array.from(document.querySelectorAll('.history-hour'), n => [n.dataset.down, n.dataset.up]))");
  const trafficZoom = await zoomWheel(-120);
  check('traffic Ctrl-wheel zooms in with an anchored cursor and prevents page zoom', trafficZoom.canceled && trafficZoom.after.width > trafficZoom.before.width && trafficZoom.errorPixels < 1.1 && win.webContents.getZoomFactor() === 1, trafficZoom);
  check('traffic zoom never changes bars, byte totals, or total range', (await state()).range === '24h' && trafficBytes === await run("JSON.stringify(Array.from(document.querySelectorAll('.history-hour'), n => [n.dataset.down, n.dataset.up]))"), await state());
  const trafficWidth = (await state()).width;
  await run("document.getElementById('historyTabSpeed').click()");
  await pause(250);
  data = await state();
  check('minute curves independently default to the full range before customization', data.paths === 2 && data.width === data.client && data.left === 0, data);
  async function hover() {
    return run(`(() => { const s = document.getElementById('historyScroll').getBoundingClientRect(); const svg = document.querySelector('.history-speed-svg'); const b = svg.getBoundingClientRect(); svg.dispatchEvent(new MouseEvent('mousemove', { clientX: s.left + s.width * .6, clientY: b.top + 65, bubbles: true })); const tip = document.querySelector('.history-speed-tip'); const at = Number(tip.dataset.at); const samples = window.__fixture.filter(sample => sample.at <= at && sample.at > at - 5 * 60000); const down = samples.reduce((n, sample) => n + sample.down, 0) / samples.reduce((n, sample) => n + sample.downSeconds, 0); const up = samples.reduce((n, sample) => n + sample.up, 0) / samples.reduce((n, sample) => n + sample.upSeconds, 0); const box = tip.getBoundingClientRect(); return { down: Number(tip.dataset.down), expectedDown: down, up: Number(tip.dataset.up), expectedUp: up, visible: !tip.hidden, text: tip.textContent, left: box.left, right: box.right, width: innerWidth }; })()`);
  }
  await run("document.getElementById('historyScroll').scrollLeft = 4600"); await pause(50);
  const curvePath = await run("document.querySelector('.history-speed-line.down').getAttribute('d')");
  const speedZoom = await zoomWheel(-120);
  check('speed Ctrl-wheel independently zooms in around the cursor', speedZoom.canceled && speedZoom.after.width > speedZoom.before.width && speedZoom.errorPixels < 1.1, speedZoom);
  check('speed zoom keeps the exact same minute curve and selected total range', (await state()).range === '24h' && curvePath === await run("document.querySelector('.history-speed-line.down').getAttribute('d')"), await state());
  const speedOut = await zoomWheel(120);
  check('Ctrl-wheel down widens the visible span with the same cursor anchor', speedOut.after.width < speedOut.before.width && speedOut.errorPixels < 1.1, speedOut);
  const speedLines = await zoomWheel(-3, .6, 1);
  check('line-mode Ctrl-wheel also zooms and is canceled', speedLines.canceled && speedLines.after.width > speedLines.before.width, speedLines);
  log.push('SKIP native Chromium wheel input: this fixture never focuses or displays a desktop window.');
  let point = await hover();
  check('scrolled hover reports the exact active-second average, independently per direction', Math.abs(point.down - point.expectedDown) < .001 && Math.abs(point.up - point.expectedUp) < .001, point);
  check('hover stays inside the viewport and never says peak', point.visible && point.left >= 0 && point.right <= point.width && !/peak|峰值/i.test(point.text), point);
  await run("document.getElementById('historyTabTraffic').click()"); await pause(180);
  check('traffic retains its own zoom after switching from speed', (await state()).width === trafficWidth, await state());
  await run("document.getElementById('historyTabSpeed').click()"); await pause(180);
  const rememberedSpeedWidth = (await state()).width;
  for (const language of ['zh', 'en']) {
    await run(`(() => { const select = document.getElementById('language'); select.value = '${language}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (const tab of ['traffic', 'speed']) {
      await run(`document.getElementById('historyTab${tab === 'traffic' ? 'Traffic' : 'Speed'}').click()`);
      await pause(180);
      await run("document.getElementById('historyScroll').scrollLeft = 1000000");
      await pause(80);
      if (tab === 'speed') await hover();
      const visibleText = (await state()).visible;
      check(language + ' visible span is localized', language === 'en' ? /^View /.test(visibleText) && !/[\u4e00-\u9fff]/.test(visibleText) : /^可视 /.test(visibleText), visibleText);
      check(language + ' ' + tab + ' keeps customized zoom on language switch', (await state()).width === (tab === 'traffic' ? trafficWidth : rememberedSpeedWidth), await state());
    }
  }
  const rememberedScroll = Math.floor(Math.min(1200, ((await state()).width - (await state()).client) / 2));
  await run("document.getElementById('historyScroll').scrollLeft = " + rememberedScroll); await pause(100);
  await run("document.getElementById('historyTabTraffic').click()"); await pause(180);
  await run("document.getElementById('historyTabSpeed').click()"); await pause(180);
  check('switching tabs preserves each chart scroll position', (await state()).left === rememberedScroll, await state());
  await run("document.getElementById('closeDialog').click(); document.querySelector('.host-button').click()"); await pause(250);
  check('zoom survives close and reopen', (await state()).width === rememberedSpeedWidth, await state());
  await win.webContents.reload(); await pause(450); await run("document.querySelector('.host-button').click()"); await pause(250);
  check('zoom is restored after renderer restart', (await state()).width === rememberedSpeedWidth, await state());
  await run("document.getElementById('historyTabTraffic').click()"); await pause(180);
  check('each chart zoom is independently persisted', (await state()).width === trafficWidth, await state());
  const savedZoom = () => run("JSON.parse(localStorage.getItem('netmeter-history-visible-spans'))");
  check('persisted zoom identifies only the selected total range', (await savedZoom()).range === '24h' && Object.keys(await savedZoom()).sort().join(',') === 'range,speed,traffic', await savedZoom());
  async function changeRange(range) {
    await run(`(() => { const select = document.getElementById('historyRange'); select.value = '${range}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pause(250);
  }
  await changeRange('6h');
  let reset = await state(), saved = await savedZoom();
  check('switching total range resets traffic and discards both old zoom memories', reset.range === '6h' && reset.width === reset.client && reset.left === 0 && saved.range === '6h' && saved.traffic === null && saved.speed === null, { state: reset, saved });
  await run("document.getElementById('historyTabSpeed').click()"); await pause(180);
  reset = await state();
  check('the other chart also starts at full span after a total-range switch', reset.width === reset.client && reset.left === 0, reset);
  await zoomWheel(-240);
  const sixHourZoom = (await state()).width;
  await win.webContents.reload(); await pause(450); await run("document.querySelector('.host-button').click()"); await pause(250);
  check('the current range alone retains its customized zoom across reload', (await state()).range === '6h' && (await state()).width === sixHourZoom && sixHourZoom > (await state()).client, { state: await state(), saved: await savedZoom() });
  await changeRange('24h');
  reset = await state();
  check('returning to a previous range does not resurrect its earlier speed zoom', reset.width === reset.client && reset.left === 0 && (await savedZoom()).range === '24h', reset);
  await run("document.getElementById('historyTabTraffic').click()"); await pause(180);
  reset = await state();
  check('returning to a previous range also discards its earlier traffic zoom', reset.width === reset.client && reset.left === 0, reset);
  await changeRange('6h');
  await run("document.getElementById('historyTabSpeed').click()"); await pause(180);
  reset = await state();
  check('there is no per-range zoom cache to restore on another return visit', reset.width === reset.client && (await savedZoom()).traffic === null && (await savedZoom()).speed === null, { state: reset, saved: await savedZoom() });
  await run("localStorage.setItem('netmeter-history-range', '24h'); localStorage.setItem('netmeter-history-visible-spans', JSON.stringify({ range: '6h', traffic: 3600000, speed: 300000 }))");
  await win.webContents.reload(); await pause(450); await run("document.querySelector('.host-button').click()"); await pause(250);
  reset = await state(); saved = await savedZoom();
  check('a mismatched range tag is ignored and normalized to the selected full range', reset.range === '24h' && reset.width === reset.client && saved.range === '24h' && saved.traffic === null && saved.speed === null, { state: reset, saved });
  // Return to a fresh full-range view for each total-range assertion.
  await run("localStorage.removeItem('netmeter-history-visible-spans'); localStorage.setItem('netmeter-history-tab', 'speed')");
  await win.webContents.reload(); await pause(450); await run("document.querySelector('.host-button').click()"); await pause(250);
  for (const [range, minutes] of [['1h', 60], ['6h', 360], ['24h', 1440], ['7d', 10080], ['30d', 43200]]) {
    await run(`(() => { const select = document.getElementById('historyRange'); select.value = '${range}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pause(250);
    data = await state();
    check(range + ' fresh range is entirely visible with no invalid minute path', data.width === data.client && data.left === 0 && data.visibleEnd - data.visibleStart === (minutes - 1) * 60000 && await run("!document.querySelector('.history-speed-svg').innerHTML.includes('NaN')"), data);
  }
  await run("document.getElementById('closeDialog').click(); document.querySelector('.host-button').click()"); await pause(250);
  check('range is remembered on close and reopen', (await state()).range === '30d', await state());
  await win.webContents.reload(); await pause(400); await run("document.querySelector('.host-button').click()"); await pause(250);
  check('tab and range survive an application renderer reload', (await state()).range === '30d' && (await state()).paths === 2, await state());
  await run(`(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('netmeter-history-v1'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('samples', 'readwrite');
    const at = Math.floor(Date.now() / 60000) * 60000 - 2500 * 60000;
    tx.objectStore('samples').put({ id: 'example.com|' + at, target: 'example.com', at, down: 123456, up: 600, upSeconds: 3 });
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    await fetch('/api/collector/import', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({samples:[{target:'example.com',at,down:123456,up:600,upSeconds:3}]})});
  })()`);
  await run("document.getElementById('historyTabSpeed').click()"); await pause(250);
  check('legacy duration warnings remain visible when the timeline is scrolled', await run("(() => { const note = document.querySelector('.history-speed-legacy-note'); const box = note?.getBoundingClientRect(); return Boolean(box && box.left >= 0 && box.right <= innerWidth); })()"), true);
  const fullyOut = await run("(() => { const s = document.getElementById('historyScroll'), b = s.getBoundingClientRect(); for (let i = 0; i < 30; i++) s.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, ctrlKey: true, clientX: b.left + b.width / 2, cancelable: true })); return { width: s.scrollWidth, client: s.clientWidth, ticks: document.querySelectorAll('.history-axis span').length }; })()");
  check('zoom out stops at the entire total range without tick crowding', fullyOut.width === fullyOut.client && fullyOut.ticks < 12, fullyOut);
  await run("(() => { const s = document.getElementById('historyScroll'), b = s.getBoundingClientRect(); for (let i = 0; i < 40; i++) s.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, ctrlKey: true, clientX: b.left + b.width / 2, cancelable: true })); })()");
  const minimumView = await state();
  check('30-day minute curve zoom is bounded at five visible minutes with sparse axis DOM', Math.abs(minimumView.visibleEnd - minimumView.visibleStart - 5 * 60000) < 2 && minimumView.ticks < 12 && minimumView.outerWidth === minimumView.innerWidth, minimumView);
  const atMinimum = await zoomWheel(-120);
  check('Ctrl-wheel at the minimum is still canceled without further page/chart zoom', atMinimum.canceled && atMinimum.after.width === atMinimum.before.width && win.webContents.getZoomFactor() === 1, atMinimum);
  await run("document.getElementById('historyScroll').scrollLeft = 10000000"); await pause(80);
  const cursorAlignment = await run("(() => { const s = document.getElementById('historyScroll'), svg = document.querySelector('.history-speed-svg'), b = svg.getBoundingClientRect(); svg.dispatchEvent(new MouseEvent('mousemove', { clientX: s.getBoundingClientRect().left + s.clientWidth * .6, clientY: b.top + 60, bubbles: true })); const tip = document.querySelector('.history-speed-tip'), timeline = svg.parentElement; const expected = (Number(tip.dataset.at) - Number(timeline.dataset.start)) / (Number(timeline.dataset.end) - Number(timeline.dataset.start)) * b.width; const actual = Number(document.querySelector('.history-speed-cursor').getAttribute('x1')) / 100 * b.width; return { errorPixels: Math.abs(actual - expected), tipVisible: !tip.hidden }; })()");
  check('minute cursor still aligns within one pixel at maximum 30-day zoom', cursorAlignment.errorPixels < 1 && cursorAlignment.tipVisible, cursorAlignment);
  await run("document.getElementById('historyTabTraffic').click()"); await pause(200);
  const zoomTraffic = delta => run("(() => { const s = document.getElementById('historyScroll'), b = s.getBoundingClientRect(); for (let i = 0; i < 40; i++) s.dispatchEvent(new WheelEvent('wheel', { deltaY: " + delta + ", ctrlKey: true, clientX: b.left + b.width / 2, cancelable: true })); })()");
  await zoomTraffic(240); await pause(80);
  const allTraffic = await state();
  check('all 720 traffic bars can fit the 30-day range without spurious overflow', allTraffic.bars === 720 && allTraffic.width === allTraffic.client && allTraffic.outerWidth === allTraffic.innerWidth && allTraffic.ticks < 12, allTraffic);
  await zoomTraffic(-240); await pause(80);
  const hourlyTraffic = await state();
  check('traffic zoom stops at one visible hourly bucket without changing totals or the selected range', Math.abs(hourlyTraffic.visibleEnd - hourlyTraffic.visibleStart - 3600000) < 30 && hourlyTraffic.bars === 720 && hourlyTraffic.range === '30d', hourlyTraffic);
  const scrollingFrom = hourlyTraffic.visibleStart;
  await run("document.getElementById('historyScroll').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }))"); await pause(80);
  check('ordinary wheel still scrolls the zoomed timeline and updates its visible dates', (await state()).visibleStart < scrollingFrom && (await state()).visible === hourlyTraffic.visible, await state());
  await run("document.getElementById('historyPanel').classList.add('light')");
  check('light theme keeps the range selector readable', await run("getComputedStyle(document.getElementById('historyRange')).backgroundColor === 'rgb(247, 250, 252)'"), true);
  check('all validation windows stay hidden and non-topmost', BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isAlwaysOnTop()), true);
  check('no renderer errors', errors.length === 0, errors);
  log.push(log.filter(line => line.startsWith('PASS ')).length + '/' + log.filter(line => /^(PASS|FAIL) /.test(line)).length + ' checks passed'); flush(); app.quit(); app.exit(failed ? 1 : 0);
})().catch(error => { log.push('ERROR ' + (error.stack || String(error))); flush(); app.exit(1); });
