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

function loadRates() {
  const code = [extractFunction('windowRates'), extractFunction('trimRateSamples')].join('\n');
  return new Function(`${code}\nreturn { windowRates, trimRateSamples };`)();
}

function loadWindow() {
  const mapMatch = source.match(/const AVERAGE_WINDOWS = (\{[^}]*\});/);
  const defaultMatch = source.match(/const DEFAULT_AVERAGE_WINDOW = '([^']+)';/);
  assert.ok(mapMatch, 'AVERAGE_WINDOWS map not found');
  assert.ok(defaultMatch, 'DEFAULT_AVERAGE_WINDOW not found');
  const windows = new Function('return ' + mapMatch[1])();
  const fallback = defaultMatch[1];
  const factory = new Function('fields', 'AVERAGE_WINDOWS', 'DEFAULT_AVERAGE_WINDOW',
    `${extractFunction('averageWindowMs')}\nreturn averageWindowMs;`);
  return {
    windows,
    fallback,
    millisecondsFor: value => factory({ avgWindow: { value } }, windows, fallback)()
  };
}

test('average and peak use only samples inside the selected window', () => {
  const { windowRates } = loadRates();
  const now = 1000000;
  const samples = [
    { at: now - 300000, down: 9000, up: 9000, elapsed: 1 },
    { at: now - 1000, down: 100, up: 50, elapsed: 1 }
  ];
  assert.deepEqual(windowRates(samples, now - 120000), { down: 100, up: 50, peakDown: 100, peakUp: 50 });
  assert.deepEqual(windowRates(samples, now - 600000), { down: 9100 / 2, up: 9050 / 2, peakDown: 9000, peakUp: 9000 });
});

test('a sample exactly on the cutoff is included, older ones are not', () => {
  const { windowRates } = loadRates();
  const samples = [
    { at: 999, down: 1000, up: 0, elapsed: 1 },
    { at: 1000, down: 200, up: 0, elapsed: 1 }
  ];
  assert.deepEqual(windowRates(samples, 1000), { down: 200, up: null, peakDown: 200, peakUp: null });
});

test('each direction has its own active-second denominator and idle seconds are excluded', () => {
  const { windowRates } = loadRates();
  const samples = [
    { at: 1000, down: 100, up: 0, elapsed: 1 },
    { at: 2000, down: 100, up: 0, elapsed: 1 },
    { at: 3000, down: 0, up: 30, elapsed: 1 },
    { at: 4000, down: 0, up: 0, elapsed: 1 },
    { at: 5000, down: 0, up: 0, elapsed: 1 }
  ];
  assert.deepEqual(windowRates(samples, 0), { down: 100, up: 30, peakDown: 100, peakUp: 30 });
});

test('seconds and peaks are normalized by the real poll interval', () => {
  const { windowRates } = loadRates();
  const samples = [
    { at: 2000, down: 400, up: 0, elapsed: 2 },
    { at: 3000, down: 0, up: 0, elapsed: 1 }
  ];
  assert.deepEqual(windowRates(samples, 0), { down: 200, up: null, peakDown: 200, peakUp: null });
});

test('a direction without traffic in the window has no average and no peak', () => {
  const { windowRates } = loadRates();
  assert.deepEqual(windowRates([], 0), { down: null, up: null, peakDown: null, peakUp: null });
  assert.deepEqual(windowRates([{ at: 1000, down: 0, up: 0, elapsed: 1 }], 0), { down: null, up: null, peakDown: null, peakUp: null });
  assert.deepEqual(windowRates([{ at: 1000, down: 20, up: 0, elapsed: 1 }], 5000), { down: null, up: null, peakDown: null, peakUp: null });
});

test('peak is the highest single-sample rate, not the window average', () => {
  const { windowRates } = loadRates();
  const samples = [
    { at: 1000, down: 900, up: 10, elapsed: 1 },
    { at: 2000, down: 100, up: 40, elapsed: 1 },
    { at: 3000, down: 0, up: 0, elapsed: 1 }
  ];
  const rates = windowRates(samples, 0);
  assert.equal(rates.down, 500);
  assert.equal(rates.peakDown, 900);
  assert.equal(rates.peakUp, 40);
});

test('an old peak expires as soon as its sample leaves the window', () => {
  const { windowRates } = loadRates();
  const samples = [
    { at: 1000, down: 900, up: 0, elapsed: 1 },
    { at: 120000, down: 100, up: 0, elapsed: 1 },
    { at: 121000, down: 100, up: 0, elapsed: 1 }
  ];
  assert.equal(windowRates(samples, 0).peakDown, 900);
  assert.equal(windowRates(samples, 120000).peakDown, 100);
  assert.equal(windowRates(samples, 122000).peakDown, null);
});

test('trimRateSamples keeps only the longest selectable window', () => {
  const { trimRateSamples } = loadRates();
  const samples = [0, 100, 200, 300, 400].map(at => ({ at, down: 1, up: 1, elapsed: 1 }));
  trimRateSamples(samples, 300);
  assert.deepEqual(samples.map(sample => sample.at), [300, 400]);
  trimRateSamples(samples, 10000);
  assert.equal(samples.length, 0);
});

test('the settings window offers 2, 5 and 10 minutes with 5 minutes as default', () => {
  const { windows, fallback, millisecondsFor } = loadWindow();
  assert.deepEqual(windows, { '2分钟': 120000, '5分钟': 300000, '10分钟': 600000 });
  assert.equal(fallback, '5分钟');
  assert.equal(millisecondsFor('2分钟'), 120000);
  assert.equal(millisecondsFor('5分钟'), 300000);
  assert.equal(millisecondsFor('10分钟'), 600000);
  assert.equal(millisecondsFor('invalid'), 300000);
  assert.match(source, /<select id="avgWindow">[\s\S]*?<option value="5分钟" selected>/);
  assert.match(source, /avgWindow: values\.avgWindow/);
  assert.match(source, /avgWindow: fields\.avgWindow\.value/);
  assert.match(source, /Object\.keys\(AVERAGE_WINDOWS\)\.includes\(stored\.avgWindow\)/);
  assert.match(source, /window\.addEventListener\('storage'/);
});

test('both displayed modes come from the same windowed sample set, with no session-wide state', () => {
  assert.match(source, /metric\.rateSamples\.push\(\{ at: now, down: delta\.down, up: delta\.up, elapsed \}\)/);
  assert.match(source, /trimRateSamples\(metric\.rateSamples, now - MAX_AVERAGE_WINDOW_MS\)/);
  assert.match(source, /const rates = currentRates\(metric\)/);
  assert.match(source, /formatRate\(peakMode \? rates\.peakDown : rates\.down\)/);
  assert.match(source, /formatRate\(peakMode \? rates\.peakUp : rates\.up\)/);
  assert.doesNotMatch(source, /sessionDown|activeSeconds|metric\.avgDown\s*=|Math\.max\(metric\.peakDown|metric\.samples/);
});
