import { TILE_GAP, TILE_HEIGHT, TILE_WIDTH } from './drag-geometry.mjs';

export { TILE_GAP };
export const TILE_MARGIN = 24;

export function defaultTilePosition(index, workArea) {
  const columns = Math.min(2, Math.max(1, Math.floor((workArea.width - TILE_MARGIN * 2 + TILE_GAP) / (TILE_WIDTH + TILE_GAP))));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: workArea.x + TILE_MARGIN + column * (TILE_WIDTH + TILE_GAP),
    y: workArea.y + TILE_MARGIN + row * (TILE_HEIGHT + TILE_GAP)
  };
}
