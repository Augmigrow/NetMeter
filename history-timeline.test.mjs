import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
}
const rangeCode = source.match(/const HISTORY_RANGES = [^;]+;/)[0];
const { historyRangeBounds, historyTrafficSeries, historyTimelineWidth } = new Function([
  extract('historyRangeBounds'), extract('historyTrafficSeries'), extract('historyTimelineWidth'),
  'return { historyRangeBounds, historyTrafficSeries, historyTimelineWidth };'
].join('\n'))();
const minute = 60000;
const now = Math.floor(1700000000000 / minute) * minute;

test('the chosen range is remembered independently from the history tab and settings', () => {
  const read = new Function('localStorage', rangeCode + "const HISTORY_RANGE_KEY = 'netmeter-history-range';" + extract('storedHistoryRange') + ';return storedHistoryRange();');
  for (const value of ['1h', '6h', '24h', '7d', '30d']) assert.equal(read({ getItem: () => value }), value);
  for (const value of [null, 'bad', '__proto__']) assert.equal(read({ getItem: () => value }), '24h');
  assert.equal(read({ getItem: () => { throw Error('disabled'); } }), '24h');
  assert.match(source, /localStorage\.setItem\(HISTORY_RANGE_KEY, historyRange\)/);
});

test('minute range boundaries include the current minute without compressing empty periods', () => {
  const bounds = historyRangeBounds(now + 1234, 60 * minute);
  assert.deepEqual(bounds, { start: now - 59 * minute, last: now, count: 60 });
  assert.equal(historyRangeBounds(now, 30 * 86400000).count, 43200);
});

test('hourly traffic retains byte totals and excludes samples before and after the range', () => {
  const samples = [
    { at: now - 24 * 60 * minute, down: 9999, up: 9999 },
    { at: now - 1439 * minute, down: 1000, up: 200 },
    { at: now, down: 3000, up: 400 },
    { at: now + minute, down: 9999, up: 9999 }
  ];
  const series = historyTrafficSeries(samples, now, 24 * 60 * minute);
  assert.equal(series.buckets.length, 24);
  assert.equal(series.bucketMs, 60 * minute);
  assert.equal(series.buckets.reduce((sum, point) => sum + point.down, 0), 4000);
  assert.equal(series.buckets.reduce((sum, point) => sum + point.up, 0), 600);
  assert.equal(series.buckets[0].down, 1000);
  assert.equal(series.buckets.at(-1).down, 3000);
});

test('short spans use five-minute traffic bars and long spans keep hourly detail', () => {
  assert.equal(historyTrafficSeries([], now, 60 * minute).buckets.length, 12);
  assert.equal(historyTrafficSeries([], now, 6 * 60 * minute).buckets.length, 72);
  assert.equal(historyTrafficSeries([], now, 7 * 86400000).buckets.length, 168);
  assert.equal(historyTrafficSeries([], now, 30 * 86400000).buckets.length, 720);
});

test('minute points have fixed readable spacing, including the 30-day timeline', () => {
  assert.equal(historyTimelineWidth(60, 4, 356), 356);
  assert.equal(historyTimelineWidth(1440, 4, 356), 5756);
  assert.equal(historyTimelineWidth(43200, 4, 356), 172796);
  assert.match(source, /historySpeedX\(index, series\.length\)\.toFixed\(5\)/);
});

test('only the timeline scrolls; stale asynchronous history loads are discarded', () => {
  assert.match(source, /id="historyScroll"[^>]*tabindex="0"/);
  assert.match(source, /overflow-x: auto; overflow-y: hidden/);
  assert.match(source, /version !== historyLoadVersion/);
  assert.match(source, /event\.deltaY/);
  assert.match(source, /event\.key !== 'Home'/);
});
