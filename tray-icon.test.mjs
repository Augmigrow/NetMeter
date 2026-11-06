import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

const asset = name => readFileSync(new URL('./assets/tray/' + name, import.meta.url));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sizes = [16, 20, 24, 32, 40, 48, 64];

test('tray PNGs have actual pixel representations for small and high-DPI Windows icons', () => {
  for (const size of sizes) {
    const png = asset('netmeter-' + size + '.png');
    assert.deepEqual(png.subarray(0, 8), pngSignature);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 6, 'RGBA pixels with transparency');
  }
});

test('Windows ICO includes every PNG size with valid image offsets', () => {
  const ico = asset('netmeter.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), sizes.length);
  let expectedOffset = 6 + sizes.length * 16;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico[entry], size);
    assert.equal(ico[entry + 1], size);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    assert.equal(offset, expectedOffset);
    assert.deepEqual(ico.subarray(offset, offset + length), asset('netmeter-' + size + '.png'));
    expectedOffset += length;
  });
  assert.equal(expectedOffset, ico.length);
});

test('tray source uses the established download and upload colors with a contrasting outline', () => {
  const svg = asset('netmeter.svg').toString('utf8');
  assert.match(svg, /stroke="#46db8b"/);
  assert.match(svg, /stroke="#43b8ff"/);
  assert.match(svg, /fill="#15283f" stroke="#7394b1"/);
  assert.match(svg, /stroke-width="2"/);
});

test('Electron loads the real ICO and rejects empty icons before creating the tray', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const createTray = main.slice(main.indexOf('function createTray()'), main.indexOf('function refreshTrayMenu()'));
  assert.match(createTray, /const iconPath = appIconPath\(\)/);
  assert.match(createTray, /nativeImage\.createFromPath\(iconPath\)\.isEmpty\(\)/);
  assert.match(createTray, /new Tray\(iconPath\)/);
  assert.doesNotMatch(createTray, /image\/svg\+xml|createFromDataURL/);
  assert.match(createTray, /tray\.setToolTip\('NetMeter'\)/);
  assert.match(createTray, /tray\.on\('click', toggleWidget\)/);
});

const root = fileURLToPath(new URL('.', import.meta.url));
const mainSource = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const iconHelpers = mainSource.slice(mainSource.indexOf('function appIconPath()'), mainSource.indexOf('function startMenuShortcutPath()'));
function loadIconHelpers(userData, empty = false) {
  return new Function('app', 'root', 'join', 'resolve', 'dirname', 'nativeImage', 'copyFile', 'mkdir',
    iconHelpers + '\nreturn { appIconPath, bundledAppIconPath, ensureAppIcon };')(
    { getPath: name => { assert.equal(name, 'userData'); return userData; } }, root,
    join, resolve, dirname, { createFromPath: () => ({ isEmpty: () => empty }) }, copyFile, mkdir);
}

test('startup replaces the stale window ICO with the same shipped transfer icon before opening windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'netmeter-window-icon-test-'));
  try {
    const helpers = loadIconHelpers(directory);
    await writeFile(helpers.appIconPath(), 'obsolete waveform');
    await helpers.ensureAppIcon();
    assert.deepEqual(await readFile(helpers.appIconPath()), asset('netmeter.ico'));
    const startup = mainSource.slice(mainSource.indexOf('app.whenReady().then'));
    for (const call of ['startLocalServer(', 'createTray();', 'showWidget();', 'showSettings();']) {
      assert.ok(startup.indexOf('await ensureAppIcon();') < startup.indexOf(call), call);
    }
    assert.equal((mainSource.match(/icon: appIconPath\(\)/g) || []).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('first startup creates the icon directory and invalid bundled icons do not replace the installed icon', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'netmeter-first-icon-test-'));
  try {
    const helpers = loadIconHelpers(join(directory, 'fresh-profile'));
    await helpers.ensureAppIcon();
    assert.deepEqual(await readFile(helpers.appIconPath()), asset('netmeter.ico'));
    const invalid = loadIconHelpers(join(directory, 'fresh-profile'), true);
    await assert.rejects(invalid.ensureAppIcon(), /app icon could not be loaded/);
    assert.deepEqual(await readFile(helpers.appIconPath()), asset('netmeter.ico'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Start menu shortcut installation uses the path resolver, not the Promise resolver', async () => {
  const code = mainSource.slice(mainSource.indexOf('function installStartMenuShortcut()'), mainSource.indexOf('async function loadControllerConfig()'));
  let launched;
  const install = new Function('root', 'resolve', 'spawn', 'process', 'appIconPath', 'startMenuShortcutPath', code + '\nreturn installStartMenuShortcut;')(
    root, resolve, (...arguments_) => {
      launched = arguments_;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }, { execPath: 'electron.exe' }, () => 'installed-netmeter.ico', () => 'installed-NetMeter.lnk');
  assert.equal(await install(), true);
  assert.equal(launched[0], 'powershell.exe');
  assert.ok(launched[1].includes(resolve(root, 'scripts', 'install-start-menu.ps1')));
  assert.ok(launched[1].includes('installed-netmeter.ico'));
  assert.ok(launched[1].includes('installed-NetMeter.lnk'));
  assert.equal(launched[2].windowsHide, true);
});

test('shortcut installer copies the packaged icon instead of regenerating the old waveform', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'netmeter-shortcut-icon-test-'));
  try {
    const icon = join(directory, 'netmeter.ico');
    const shortcut = join(directory, 'NetMeter.lnk');
    await writeFile(icon, 'obsolete waveform');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(root, 'scripts', 'install-start-menu.ps1'), '-TargetPath', process.execPath,
      '-WorkingDirectory', root, '-IconPath', icon, '-ShortcutPath', shortcut], { windowsHide: true });
    assert.deepEqual(await readFile(icon), asset('netmeter.ico'));
    assert.ok((await readFile(shortcut)).length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
