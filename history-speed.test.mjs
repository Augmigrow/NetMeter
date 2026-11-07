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
    extractFunction('historySpanWidth'),
    extractFunction('historySpeedX'),
    extractFunction('windowRates'),
    'const HISTORY_SPAN_MS = 24 * 60 * 60 * 1000;',
    'const HISTORY_MINUTE_MS = 60000;'
  ].join('\n');
  return new Function(`${code}\nreturn { historySpeedSeries, historyActiveSeconds, historySpanWidth, historySpeedX, windowRates };`)();
}

const MINUTE = 60000;

test('history tab memory restores speed and falls back to traffic', () => {
  const read = new Function('localStorage', 'const HISTORY_TAB_KEY = "netmeter-history-tab"; ' + extractFunction('storedHistoryTab') + '; return storedHistoryTab();');
  assert.equal(read({ getItem: () => 'speed' }), 'speed');
  assert.equal(read({ getItem: () => 'traffic' }), 'traffic');
  assert.equal(read({ getItem: () => null }), 'traffic');
  assert.equal(read({ getItem: () => 'invalid' }), 'traffic');
  assert.equal(read({ getItem: () => { throw new Error('storage unavailable'); } }), 'traffic');
  assert.match(source, /localStorage\.setItem\(HISTORY_TAB_KEY, historyTab\)/);
  assert.doesNotMatch(source, /id="historyDefaultTab"/);
});

test('the speed series covers the last 24 hours at minute resolution', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = 1700000000000;
  const series = historySpeedSeries([], now, 5 * MINUTE);
  assert.equal(series.length, 24 * 60);
  assert.equal(series[series.length - 1].at <= now, true);
  assert.equal(series[0].at <= now - 23 * 60 * MINUTE, true);
});

