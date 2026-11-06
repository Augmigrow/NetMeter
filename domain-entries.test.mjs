import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('Unbalanced function ' + name);
}

const normalize = new Function(extractFunction('normalizeDomainEntries') + '\nreturn normalizeDomainEntries;')();

test('old domain arrays migrate to selected editable entries', () => {
  assert.deepEqual(normalize({ domains: [' a.example ', 'https://b.example/path'] }), [
    { url: 'a.example', visible: true }, { url: 'https://b.example/path', visible: true }
  ]);
});

test('entry visibility survives normalization, including an empty or all-hidden list', () => {
  assert.deepEqual(normalize({ domains: ['old.example'], domainEntries: [] }), []);
  assert.deepEqual(normalize({ domainEntries: [{ url: 'hidden.example', visible: false }] }), [
    { url: 'hidden.example', visible: false }
  ]);
  assert.deepEqual(normalize({ domainEntries: [{ url: 'a.example' }] }), [{ url: 'a.example', visible: true }]);
});

test('migration ignores invalid entries and merges exact duplicates without losing selection', () => {
  assert.deepEqual(normalize({ domainEntries: [null, {}, 5, '', { url: 'a', visible: false }, { url: ' a ', visible: true }] }), [
    { url: 'a', visible: true }
  ]);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({ domains: 'not-an-array' }), []);
});

test('only selected entries render while hidden entries keep their layout order', () => {
  const entries = [{ url: 'a', visible: false }, { url: 'b', visible: true }];
  const getNames = new Function('readDomainEntries',
    'let meterOrder = ["b", "a"];\n' + extractFunction('targetNames') + '\nreturn targetNames;')(() => entries);
  assert.deepEqual(getNames(), ['b']);
  entries[0].visible = true;
  assert.deepEqual(getNames(), ['b', 'a']);
  entries.forEach(entry => { entry.visible = false; });
  assert.deepEqual(getNames(), []);
});

test('unchecked entries remain in the polling target set', () => {
  const getTracked = new Function('readValues', extractFunction('trackedTargetNames') + '\nreturn trackedTargetNames;')(
    () => ({ domains: ['shown.example', 'hidden.example', 'shown.example'] }));
  assert.deepEqual(getTracked(), ['shown.example', 'hidden.example']);
  const polling = source.slice(source.indexOf('async function pollConnections'), source.indexOf('async function startPolling'));
  assert.match(polling, /const targets = trackedTargetNames\(\)/);
});

test('ensuring visible tile positions preserves stored positions for hidden entries', () => {
  const api = new Function('meterPositions', extractFunction('validMeterPosition') + '\n' + extractFunction('ensureMeterPositions') +
    '\nreturn { ensureMeterPositions, positions: () => meterPositions };')({ hidden: { x: 100, y: 200 } });
  api.ensureMeterPositions(['shown']);
  assert.deepEqual(api.positions().hidden, { x: 100, y: 200 });
  assert.ok(api.positions().shown);
});

test('widget persistence keeps hidden entries and older totals without storing the controller secret', () => {
  let stored = { domainEntries: [{ url: 'hidden', visible: false }], historyTotals: { hidden: { down: 50, up: 20 }, removed: { down: 7, up: 3 } } };
  const storage = { getItem: () => JSON.stringify(stored), setItem: (_, value) => { stored = JSON.parse(value); } };
  const persist = new Function('localStorage', 'metrics', 'readValues',
    'const KEY = "test", view = "widget", meterOrder = [], meterPositions = {}; let saveTimer, lastPersistAt; ' +
    'const document = {getElementById: () => ({textContent: ""})}; const t = key => key; const clearTimeout = () => {}; const setTimeout = () => 0;\n' +
    extractFunction('persist') + '\nreturn persist;')(storage, new Map([['shown', { totalDown: 100, totalUp: 10 }]]), () => ({}));
  persist();
  assert.equal(stored.domainEntries[0].visible, false);
  assert.deepEqual(stored.historyTotals.hidden, { down: 50, up: 20 });
  assert.deepEqual(stored.historyTotals.removed, { down: 7, up: 3 });
  assert.deepEqual(stored.historyTotals.shown, { down: 100, up: 10 });
  assert.equal('controllerSecret' in stored, false);
});
