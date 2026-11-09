import { TILE_HEIGHT, TILE_WIDTH } from './drag-geometry.mjs';

export const TILE_WINDOW_PADDING = 6;
export const TILE_SHADOW_HIT_INSET = 3;

function cornerInset(radius, row) {
  if (!radius) return 0;
  const distance = radius - row - 0.5;
  if (distance <= 0) return 0;
  return Math.max(0, Math.ceil(radius - Math.sqrt(radius * radius - distance * distance)));
}

export function roundedRectangleRegion({ x, y, width, height, radius }) {
  if (![x, y, width, height, radius].every(Number.isFinite) || width <= 0 || height <= 0) return [];
  const r = Math.min(Math.max(0, Math.floor(radius)), Math.floor(width / 2), Math.floor(height / 2));
  const rects = [];
  for (let row = 0; row < height; row += 1) {
    const inset = Math.max(
      row < r ? cornerInset(r, row) : 0,
      row >= height - r ? cornerInset(r, height - 1 - row) : 0
    );
    const rect = { x: x + inset, y: y + row, width: width - inset * 2, height: 1 };
    const previous = rects.at(-1);
    if (previous && previous.x === rect.x && previous.width === rect.width) previous.height += 1;
    else rects.push(rect);
  }
  return rects;
}

export const TILE_WINDOW_INPUT_REGION = roundedRectangleRegion({
  x: TILE_SHADOW_HIT_INSET,
  y: TILE_SHADOW_HIT_INSET,
  width: TILE_WIDTH + TILE_WINDOW_PADDING * 2 - TILE_SHADOW_HIT_INSET * 2,
  height: TILE_HEIGHT + TILE_WINDOW_PADDING * 2 - TILE_SHADOW_HIT_INSET * 2,
  radius: 7 + TILE_SHADOW_HIT_INSET
});

export function historyWindowInputRegion(width, height) {
  return roundedRectangleRegion({ x: 0, y: 0, width, height, radius: 7 });
}
