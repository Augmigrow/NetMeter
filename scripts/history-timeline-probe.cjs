// Real Electron app, isolated profile and synthetic minute records.
const { app, BrowserWindow } = require('electron');
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
  // Hidden process launch can suppress its first native ShowWindow call.
  settings.show();
  const run = code => win.webContents.executeJavaScript(code);
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await run(`localStorage.setItem('netmeter-controller-v2', JSON.stringify({ controllerEnabled: false, domains: ['example.com'], history: '30天', avgWindow: '5分钟', totals: { 'example.com': { down: 920483901, up: 204902300 } }, lightTheme: false })); localStorage.setItem('netmeter-history-tab', 'traffic'); localStorage.setItem('netmeter-history-range', '24h');`);
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
  await run("document.querySelector('.host-button').click()");
  await pause(400);
  const state = () => run(`(() => { const s = document.getElementById('historyScroll'); const p = document.getElementById('historyPanel'); return { left: s.scrollLeft, width: s.scrollWidth, client: s.clientWidth, height: s.clientHeight, scrollHeight: s.scrollHeight, range: document.getElementById('historyRange').value, bars: document.querySelectorAll('.history-hour').length, paths: document.querySelectorAll('.history-speed-line').length, label: document.getElementById('historyRangeLabel').textContent, bottom: p.getBoundingClientRect().bottom, outerWidth: document.documentElement.scrollWidth, innerWidth, innerHeight }; })()`);
  let data = await state();
  check('actual history window retains 380x306 and independent settings', win.getContentSize().join('x') === '380x306' && settings.isVisible(), win.getContentSize());
  check('24h traffic retains 24 readable bars and scrolls horizontally', data.bars === 24 && data.width > data.client && data.left > 0, data);
  check('range header shows both dated time boundaries', /\d+\/\d+ \d{2}:\d{2} — \d+\/\d+ \d{2}:\d{2}/.test(data.label), data.label);
  check('only timeline overflows, never the outer window or vertically', data.outerWidth === data.innerWidth && data.scrollHeight <= data.height && data.bottom <= data.innerHeight, data);
  await run("document.getElementById('historyScroll').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }))");
  await pause(100);
  check('ordinary mouse wheel scrolls to older traffic', (await state()).left < data.left, await state());
  await run("document.getElementById('historyScroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
  check('Home reaches the oldest part', (await state()).left === 0, await state());
  await run("document.getElementById('historyScroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); document.getElementById('historyTabSpeed').click()");
  await pause(250);
  data = await state();
  check('minute curves use four pixels per minute, not fit-to-window compression', data.paths === 2 && data.width === 5756 && data.left > 0, data);
  async function hover() {
    return run(`(() => { const s = document.getElementById('historyScroll').getBoundingClientRect(); const svg = document.querySelector('.history-speed-svg'); const b = svg.getBoundingClientRect(); svg.dispatchEvent(new MouseEvent('mousemove', { clientX: s.left + s.width * .6, clientY: b.top + 65, bubbles: true })); const tip = document.querySelector('.history-speed-tip'); const at = Number(tip.dataset.at); const samples = window.__fixture.filter(sample => sample.at <= at && sample.at > at - 5 * 60000); const down = samples.reduce((n, sample) => n + sample.down, 0) / samples.reduce((n, sample) => n + sample.downSeconds, 0); const up = samples.reduce((n, sample) => n + sample.up, 0) / samples.reduce((n, sample) => n + sample.upSeconds, 0); const box = tip.getBoundingClientRect(); return { down: Number(tip.dataset.down), expectedDown: down, up: Number(tip.dataset.up), expectedUp: up, visible: !tip.hidden, text: tip.textContent, left: box.left, right: box.right, width: innerWidth }; })()`);
  }
  let point = await hover();
  check('scrolled hover reports the exact active-second average, independently per direction', Math.abs(point.down - point.expectedDown) < .001 && Math.abs(point.up - point.expectedUp) < .001, point);
  check('hover stays inside the viewport and never says peak', point.visible && point.left >= 0 && point.right <= point.width && !/peak|峰值/i.test(point.text), point);
  for (const language of ['zh', 'en']) {
    await run(`(() => { const select = document.getElementById('language'); select.value = '${language}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (const tab of ['traffic', 'speed']) {
      await run(`document.getElementById('historyTab${tab === 'traffic' ? 'Traffic' : 'Speed'}').click()`);
      await pause(180);
      await run("document.getElementById('historyScroll').scrollLeft = 1000000");
      await pause(80);
      if (tab === 'speed') await hover();
      writeFileSync(path.join(root, 'docs', 'screenshots', 'history-' + (tab === 'speed' ? 'speed' : 'traffic') + '-' + language + '.png'), (await win.webContents.capturePage()).toPNG());
      check(language + ' ' + tab + ' scrollable history screenshot saved', true, await state());
    }
  }
  await run("document.getElementById('historyScroll').scrollLeft = 1200"); await pause(100);
  await run("document.getElementById('historyTabTraffic').click()"); await pause(180);
  await run("document.getElementById('historyTabSpeed').click()"); await pause(180);
  check('switching tabs preserves each chart scroll position', (await state()).left === 1200, await state());
  for (const [range, expected] of [['1h', 356], ['6h', 1436], ['7d', 40316], ['30d', 172796]]) {
    await run(`(() => { const select = document.getElementById('historyRange'); select.value = '${range}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pause(250);
    data = await state();
    check(range + ' range has a true minute timeline and no invalid path', data.width === expected && await run("!document.querySelector('.history-speed-svg').innerHTML.includes('NaN')"), data);
  }
  await run("document.getElementById('closeDialog').click(); document.querySelector('.host-button').click()"); await pause(250);
  check('range is remembered on close and reopen', (await state()).range === '30d', await state());
  await win.webContents.reload(); await pause(400); await run("document.querySelector('.host-button').click()"); await pause(250);
  check('tab and range survive an application renderer reload', (await state()).range === '30d' && (await state()).paths === 2, await state());
  await run(`(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('netmeter-history-v1'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('samples', 'readwrite');
    const at = Math.floor(Date.now() / 60000) * 60000;
    tx.objectStore('samples').put({ id: 'example.com|' + at, target: 'example.com', at, down: 123456, up: 600, upSeconds: 3 });
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
  })()`);
  await run("document.getElementById('historyTabSpeed').click()"); await pause(250);
  check('legacy duration warnings remain visible when the timeline is scrolled', await run("(() => { const note = document.querySelector('.history-speed-legacy-note'); const box = note?.getBoundingClientRect(); return Boolean(box && box.left >= 0 && box.right <= innerWidth); })()"), true);
  await run("document.getElementById('historyPanel').classList.add('light')");
  check('light theme keeps the range selector readable', await run("getComputedStyle(document.getElementById('historyRange')).backgroundColor === 'rgb(247, 250, 252)'"), true);
  check('no renderer errors', errors.length === 0, errors);
  log.push(log.filter(line => line.startsWith('PASS ')).length + '/' + log.filter(line => /^(PASS|FAIL) /.test(line)).length + ' checks passed'); flush(); app.quit(); app.exit(failed ? 1 : 0);
})().catch(error => { log.push('ERROR ' + (error.stack || String(error))); flush(); app.exit(1); });
