// Isolated Electron acceptance for editable website rows and tile visibility.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile, writeFile } = require('node:fs/promises');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'netmeter-domains-')));
const logPath = path.join(__dirname, 'domain-entries-probe.log');
const log = [];
const errors = [];
let failures = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, ok, detail) {
  if (!ok) failures += 1;
  log.push((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail));
  writeFileSync(logPath, log.join('\n'), 'utf8');
}
function json(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    response.end(await readFile(path.join(root, 'index.html')));
  } else if (pathname === '/api/status') json(response, { enabled: true, configured: true, address: '127.0.0.1:9097' });
  else if (pathname === '/api/config') json(response, { ok: true, persisted: true });
  else if (pathname === '/api/connections') json(response, {
    connections: ['github.com', 'cdn.jsdelivr.net', 'edited.example'].map((host, index) => ({
      id: host, metadata: { host }, download: Math.floor(Date.now() / 10) * (index + 1), upload: Math.floor(Date.now() / 100)
    }))
  });
  else { response.writeHead(404); response.end(); }
});

function fail(error) {
  log.push('ERROR ' + (error?.stack || String(error)));
  writeFileSync(logPath, log.join('\n'), 'utf8');
  server.close();
  app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  await app.whenReady();
  const preferences = { contextIsolation: true, nodeIntegration: false, sandbox: true };
  const settings = new BrowserWindow({ show: false, width: 560, height: 740, webPreferences: preferences });
  const widget = new BrowserWindow({ show: false, width: 384, height: 162, webPreferences: preferences });
  for (const window of [settings, widget]) window.webContents.on('console-message', (_, level, message) => { if (level >= 2) errors.push(message); });
  await settings.loadURL(base + '/?view=settings');
  await settings.webContents.executeJavaScript("localStorage.setItem('netmeter-controller-v2', JSON.stringify({controllerEnabled:true, controllerAddress:'127.0.0.1:9097', domains:['github.com','cdn.jsdelivr.net'], history:'7天', avgWindow:'5分钟', historyTotals:{'github.com':{down:1024,up:512},'cdn.jsdelivr.net':{down:2048,up:1024}}}))");
  await settings.loadURL(base + '/?view=settings');
  await widget.loadURL(base + '/?view=widget');
  await sleep(1300);
  const rows = () => settings.webContents.executeJavaScript("[...document.querySelectorAll('.domain-entry')].map(row=>({url:row.querySelector('.domain-url').value,visible:row.querySelector('.domain-visible').checked}))");
  const tiles = () => widget.webContents.executeJavaScript("[...document.querySelectorAll('.meter')].map(row=>row.dataset.host)");
  const save = async () => {
    await settings.webContents.executeJavaScript("document.getElementById('preferences').requestSubmit()");
    await sleep(350);
  };
  const first = await rows();
  check('legacy websites become selected editable rows', first.length === 2 && first.every(row => row.visible), first);
  check('both selected websites have tiles', (await tiles()).length === 2, await tiles());

  await settings.webContents.executeJavaScript("var cb=document.querySelectorAll('.domain-visible')[1];cb.checked=false;cb.dispatchEvent(new Event('change',{bubbles:true}))");
  await save();
  check('unchecking hides only that tile', JSON.stringify(await tiles()) === JSON.stringify(['github.com']), await tiles());
  const stored = await settings.webContents.executeJavaScript("JSON.parse(localStorage.getItem('netmeter-controller-v2'))");
  check('unchecked entry and prior totals remain saved', stored.domainEntries[1].visible === false && stored.domains.length === 2 && stored.historyTotals['cdn.jsdelivr.net'].down >= 2048, { entries: stored.domainEntries, totals: stored.historyTotals });
  await sleep(1200);
  const hiddenHistory = await widget.webContents.executeJavaScript("(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('netmeter-history-v1',1);r.onsuccess=()=>resolve(r.result)});const samples=await new Promise(resolve=>{const r=db.transaction('samples').objectStore('samples').index('targetAt').getAll(IDBKeyRange.bound(['cdn.jsdelivr.net',0],['cdn.jsdelivr.net',Date.now()]));r.onsuccess=()=>resolve(r.result)});db.close();return samples.reduce((sum,sample)=>sum+sample.down,0)})()");
  check('hidden websites continue recording traffic', hiddenHistory > 0, hiddenHistory);
  await settings.loadURL(base + '/?view=settings');
  await widget.loadURL(base + '/?view=widget');
  await sleep(350);
  check('selection survives both window reloads', (await rows())[1].visible === false && (await tiles()).length === 1, await rows());

  await settings.webContents.executeJavaScript("document.querySelectorAll('.domain-visible').forEach(cb=>{cb.checked=false;cb.dispatchEvent(new Event('change',{bubbles:true}))})");
  await save();
  check('all unchecked leaves no website tiles', (await tiles()).length === 0, await tiles());
  check('empty widget has a readable state', await widget.webContents.executeJavaScript("Boolean(document.querySelector('.meter-empty')?.textContent)"), 'empty state');
  await settings.webContents.executeJavaScript("document.querySelector('.domain-visible').checked=true;document.querySelector('.domain-visible').dispatchEvent(new Event('change',{bubbles:true}))");
  await save();
  check('checking a saved entry restores its tile', (await tiles())[0] === 'github.com', await tiles());

  await settings.webContents.executeJavaScript("document.getElementById('addDomain').click();var field=document.querySelector('.domain-entry:last-child .domain-url');field.value='https://third.example/path';field.dispatchEvent(new Event('input',{bubbles:true}))");
  await save();
  check('adding a selected row creates a tile', (await tiles()).includes('https://third.example/path'), await tiles());
  await settings.webContents.executeJavaScript("var field=document.querySelector('.domain-entry:last-child .domain-url');field.value='https://edited.example/path';field.dispatchEvent(new Event('input',{bubbles:true}))");
  await save();
  check('editing a row updates its tile target', (await tiles()).includes('https://edited.example/path') && !(await tiles()).includes('https://third.example/path'), await tiles());

  await settings.webContents.executeJavaScript("document.getElementById('addDomain').click();var field=document.querySelector('.domain-entry:last-child .domain-url');field.value='github.com';field.dispatchEvent(new Event('input',{bubbles:true}))");
  check('duplicate websites cannot be saved', await settings.webContents.executeJavaScript("!document.getElementById('preferences').checkValidity()"), 'duplicate blocked');
  await settings.webContents.executeJavaScript("document.querySelector('.domain-entry:last-child .domain-remove').click();document.querySelector('.domain-entry:last-child .domain-remove').click()");
  await save();
  check('removing a row removes its tile and keeps other rows', (await rows()).length === 2 && !(await tiles()).some(name => name.includes('edited.example')), await rows());
  await settings.webContents.executeJavaScript("var field=document.querySelector('.domain-url');field.value='unsaved.example';field.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('cancelSettings').click()");
  await sleep(300);
  check('cancel restores saved row values', (await rows())[0].url === 'github.com', await rows());

  await settings.loadURL(base + '/?view=settings');
  for (const language of ['zh', 'en']) {
    await settings.webContents.executeJavaScript("var select=document.getElementById('language');select.value=" + JSON.stringify(language) + ";select.dispatchEvent(new Event('change',{bubbles:true}))");
    const labels = await settings.webContents.executeJavaScript("({add:document.getElementById('addDomain').title,remove:document.querySelector('.domain-remove').title,checkbox:document.querySelector('.domain-visible').getAttribute('aria-label'),placeholder:document.querySelector('.domain-url').placeholder})");
    check(language + ' row controls are localized', language === 'en' ? /Add website/.test(labels.add) && !/[\u4e00-\u9fff]/.test(JSON.stringify(labels)) : /添加网址/.test(labels.add), labels);
    const height = await settings.webContents.executeJavaScript('document.documentElement.scrollHeight');
    settings.setContentSize(560, Math.max(740, height + 8));
    await sleep(250);
    const layout = await settings.webContents.executeJavaScript("[...document.querySelectorAll('.domain-entry')].every(row=>{const b=row.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&row.scrollWidth<=row.clientWidth})");
    check(language + ' rows fit the settings window', layout, { width: 560 });
    await writeFile(path.join(root, 'docs', 'screenshots', 'settings-' + language + '.png'), (await settings.webContents.capturePage()).toPNG());
  }
  settings.setContentSize(440, 740);
  await sleep(200);
  check('rows also fit the minimum settings width', await settings.webContents.executeJavaScript("[...document.querySelectorAll('.domain-entry')].every(row=>row.getBoundingClientRect().right<=innerWidth&&row.scrollWidth<=row.clientWidth)"), { width: 440 });
  check('no renderer errors', errors.length === 0, errors);
  log.push((log.length - failures) + '/' + log.length + ' checks passed');
  writeFileSync(logPath, log.join('\n'), 'utf8');
  settings.destroy();
  widget.destroy();
  server.close();
  app.exit(failures ? 1 : 0);
})().catch(fail);
