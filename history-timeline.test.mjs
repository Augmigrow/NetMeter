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

const zoom = new Function([
  ...['historySpanWidth', 'historyZoomSpan', 'historyZoomPosition', 'historyViewportBounds'].map(extract),
  'return { historySpanWidth, historyZoomSpan, historyZoomPosition, historyViewportBounds };'
].join('\n'))();

test('visible spans are validated and remembered separately for both charts', () => {
  const read = new Function('localStorage', "const HISTORY_SPANS_KEY = 'netmeter-history-visible-spans';" + extract('storedHistoryVisibleSpans') + '; return storedHistoryVisibleSpans();');
  assert.deepEqual(read({ getItem: () => JSON.stringify({ traffic: 3600000, speed: 300000 }) }), { traffic: 3600000, speed: 300000 });
  for (const value of [null, 'bad json', '[]', 'null', '{"traffic":0,"speed":"60000"}', '{"traffic":-1,"speed":999999999999}']) {
    assert.deepEqual(read({ getItem: () => value }), { traffic: null, speed: null });
  }
  assert.deepEqual(read({ getItem: () => { throw Error('disabled'); } }), { traffic: null, speed: null });
  assert.match(source, /localStorage\.setItem\(HISTORY_SPANS_KEY, JSON\.stringify\(historyVisibleSpans\)\)/);
});

test('Ctrl-wheel in/out changes only the visible span and clamps to resolution/full range', () => {
  const { historyZoomSpan } = zoom;
  assert.ok(historyZoomSpan(60 * minute, -100, 5 * minute, 1440 * minute) < 60 * minute);
  assert.ok(historyZoomSpan(60 * minute, 100, 5 * minute, 1440 * minute) > 60 * minute);
  assert.equal(historyZoomSpan(5 * minute, -1000, 5 * minute, 1440 * minute), 5 * minute);
  assert.equal(historyZoomSpan(1440 * minute, 1000, 5 * minute, 1440 * minute), 1440 * minute);
  assert.equal(historyZoomSpan(59 * minute, -1000, 60 * minute, 59 * minute), 59 * minute);
  assert.equal(historyZoomSpan(60 * minute, 0, 5 * minute, 1440 * minute), 60 * minute);
});

test('zoom preserves the cursor time across a wide range of positions and scales', () => {
  const { historyZoomPosition } = zoom;
  for (const oldWidth of [356, 768, 5756, 172796]) {
    for (const ratio of [.25, .5, .75]) {
      for (const anchor of [0, 89, 178, 356]) {
        const left = (oldWidth - 356) * ratio;
        const newWidth = oldWidth * 1.5;
        const next = historyZoomPosition(oldWidth, newWidth, 356, left, anchor);
        assert.ok(Math.abs((left + anchor) / oldWidth - (next + anchor) / newWidth) < 1e-10);
      }
    }
  }
  assert.equal(historyZoomPosition(5756, 356, 356, 5000, 178), 0);
  assert.equal(historyZoomPosition(768, 400, 356, 412, 356), 44);
  assert.equal(historyZoomPosition(768, 400, 356, 0, 0), 0);
});

test('saved zoom does not change total range and restores after visiting a shorter range', () => {
  const { historySpanWidth } = zoom;
  const preferred = 120 * minute;
  assert.equal(historySpanWidth(59 * minute, preferred, 5 * minute, 356, 356), 356);
  assert.equal(historySpanWidth(359 * minute, preferred, 5 * minute, 356, 1436), Math.round(359 / 120 * 356));
  assert.equal(historySpanWidth(1439 * minute, preferred, 5 * minute, 356, 5756), Math.round(1439 / 120 * 356));
  assert.equal(historySpanWidth(1439 * minute, null, 5 * minute, 356, 5756), 5756);
  assert.equal(historySpanWidth(1439 * minute, 5 * minute, 60 * minute, 356, 768), Math.round(1439 / 60 * 356));
});

test('visible date boundaries follow scrolling and fit-to-range correctly', () => {
  const { historyViewportBounds } = zoom;
  assert.deepEqual(historyViewportBounds(0, 1000, 1000, 200, 300), { start: 300, end: 500 });
  assert.deepEqual(historyViewportBounds(0, 1000, 1000, 200, 10000), { start: 800, end: 1000 });
  assert.deepEqual(historyViewportBounds(0, 1000, 200, 200, 0), { start: 0, end: 1000 });
});

test('visible span formatting is bilingual, compact, and never reports zero minutes', () => {
  const format = new Function('language', 't', extract('historyDurationLabel') + '; return historyDurationLabel;');
  const t = (key, vars) => vars.value + ({ Day: 'd', Hour: 'h', Minute: 'm' }[key.replace('history.duration', '')]);
  assert.equal(format('en', t)(89 * minute), '1h 29m');
  assert.equal(format('en', t)(43199 * minute), '29d 23h 59m');
  assert.equal(format('en', t)(0), '1m');
  assert.equal(format('zh', t)(89 * minute), '1h29m');
});

test('zoom resizes the existing plot without replacing or re-aggregating its samples', () => {
  const handler = extract('zoomHistoryViewport');
  assert.match(handler, /event\.preventDefault\(\)/);
  assert.match(handler, /sizeHistoryTimeline/);
  assert.doesNotMatch(handler, /drawHistory\(|drawHistorySpeed\(|historySpeedSeries\(/);
  assert.match(source, /if \(event\.ctrlKey\) \{ zoomHistoryViewport\(event\); return; \}/);
  assert.match(extract('updateHistoryAxis'), /historyScroll\.scrollLeft/);
});


test('the minute cursor uses subpixel-safe precision even at maximum 30-day zoom', () => {
  assert.match(extract('bindHistorySpeedHover'), /historySpeedX\(index, series\.length\)\.toFixed\(5\)/);
});
