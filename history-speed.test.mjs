import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, 'index.html'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

function loadSpeed() {
  const code = [
    extractFunction('historySpeedSeries'),
    extractFunction('historyActiveSeconds'),
    'const HISTORY_SPAN_MS = 24 * 60 * 60 * 1000;',
    'const HISTORY_MINUTE_MS = 60000;'
  ].join('\n');
  return new Function(`${code}\nreturn { historySpeedSeries, historyActiveSeconds };`)();
}

const MINUTE = 60000;

test('the speed series covers the last 24 hours at minute resolution', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = 1700000000000;
  const series = historySpeedSeries([], now, 5 * MINUTE);
  assert.equal(series.length, 24 * 60);
  assert.equal(series[series.length - 1].at <= now, true);
  assert.equal(series[0].at <= now - 23 * 60 * MINUTE, true);
});

test('the curve replays the same active-second average as the tiles', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = 1700000000000;
  const at = Math.floor(now / MINUTE) * MINUTE;
  // One minute carrying 600 bytes over 60 active seconds is 10 B/s.
  const series = historySpeedSeries([{ at, down: 600, up: 0, downSeconds: 60, upSeconds: 0 }], now, 5 * MINUTE);
  assert.equal(series[series.length - 1].down, 10);
  assert.equal(series[series.length - 1].up, null);
});

test('idle seconds are excluded from the denominator', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = 1700000000000;
  const at = Math.floor(now / MINUTE) * MINUTE;
  // 600 bytes but only 6 active seconds -> 100 B/s, not 10 B/s.
  const series = historySpeedSeries([{ at, down: 600, up: 0, downSeconds: 6, upSeconds: 0 }], now, 5 * MINUTE);
  assert.equal(series[series.length - 1].down, 100);
});

test('download and upload are averaged independently', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = 1700000000000;
  const at = Math.floor(now / MINUTE) * MINUTE;
  const series = historySpeedSeries([{ at, down: 600, up: 60, downSeconds: 60, upSeconds: 60 }], now, 5 * MINUTE);
  assert.equal(series[series.length - 1].down, 10);
  assert.equal(series[series.length - 1].up, 1);
});

test('the window averages over the selected number of minutes', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = 1700000000000;
  const at = Math.floor(now / MINUTE) * MINUTE;
  const samples = [
    { at: at - MINUTE, down: 600, up: 0, downSeconds: 60, upSeconds: 0 },
    { at, down: 600, up: 0, downSeconds: 60, upSeconds: 0 }
  ];
  const twoMinutes = historySpeedSeries(samples, now, 2 * MINUTE);
  const tenMinutes = historySpeedSeries(samples, now, 10 * MINUTE);
  assert.equal(twoMinutes[twoMinutes.length - 1].down, 10);
  assert.equal(tenMinutes[tenMinutes.length - 1].down, 10);
  // The older sample falls out of the 2 minute window one step earlier.
  assert.equal(twoMinutes[twoMinutes.length - 2].down, 10);
  assert.equal(twoMinutes[twoMinutes.length - 3].down, null);
});

test('samples outside the 24 hour window are ignored', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = 1700000000000;
  const old = Math.floor((now - 25 * 60 * MINUTE) / MINUTE) * MINUTE;
  const series = historySpeedSeries([{ at: old, down: 999999, up: 0, downSeconds: 60, upSeconds: 0 }], now, 5 * MINUTE);
  assert.equal(series.every(point => point.down === null), true);
});

test('legacy samples without active seconds fall back to a full minute', () => {
  const { historySpeedSeries, historyActiveSeconds } = loadSpeed();
  const now = 1700000000000;
  const at = Math.floor(now / MINUTE) * MINUTE;
  const series = historySpeedSeries([{ at, down: 600, up: 0 }], now, 5 * MINUTE);
  assert.equal(series[series.length - 1].down, 10);
  assert.equal(historyActiveSeconds(undefined, 0), 0);
  assert.equal(historyActiveSeconds(12, 0), 12);
});
