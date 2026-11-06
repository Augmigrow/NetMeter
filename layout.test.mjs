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

function loadLayout() {
  const code = [extractFunction('nearestAlignment'), extractFunction('settleMeterPosition')].join('\n');
  const factory = new Function('meterPositions', `${code}\nreturn { nearestAlignment, settleMeterPosition };`);
  const positions = {};
  const api = factory(positions);
  return { api, positions };
}

test('alignment only snaps within eight pixels on one axis', () => {
  const { api, positions } = loadLayout();
  Object.assign(positions, { a: { x: 0, y: 0 }, b: { x: 194, y: 0 } });
  assert.equal(api.nearestAlignment(190, [194]), 194);
  assert.equal(api.nearestAlignment(180, [194]), null);
  assert.equal(api.nearestAlignment(5, [0]), 0);
  assert.equal(api.nearestAlignment(20, [0]), null);
  assert.equal(api.nearestAlignment(9, [0]), null);
});

test('a dropped tile keeps the pointer position', () => {
  const { api } = loadLayout();
  assert.deepEqual(api.settleMeterPosition(190, 165), { x: 190, y: 165 });
  assert.deepEqual(api.settleMeterPosition(3, 160), { x: 3, y: 160 });
  assert.deepEqual(api.settleMeterPosition(0, 0), { x: 0, y: 0 });
});

test('a dropped tile is never pulled onto a neighbour axis', () => {
  const { api, positions } = loadLayout();
  Object.assign(positions, { a: { x: 0, y: 0 }, b: { x: 194, y: 0 }, c: { x: 0, y: 162 } });
  assert.deepEqual(api.settleMeterPosition(5, 165), { x: 5, y: 165 });
  assert.deepEqual(api.settleMeterPosition(190, 165), { x: 190, y: 165 });
  assert.deepEqual(api.settleMeterPosition(193, 2), { x: 193, y: 2 });
});

test('the dragged tile follows the pointer while dragging', () => {
  const drag = source.slice(source.indexOf('function applyMeterDrag'), source.indexOf('function moveMeter'));
  assert.match(drag, /const position = \{ x: positionX, y: positionY \};/);
  assert.doesNotMatch(drag, /alignedX \?\? positionX/);
  assert.match(drag, /verticalAlignmentGuide\.style\.left = alignedX \+ 'px';/);
  assert.match(drag, /horizontalAlignmentGuide\.style\.top = alignedY \+ 'px';/);
});

test('releasing a tile never rewrites its coordinates', () => {
  const finish = source.slice(source.indexOf('function finishMeterMove'), source.indexOf('function cancelMeterMove'));
  assert.match(finish, /settleMeterPosition\(raw\.x, raw\.y\)/);
  assert.doesNotMatch(finish, /resolveAlignedPosition/);
  assert.doesNotMatch(source, /resolveAlignedPosition/);
});
