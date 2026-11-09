import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, 'main.mjs'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} not found in main.mjs`);
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

// The layout store lives in the main process, so the renderer can never
// overwrite another tile with an old shared snapshot.
function layoutFixture() {
  const writes = [];
  const api = new Function('writeFile', 'layoutPath',
    'const LAYOUT_VERSION = 2;\n' +
    'let layoutWriteQueue = Promise.resolve();\n' +
    'let layout = { version: LAYOUT_VERSION, tiles: {} };\n' +
    'let legacyWidgetOrigin = null;\n' +
    extractFunction('writeLayout') + '\n' +
    extractFunction('persistTilePositions') + '\n' +
    extractFunction('migrateLegacyLayout') + '\n' +
    'return {\n' +
    '  persistTilePositions,\n' +
    '  migrateLegacyLayout,\n' +
    '  setLayout: value => { layout = value; },\n' +
    '  setOrigin: value => { legacyWidgetOrigin = value; },\n' +
    '  layout: () => layout\n' +
    '};')(
    async (_path, payload) => { writes.push(JSON.parse(payload)); },
    () => 'tile-layout.json');
  return { api, writes };
}

test('the layout store keeps versioned absolute tile positions', async () => {
  const { api, writes } = layoutFixture();
  await api.persistTilePositions({ alpha: { x: 120, y: -240 } });
  assert.deepEqual(writes, [{ version: 2, tiles: { alpha: { x: 120, y: -240 } } }]);
});

test('an unchanged position is not written again', async () => {
  const { api, writes } = layoutFixture();
  await api.persistTilePositions({ alpha: { x: 10, y: 20 } });
  await api.persistTilePositions({ alpha: { x: 10, y: 20 } });
  assert.equal(writes.length, 1, 'the redundant write is skipped');
});

test('layout writes are serialized so the last state wins', async () => {
  const { api, writes } = layoutFixture();
  const first = api.persistTilePositions({ alpha: { x: 1, y: 1 } });
  const second = api.persistTilePositions({ alpha: { x: 2, y: 2 } });
  await Promise.all([first, second]);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].tiles.alpha, { x: 1, y: 1 });
  assert.deepEqual(writes[1].tiles.alpha, { x: 2, y: 2 });
});

test('the legacy widget origin and renderer relative positions migrate into absolute coordinates', async () => {
  const { api, writes } = layoutFixture();
  api.setOrigin({ x: 300, y: 400 });
  assert.equal(api.migrateLegacyLayout({ alpha: { x: 10, y: 20 }, bravo: { x: 200, y: 0 } }), true);
  assert.deepEqual(api.layout().tiles, {
    alpha: { x: 310, y: 420 },
    bravo: { x: 500, y: 400 }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, 2);
});

test('the migration runs at most once and never overwrites an existing layout', () => {
  const { api } = layoutFixture();
  api.setOrigin({ x: 300, y: 400 });
  assert.equal(api.migrateLegacyLayout({ alpha: { x: 10, y: 20 } }), true);
  assert.equal(api.migrateLegacyLayout({ alpha: { x: 999, y: 999 } }), false, 'a second migration is refused');
  assert.deepEqual(api.layout().tiles, { alpha: { x: 310, y: 420 } });
});

test('a migration without a legacy origin or positions changes nothing', () => {
  const { api } = layoutFixture();
  assert.equal(api.migrateLegacyLayout({ alpha: { x: 10, y: 20 } }), false);
  api.setOrigin({ x: 10, y: 10 });
  assert.equal(api.migrateLegacyLayout(null), false);
  assert.deepEqual(api.layout().tiles, {});
});

test('invalid positions are ignored by the layout store', async () => {
  const { api, writes } = layoutFixture();
  await api.persistTilePositions({ alpha: { x: Number.NaN, y: 10 }, bravo: { x: 5, y: 6 } });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].tiles, { bravo: { x: 5, y: 6 } }, 'the invalid position is dropped');
});
