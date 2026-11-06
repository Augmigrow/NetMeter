// Exercise the actual main process with isolated data and capture native title bars.
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const profile = mkdtempSync(path.join(tmpdir(), 'netmeter-window-icon-probe-'));
const logPath = path.join(__dirname, 'window-icon-probe.log');
const log = [];
let failed = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('appData', profile);
app.setPath('userData', path.join(profile, 'user-data'));
mkdirSync(app.getPath('userData'), { recursive: true });
// A stale installed icon must be migrated before the native window is created.
writeFileSync(path.join(app.getPath('userData'), 'netmeter.ico'), 'obsolete waveform');
const shortcut = path.join(profile, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NetMeter.lnk');
mkdirSync(path.dirname(shortcut), { recursive: true });
writeFileSync(shortcut, 'isolated-test-sentinel');
process.env.PORT = '4196';
function check(name, ok, detail) {
  if (!ok) failed += 1;
  log.push((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail));
}
(async () => {
  await import(pathToFileURL(path.join(root, 'main.mjs')).href);
  await app.whenReady();
  let settings;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    settings = BrowserWindow.getAllWindows().find(win => /view=settings/.test(win.webContents.getURL()));
    if (settings && !settings.webContents.isLoading()) break;
    await pause(100);
  }
  if (!settings) throw new Error('Settings window was not created');
  check('actual startup migrates the obsolete installed icon',
    readFileSync(path.join(app.getPath('userData'), 'netmeter.ico')).equals(readFileSync(path.join(root, 'assets', 'tray', 'netmeter.ico'))), true);
  check('settings and widget remain independently visible', BrowserWindow.getAllWindows().filter(win => win.isVisible()).length === 2, BrowserWindow.getAllWindows().length);
  const status = await (await fetch('http://127.0.0.1:4196/api/status')).json();
  check('isolated real server starts without user credentials', status.configured === false, { configured: status.configured });
  const scriptErrors = [];
  settings.webContents.on('console-message', (_event, level, message) => { if (level === 3) scriptErrors.push(message); });
  settings.setPosition(120, 100);
  settings.show();
  settings.focus();
  for (const language of ['zh', 'en']) {
    await settings.webContents.executeJavaScript("(() => { const select = document.getElementById('language'); select.value = " + JSON.stringify(language) + "; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await pause(700);
    const title = settings.getTitle();
    check(language + ' native settings title follows language', title === (language === 'zh' ? 'NetMeter 设置' : 'NetMeter Settings'), title);
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1120, height: 1480 }, fetchWindowIcons: true });
    const source = sources.find(candidate => candidate.id === settings.getMediaSourceId());
    if (!source || source.thumbnail.isEmpty()) throw new Error('Native settings capture is unavailable');
    // Window thumbnails omit the Windows non-client area. Capture the display
    // instead, then keep only this window's title and public section heading.
    const bounds = settings.getBounds();
    const contentBounds = settings.getContentBounds();
    const display = screen.getDisplayMatching(bounds);
    const displays = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor)
    } });
    const displaySource = displays.find(candidate => candidate.display_id === String(display.id));
    if (!displaySource || displaySource.thumbnail.isEmpty()) throw new Error('Display capture is unavailable');
    const pixels = displaySource.thumbnail.getSize();
    const sx = pixels.width / display.bounds.width, sy = pixels.height / display.bounds.height;
    const header = displaySource.thumbnail.crop({
      x: Math.round((contentBounds.x - display.bounds.x) * sx), y: Math.round((bounds.y - display.bounds.y) * sy),
      width: Math.round(contentBounds.width * sx), height: Math.round(120 * sy)
    });
    const output = path.join(root, 'docs', 'screenshots', 'window-icon-' + language + '.png');
    writeFileSync(output, header.toPNG());
    const iconPixels = header.crop({ x: 0, y: 0, width: 32, height: 32 }).toBitmap();
    let green = 0, blue = 0;
    for (let index = 0; index < iconPixels.length; index += 4) {
      const b = iconPixels[index], g = iconPixels[index + 1], r = iconPixels[index + 2];
      if (g > r * 1.5 && g > b * 1.2) green += 1;
      if (b > r * 1.5 && b > g * 1.2 && g > 100) blue += 1;
    }
    check(language + ' native title icon contains both download green and upload blue', green >= 4 && blue >= 4, { green, blue });
    check(language + ' native title-bar screenshot saved', !header.isEmpty(), { width: header.getSize().width, height: header.getSize().height });
    check(language + ' native window exposes a nonempty app icon', Boolean(source.appIcon && !source.appIcon.isEmpty()), source.appIcon?.getSize());
  }
  check('no renderer script errors during bilingual native capture', scriptErrors.length === 0, scriptErrors);
  log.push(log.filter(line => line.startsWith('PASS ')).length + '/' + (log.filter(line => /^(PASS|FAIL) /.test(line)).length) + ' checks passed');
  writeFileSync(logPath, log.join('\n'), 'utf8');
  app.quit();
  app.exit(failed ? 1 : 0);
})().catch(error => {
  log.push('ERROR ' + (error.stack || String(error)));
  writeFileSync(logPath, log.join('\n'), 'utf8');
  app.exit(1);
});