test('full-range initial views retain empty ends and original minute values', () => {
  const { historySpeedSeries, historySpanWidth, historySpeedX } = loadSpeed();
  const now = Math.floor(1700000000000 / MINUTE) * MINUTE;
  const samples = [{ at: now - 10 * MINUTE, down: 600, up: 0, downSeconds: 6, upSeconds: 0 }];
  const series = historySpeedSeries(samples, now, 2 * MINUTE, 60 * MINUTE);
  assert.equal(series.length, 60);
  assert.equal(series[0].at, now - 59 * MINUTE);
  assert.equal(series.at(-1).at, now);
  assert.equal(series[49].down, 100);
  assert.equal(series[0].down, null);
  assert.equal(series.at(-1).down, null);
  assert.equal(historySpeedX(0, 60), 0);
  assert.equal(historySpeedX(59, 60), 100);
  assert.equal(historySpanWidth(59 * MINUTE, null, 5 * MINUTE, 356), 356);
  assert.equal(historySpanWidth(1439 * MINUTE, null, 5 * MINUTE, 356), 356);
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

test('bursts across minutes replay both directions with the same active seconds as the tile', () => {
  const { historySpeedSeries, windowRates } = loadSpeed();
  const minute = Math.floor(1700000000000 / MINUTE) * MINUTE;
  const events = [
    { at: minute - 65000, down: 12000000, up: 6000000, elapsed: 2 },
    { at: minute - 58000, down: 8000000, up: 0, elapsed: 1 },
    { at: minute + 2000, down: 10000000, up: 3000000, elapsed: 2 }
  ];
  const stored = [...new Set(events.map(event => Math.floor(event.at / MINUTE) * MINUTE))].map(at => {
    const sameMinute = events.filter(event => Math.floor(event.at / MINUTE) * MINUTE === at);
    return {
      at,
      down: sameMinute.reduce((sum, event) => sum + event.down, 0),
      up: sameMinute.reduce((sum, event) => sum + event.up, 0),
      downSeconds: sameMinute.reduce((sum, event) => sum + (event.down > 0 ? event.elapsed : 0), 0),
      upSeconds: sameMinute.reduce((sum, event) => sum + (event.up > 0 ? event.elapsed : 0), 0)
    };
  });
  const live = windowRates(events, minute - 5 * MINUTE);
  const historical = historySpeedSeries(stored, minute + 3000, 5 * MINUTE).at(-1);
  assert.equal(live.down, 6000000);
  assert.equal(live.up, 2250000);
  assert.equal(historical.down, live.down);
  assert.equal(historical.up, live.up);
});

test('legacy bytes without seconds are unknown, not spread across an invented minute', () => {
  const { historySpeedSeries, historyActiveSeconds } = loadSpeed();
  const minute = Math.floor(1700000000000 / MINUTE) * MINUTE;
  const samples = [
    { at: minute - MINUTE, down: 12000000, up: 6000000 },
    { at: minute, down: 600, up: 300, downSeconds: 6, upSeconds: 3 }
  ];
  const series = historySpeedSeries(samples, minute + 1000, 2 * MINUTE);
  assert.equal(series.at(-1).down, null);
  assert.equal(series.at(-1).up, null);
  const later = historySpeedSeries(samples, minute + MINUTE + 1000, 2 * MINUTE);
  assert.equal(later.at(-1).down, 100);
  assert.equal(later.at(-1).up, 100);
  assert.equal(historyActiveSeconds(undefined, 12000000), null);
  assert.equal(historyActiveSeconds(0, 100), null);
  assert.equal(historyActiveSeconds(null, 10), null);
  assert.equal(historyActiveSeconds(undefined, 0), 0);
  assert.equal(historyActiveSeconds(6, 100), 6);
});

test('missing duration in one direction does not conceal the other direction', () => {
  const { historySpeedSeries } = loadSpeed();
  const minute = Math.floor(1700000000000 / MINUTE) * MINUTE;
  const series = historySpeedSeries([
    { at: minute, down: 12000000, up: 600, upSeconds: 6 }
  ], minute + 1000, 5 * MINUTE);
  assert.equal(series.at(-1).down, null);
  assert.equal(series.at(-1).up, 100);
});

test('updating a legacy minute preserves unknown duration instead of inventing 60 seconds', async () => {
  const { historySpeedSeries, historyActiveSeconds } = loadSpeed();
  const minute = Math.floor(1700000000000 / MINUTE) * MINUTE;
  const id = 'example.com|' + minute;
  const saved = new Map([[id, { id, target: 'example.com', at: minute, down: 12000000, up: 0 }]]);
  const db = {
    transaction: () => ({ objectStore: () => ({
      get: key => {
        const request = { result: saved.get(key) };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
      put: value => saved.set(value.id, value)
    }) })
  };
  const addHistorySample = new Function('historyBuckets', 'historyDb', 'historyActiveSeconds',
    extractFunction('addHistorySample') + '\nreturn addHistorySample;')(new Map(), db, historyActiveSeconds);
  addHistorySample('example.com', minute + 1000, 600, 600, 6, 6);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.get(id).down, 12000600);
  assert.equal(saved.get(id).downSeconds, null);
  assert.equal(saved.get(id).upSeconds, 6);
  const point = historySpeedSeries([saved.get(id)], minute + 1000, 5 * MINUTE).at(-1);
  assert.equal(point.down, null);
  assert.equal(point.up, 100);
});

test('a selected range keeps the averaging warm-up before its first visible minute', () => {
  const { historySpeedSeries } = loadSpeed();
  const now = Math.floor(1700000000000 / MINUTE) * MINUTE;
  const first = now - 59 * MINUTE;
  const series = historySpeedSeries([
    { at: first - MINUTE, down: 1200, up: 0, downSeconds: 6, upSeconds: 0 },
    { at: first, down: 600, up: 600, downSeconds: 6, upSeconds: 3 }
  ], now, 5 * MINUTE, 60 * MINUTE);
  assert.equal(series[0].at, first);
  assert.equal(series[0].down, 150);
  assert.equal(series[0].up, 200);
});
