// Run with Electron to rasterize the SVG source and rebuild the Windows ICO.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync } = require('node:fs');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets', 'tray');
const sizes = [16, 20, 24, 32, 40, 48, 64];
const logPath = path.join(__dirname, 'generate-tray-icons.log');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'netmeter-icon-build-')));
app.disableHardwareAcceleration();

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size;
    header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

(async () => {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, useContentSize: true, width: 520, height: 264,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="' + policy + '">'));
  const svg = await readFile(path.join(assets, 'netmeter.svg'), 'utf8');
  const images = [];
  for (const size of sizes) {
    const pngUrl = await window.webContents.executeJavaScript('(' + (async (svg, size) => {
      const image = new Image();
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png');
    }).toString() + ')(' + JSON.stringify(svg) + ',' + size + ')');
    const png = Buffer.from(pngUrl.split(',')[1], 'base64');
    images.push({ size, png, pngUrl });
    await writeFile(path.join(assets, 'netmeter-' + size + '.png'), png);
  }
  await writeFile(path.join(assets, 'netmeter.ico'), encodeIco(images));
  const samples = images.map(({ size, pngUrl }) => '<div class="sample"><div class="image"><img src="' + pngUrl + '" width="' + size + '" height="' + size + '"></div><span>' + size + 'px</span></div>').join('');
  const html = '<meta http-equiv="Content-Security-Policy" content="' + policy + '"><style>' +
    '*{box-sizing:border-box}body{margin:0;font:12px "Segoe UI",sans-serif;color:#203247;background:#fff}' +
    'header{height:40px;padding:10px 16px;font-size:14px;font-weight:600}' +
    'section{height:112px;padding:8px 16px}.dark{background:#202020;color:#f3f3f3}' +
    '.icons{display:flex;justify-content:space-between}.sample{width:64px;text-align:center}' +
    '.image{height:68px;display:flex;align-items:center;justify-content:center}span{font-size:10px}' +
    '</style><header>NetMeter · Tray icon</header><section>Light<div class="icons">' + samples + '</div></section><section class="dark">Dark<div class="icons">' + samples + '</div></section>';
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await window.webContents.executeJavaScript('Promise.all([...document.images].map(image => image.decode()))');
  await new Promise(resolve => setTimeout(resolve, 250));
  await mkdir(path.join(root, 'docs', 'screenshots'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'screenshots', 'tray-icon-preview.png'), (await window.webContents.capturePage()).toPNG());
  window.destroy();
  await writeFile(logPath, 'Generated ICO, PNG representations and light/dark preview: ' + sizes.join(', ') + 'px\n', 'utf8');
  app.exit(0);
})().catch(async error => {
  await writeFile(logPath, error.stack || String(error), 'utf8');
  app.exit(1);
});
