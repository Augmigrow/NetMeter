import { readFileSync } from 'node:fs';
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
  assert.match(createTray, /resolve\(root, 'assets', 'tray', 'netmeter\.ico'\)/);
  assert.match(createTray, /nativeImage\.createFromPath\(iconPath\)\.isEmpty\(\)/);
  assert.match(createTray, /new Tray\(iconPath\)/);
  assert.doesNotMatch(createTray, /image\/svg\+xml|createFromDataURL/);
  assert.match(createTray, /tray\.setToolTip\('NetMeter'\)/);
  assert.match(createTray, /tray\.on\('click', toggleWidget\)/);
});
