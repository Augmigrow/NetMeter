import assert from 'node:assert/strict';
import test from 'node:test';
import { TILE_GAP, defaultTilePosition } from './tile-layout.mjs';

test('new tile positions use the designed gap and avoid overlap', () => {
  const workArea = { x: -1920, y: 20, width: 1920, height: 1080 };
  const positions = Array.from({ length: 12 }, (_, index) => defaultTilePosition(index, workArea));
  assert.equal(positions[0].x, -1896);
  assert.equal(positions[1].x - (positions[0].x + 180), TILE_GAP);
  assert.equal(positions[2].y - (positions[0].y + 148), TILE_GAP);
  assert.equal(positions[2].x, positions[0].x);
  assert.equal(positions[3].y, positions[2].y);
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const horizontal = positions[i].x < positions[j].x + 180 && positions[j].x < positions[i].x + 180;
      const vertical = positions[i].y < positions[j].y + 148 && positions[j].y < positions[i].y + 148;
      assert.equal(horizontal && vertical, false, `tiles ${i} and ${j} do not overlap`);
    }
  }
});

test('narrow work areas keep one column and keep desktop coordinates', () => {
  assert.deepEqual(defaultTilePosition(1, { x: -200, y: -40, width: 200, height: 600 }), { x: -176, y: 140 });
});
