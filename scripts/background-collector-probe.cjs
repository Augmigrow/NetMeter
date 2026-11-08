// Bounded real-time hidden-window acceptance. No cover/minimize UI experiments on the user's desktop.
const { app, BrowserWindow } = require('electron');
let shuttingDown = false;
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
// This fixture never displays native windows or creates a cover/watcher outside its process.
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
const nativeSetAlwaysOnTop = BrowserWindow.prototype.setAlwaysOnTop;
BrowserWindow.prototype.setAlwaysOnTop = function () { nativeSetAlwaysOnTop.call(this, false); };
app.on('browser-window-created', (_event, window) => nativeSetAlwaysOnTop.call(window, false));
app.on('browser-window-created', (_event, window) => { window.on('close', () => { if (!shuttingDown) app.exit(2); }); });

const { createServer } = require('node:http');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const root = join(__dirname, '..'), profile = mkdtempSync(join(tmpdir(), 'netmeter-background-'));
app.setPath('appData', profile); app.setPath('userData', join(profile, 'user-data'));
process.env.PORT = '4198';
const duration = process.argv.includes('--quick') ? 5000 : 300000;
const log = [], errors = []; let failures = 0, origin, base, upstream, win, collector;
const pause = ms => new Promise(r => setTimeout(r, ms));
function flush() { writeFileSync(join(__dirname, 'background-collector-probe.log'), log.join('\n')); }
function check(name, pass, detail) { if (!pass) failures++; log.push((pass ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail)); flush(); }
async function post(route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw Error('Fixture setup failed ' + route + ' ' + response.status);
}
function payload(now) {
  const elapsed = Math.max(0, now - origin), cycle = Math.floor(elapsed / 15000), phase = elapsed % 15000;
  const bytes = Math.floor(Math.min(5000, Math.max(0, phase - 2000)) / 10);
  const cumulative = cycle * 500 + bytes;
  const active = phase >= 2000 && phase < 7000;
  return { downloadTotal: cumulative, uploadTotal: cumulative * 2, connections: active ? [{ id: 'intentionally-reused', start: new Date(origin + cycle * 15000 + 2000).toISOString(), metadata: { host: 'example.com', sourceIP: '127.0.0.1', sourcePort: 1000, destinationIP: '1.2.3.4', destinationPort: 443, network: 'tcp' }, download: bytes, upload: bytes * 2 }] : [] };
}
setTimeout(() => { log.push('ERROR bounded probe deadline exceeded'); flush(); app.exit(2); }, duration + 20000);
(async () => {
  await import(pathToFileURL(join(root, 'main.mjs')).href); await app.whenReady();
  for (let i = 0; i < 150; i++) {
    win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=widget'));
    if (win && !win.webContents.isLoading()) break; await pause(100);
  }
  if (!win) throw Error('widget_missing');
  base = new URL(win.webContents.getURL()).origin;
  origin = Date.now();
  upstream = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload(Date.now()))); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  await post('/api/collector/settings', { targets: ['example.com'], history: '30天' });
  await post('/api/config', { enabled: true, address: '127.0.0.1:' + upstream.address().port, secret: 'synthetic-isolated-fixture' });
  await win.webContents.executeJavaScript(`localStorage.setItem('netmeter-controller-v2', JSON.stringify({controllerEnabled:true, controllerAddress:'127.0.0.1:${upstream.address().port}', domains:['example.com'], history:'30天',avgWindow:'5分钟'}));`);
  win.webContents.reload(); await pause(1000);
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await win.webContents.executeJavaScript(`window.__rawConnectionFetches=0; const actualFetch=window.fetch; window.fetch=(url,...args)=>{ if(String(url).includes('/api/connections')) window.__rawConnectionFetches++; return actualFetch(url,...args); }; void 0;`);
  const started = Date.now();
  for (const window of BrowserWindow.getAllWindows()) window.hide();
  log.push('RUNNING hidden-window real-time test for ' + duration + 'ms'); flush();
  await pause(duration);
  const state = await (await fetch(base + '/api/collector/state')).json();
  const observations = state.diagnostics.observations.filter(at => at >= started);
  const intervals = observations.slice(1).map((at, i) => at - observations[i]);
  const sorted = [...intervals].sort((a,b)=>a-b), max = Math.max(...intervals), mean = intervals.reduce((a,b)=>a+b,0)/intervals.length;
  check((duration === 300000 ? 'hidden for five real minutes' : 'quick hidden-window smoke') + ' keeps approximately one-second backend observations', observations.length >= Math.floor(duration/1050) - 1 && max < 1800 && mean < 1050 && observations[0] - started < 1800 && Date.now() - observations.at(-1) < 1800, { durationMs:Date.now()-started, samples:observations.length, maxMs:max, meanMs:mean, p99Ms:sorted[Math.floor(sorted.length*.99)], firstDelayMs:observations[0]-started, lastDelayMs:Date.now()-observations.at(-1) });
  check('global cumulative counters include every ended five-second connection', state.global.down >= Math.floor(duration/15000) * 500 && state.global.up === state.global.down * 2, { down:state.global.down, up:state.global.up });
  check('domain short-connection observations are nonzero with truthful missing-tail reporting', state.metrics[0].totalDown >= Math.floor(duration/15000) * 300 && state.metrics[0].totalDown <= state.global.down && state.coverage.finalConnectionEvents === false, { domainDown:state.metrics[0].totalDown, coverage:state.coverage });
  const raw = await win.webContents.executeJavaScript('window.__rawConnectionFetches');
  check('the production renderer only fetches collected state, never active connections', raw === 0, raw);
  const nativeWindows = BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), topmost: w.isAlwaysOnTop() }));
  check('no native test windows are displayed or permanently topmost', nativeWindows.every(w => !w.visible && !w.topmost), nativeWindows);
  const before=(await(await fetch(base+'/api/collector/state')).json()).global.down;
  win.webContents.reload(); await pause(1500);
  const after=await(await fetch(base+'/api/collector/state')).json();
  check('renderer restoration does not replay cumulative bytes into a peak or reset collection', after.global.down>=before && after.global.down-before<200, {before,after:after.global.down,rate:after.metrics[0].downRate});
  check('no renderer errors',errors.length===0,errors);
  log.push(log.filter(s=>s.startsWith('PASS ')).length+'/'+log.filter(s=>/^(PASS|FAIL) /.test(s)).length+' checks passed');flush();
  upstream.close();shuttingDown = true;process.exitCode = failures ? 1 : 0;app.quit();
})().catch(error=>{log.push('ERROR '+error.stack);flush();upstream?.close();app.exit(1);});
