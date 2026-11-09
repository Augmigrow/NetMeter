// Pure desktop-DIP geometry for independent tile dragging and real snapping.
//
// The module deliberately knows nothing about Electron, the DOM or any process
// state: rectangles are immutable values in logical desktop pixels, so the
// snapping rules can be exercised on their own.

export const TILE_WIDTH = 180;
export const TILE_HEIGHT = 148;
export const TILE_GAP = 8;

// Allow a local row/column alignment without requiring overlapping cards.
// This is an orthogonal search distance, not a displacement or snap threshold.
export const ALIGNMENT_REACH = 32;

// Entry and release thresholds live together so the hysteresis band stays
// explicit: a target is acquired within 8px and only released once the raw
// pointer rectangle drifts more than 12px away from the applied position.
export const SNAP_ENTRY = 8;
export const SNAP_RELEASE = 12;

// Edge preference order used to break ties between equally distant candidates.
export const EDGE_ORDER = ['left-left', 'right-right', 'left-right', 'right-left', 'left-right-gap', 'right-left-gap'];
export const Y_EDGE_ORDER = ['top-top', 'bottom-bottom', 'top-bottom', 'bottom-top', 'top-bottom-gap', 'bottom-top-gap'];

export function rect(x, y, width = TILE_WIDTH, height = TILE_HEIGHT) {
  return { x, y, width, height };
}

export function right(value) {
  return value.x + value.width;
}

export function bottom(value) {
  return value.y + value.height;
}

function intervalGap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, bStart - aEnd, aStart - bEnd);
}

export function sameRect(a, b) {
  return Boolean(a) && Boolean(b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function edgeRank(candidate) {
  const order = candidate.axis === 'y' ? Y_EDGE_ORDER : EDGE_ORDER;
  const index = order.indexOf(candidate.edge);
  return index === -1 ? order.length : index;
}

function compareCandidates(a, b) {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  const edge = edgeRank(a) - edgeRank(b);
  if (edge !== 0) return edge;
  return a.value - b.value;
}

// A small vertical gap still permits X alignment. Distant rows remain excluded.
export function xCandidates(raw, neighbors) {
  const candidates = [];
  for (const neighbor of neighbors || []) {
    if (!neighbor || !Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) continue;
    if (intervalGap(raw.y, bottom(raw), neighbor.y, bottom(neighbor)) > ALIGNMENT_REACH) continue;
    const options = [
      { edge: 'left-left', value: neighbor.x, guide: 0 },
      { edge: 'right-right', value: right(neighbor) - raw.width, guide: raw.width },
      { edge: 'left-right', value: right(neighbor), guide: 0 },
      { edge: 'right-left', value: neighbor.x - raw.width, guide: raw.width },
      { edge: 'left-right-gap', value: right(neighbor) + TILE_GAP, guide: 0 },
      { edge: 'right-left-gap', value: neighbor.x - raw.width - TILE_GAP, guide: raw.width }
    ];
    for (const option of options) {
      candidates.push({
        axis: 'x',
        key: neighbor.key,
        edge: option.edge,
        value: option.value,
        distance: Math.abs(option.value - raw.x),
        guide: option.guide
      });
    }
  }
  return candidates.sort(compareCandidates);
}

// The same local search applies independently to Y across horizontal gaps.
export function yCandidates(raw, neighbors) {
  const candidates = [];
  for (const neighbor of neighbors || []) {
    if (!neighbor || !Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) continue;
    if (intervalGap(raw.x, right(raw), neighbor.x, right(neighbor)) > ALIGNMENT_REACH) continue;
    const options = [
      { edge: 'top-top', value: neighbor.y, guide: 0 },
      { edge: 'bottom-bottom', value: bottom(neighbor) - raw.height, guide: raw.height },
      { edge: 'top-bottom', value: bottom(neighbor), guide: 0 },
      { edge: 'bottom-top', value: neighbor.y - raw.height, guide: raw.height },
      { edge: 'top-bottom-gap', value: bottom(neighbor) + TILE_GAP, guide: 0 },
      { edge: 'bottom-top-gap', value: neighbor.y - raw.height - TILE_GAP, guide: raw.height }
    ];
    for (const option of options) {
      candidates.push({
        axis: 'y',
        key: neighbor.key,
        edge: option.edge,
        value: option.value,
        distance: Math.abs(option.value - raw.y),
        guide: option.guide
      });
    }
  }
  return candidates.sort(compareCandidates);
}

function resolveAxis(rawValue, candidates, lock, entry, release) {
  if (lock) {
    // The current target stays selected while it is still eligible, so equal
    // candidates cannot make the tile alternate between two alignments.
    const current = candidates.find(candidate => candidate.key === lock.key &&
      candidate.edge === lock.edge && candidate.value === lock.value);
    if (current && Math.abs(rawValue - lock.value) <= release) return { value: lock.value, lock: current };
  }
  const best = candidates.find(candidate => candidate.distance <= entry);
  return best ? { value: best.value, lock: best } : { value: rawValue, lock: null };
}

// Resolves the raw pointer rectangle into the rectangle that should actually
// be applied. X and Y are independent, the neighbour snapshot is only read,
// and the returned locks feed the next call so a target can be held stable.
export function resolveSnap({ raw, neighbors, locks, entry = SNAP_ENTRY, release = SNAP_RELEASE }) {
  const previous = locks || { x: null, y: null };
  const candidatesX = xCandidates(raw, neighbors);
  const candidatesY = yCandidates(raw, neighbors);
  const axisX = resolveAxis(raw.x, candidatesX, previous.x, entry, release);
  const axisY = resolveAxis(raw.y, candidatesY, previous.y, entry, release);
  return {
    rect: { x: axisX.value, y: axisY.value, width: raw.width, height: raw.height },
    locks: { x: axisX.lock, y: axisY.lock },
    guides: { x: axisX.lock ? axisX.lock.guide : null, y: axisY.lock ? axisY.lock.guide : null }
  };
}

// The displacement a plain group drag applies to every visible tile.
export function groupDisplacement(start, target) {
  return { x: Math.round(target.x - start.x), y: Math.round(target.y - start.y) };
}
