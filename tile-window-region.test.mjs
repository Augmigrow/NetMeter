import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TILE_SHADOW_HIT_INSET,
  TILE_WINDOW_INPUT_REGION,
  TILE_WINDOW_PADDING,
  historyWindowInputRegion,
  roundedRectangleRegion
} from './tile-window-region.mjs';

function contains(region, x, y) {
  return region.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}

test('the tile hit region contains the whole rounded card and excludes transparent outer corners', () => {
  for (let y = TILE_WINDOW_PADDING; y < TILE_WINDOW_PADDING + 148; y += 1) {
    for (let x = TILE_WINDOW_PADDING; x < TILE_WINDOW_PADDING + 180; x += 1) {
      const dx = Math.max(0, 7 - Math.min(x - TILE_WINDOW_PADDING, TILE_WINDOW_PADDING + 179 - x));
      const dy = Math.max(0, 7 - Math.min(y - TILE_WINDOW_PADDING, TILE_WINDOW_PADDING + 147 - y));
      if (dx * dx + dy * dy <= 49) assert.equal(contains(TILE_WINDOW_INPUT_REGION, x, y), true, `card pixel ${x},${y}`);
    }
  }
  assert.equal(contains(TILE_WINDOW_INPUT_REGION, 0, 0), false);
  assert.equal(contains(TILE_WINDOW_INPUT_REGION, 4, 4), false);
});

test('separate default tiles leave an input-transparent gap between their native regions', () => {
  const contentOrigin = 100;
  const firstWindowOrigin = contentOrigin - TILE_WINDOW_PADDING;
  const secondContentOrigin = contentOrigin + 188;
  const secondWindowOrigin = secondContentOrigin - TILE_WINDOW_PADDING;
  const firstRight = firstWindowOrigin + TILE_SHADOW_HIT_INSET + 186;
  const secondLeft = secondWindowOrigin + TILE_SHADOW_HIT_INSET;
  assert.equal(secondLeft - firstRight, 2);
  assert.equal(contains(TILE_WINDOW_INPUT_REGION, 189, 80), false);
});

test('history hit region covers its panel while preserving rounded transparent corners', () => {
  const region = historyWindowInputRegion(380, 306);
  assert.equal(contains(region, 190, 150), true);
  assert.equal(contains(region, 0, 0), false);
  assert.equal(contains(region, 3, 3), true);
});

test('rounded regions reject invalid dimensions and support an unrounded rectangle', () => {
  assert.deepEqual(roundedRectangleRegion({ x: 0, y: 0, width: 0, height: 10, radius: 3 }), []);
  assert.deepEqual(roundedRectangleRegion({ x: 2, y: 4, width: 3, height: 2, radius: 0 }), [
    { x: 2, y: 4, width: 3, height: 2 }
  ]);
});
