// Verify real Windows decoding and Shell tray registration, then remove the test icon.
const { app, nativeImage, Tray } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets', 'tray');
const logPath = path.join(__dirname, 'tray-icon-probe.log');
const log = [];
let failed = 0;
let tray;
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'netmeter-tray-probe-')));
function check(name, ok, detail) {
  if (!ok) failed += 1;
  log.push((ok ? 'PASS ' : 'FAIL ') + name + ' :: ' + JSON.stringify(detail));
}

(async () => {
  await app.whenReady();
  const oldSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#167cf0"/></svg>';
  const oldImage = nativeImage.createFromDataURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(oldSvg));
  log.push('DIAGNOSTIC old SVG native decode empty=' + oldImage.isEmpty());
  for (const size of [16, 20, 24, 32, 40, 48, 64]) {
    const image = nativeImage.createFromPath(path.join(assets, 'netmeter-' + size + '.png'));
    const dimensions = image.getSize();
    check(size + 'px PNG decodes', !image.isEmpty() && dimensions.width === size && dimensions.height === size, dimensions);
    const bitmap = image.toBitmap();
    let green = 0;
    let blue = 0;
    let visible = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      const b = bitmap[index], g = bitmap[index + 1], r = bitmap[index + 2], a = bitmap[index + 3];
      if (a < 200) continue;
      visible += 1;
      if (g > r * 1.5 && g > b * 1.2) green += 1;
      if (b > r * 1.5 && b > g * 1.2 && g > 100) blue += 1;
    }
    check(size + 'px arrows have visible green and blue pixels', green >= size && blue >= size && visible > size * size * .7, { green, blue, visible });
  }
  const icoPath = path.join(assets, 'netmeter.ico');
  const ico = nativeImage.createFromPath(icoPath);
  check('Windows ICO decodes as a nonempty native image', !ico.isEmpty(), ico.getSize());
  tray = new Tray(icoPath);
  tray.setToolTip('NetMeter icon verification');
  await new Promise(resolve => setTimeout(resolve, 400));
  const bounds = tray.getBounds();
  check('the icon registers in the Windows tray', !tray.isDestroyed() && bounds.width > 0 && bounds.height > 0, bounds);
  tray.destroy();
  check('the temporary tray icon is removed after verification', tray.isDestroyed(), true);
  log.push((log.filter(line => line.startsWith('PASS ')).length) + '/17 checks passed');
  writeFileSync(logPath, log.join('\n'), 'utf8');
  app.exit(failed ? 1 : 0);
})().catch(error => {
  if (tray && !tray.isDestroyed()) tray.destroy();
  log.push('ERROR ' + (error.stack || String(error)));
  writeFileSync(logPath, log.join('\n'), 'utf8');
  app.exit(1);
});
