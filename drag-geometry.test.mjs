import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALIGNMENT_REACH,
  SNAP_ENTRY,
  SNAP_RELEASE,
  TILE_HEIGHT,
  TILE_WIDTH,
  rect,
  resolveSnap,
  xCandidates,
  yCandidates
} from './drag-geometry.mjs';

const tile = (key, x, y) => ({ key, ...rect(x, y) });

test('the entry threshold is eight logical pixels and inclusive', () => {
  const neighbour = tile('b', 100, 0);
  const raw = rect(108, 0);
  const snapped = resolveSnap({ raw, neighbors: [neighbour], locks: {} });
  assert.equal(snapped.rect.x, 100, 'eight pixels away snaps');
  const far = resolveSnap({ raw: rect(109, 0), neighbors: [neighbour], locks: {} });
  assert.equal(far.rect.x, 109, 'nine pixels away does not snap');
  assert.equal(SNAP_ENTRY, 8);
});

test('a distant tile sharing one axis is never a candidate', () => {
  const neighbour = tile('far', 100, 4000);
  const raw = rect(103, 0);
  const snapped = resolveSnap({ raw, neighbors: [neighbour], locks: {} });
  assert.equal(snapped.rect.x, 103, 'no vertical overlap means no X candidate');
  assert.equal(snapped.rect.y, 0);
  const inverse = resolveSnap({ raw: rect(0, 403), neighbors: [tile('far', 4000, 100)], locks: {} });
  assert.equal(inverse.rect.y, 403, 'no horizontal overlap means no Y candidate');
  assert.equal(inverse.rect.x, 0);
});

test('touching edges count as overlap for the orthogonal filter', () => {
  const neighbour = tile('b', 100, TILE_HEIGHT);
  const snapped = resolveSnap({ raw: rect(103, 0), neighbors: [neighbour], locks: {} });
  assert.equal(snapped.rect.x, 100, 'a tile that only touches vertically may align on X');
});

test('X and Y snap independently', () => {
  const snapped = resolveSnap({ raw: rect(104, 296), neighbors: [tile('b', 100, 300)], locks: {} });
  assert.equal(snapped.rect.x, 100, 'X snaps to the neighbour');
  assert.equal(snapped.rect.y, 300, 'Y snaps to the same neighbour');
  assert.equal(snapped.guides.x, 0);
  assert.equal(snapped.guides.y, 0);
});

test('a single axis can snap while the other stays free', () => {
  const snapped = resolveSnap({ raw: rect(104, 50), neighbors: [tile('b', 100, 0)], locks: {} });
  assert.equal(snapped.rect.x, 100);
  assert.equal(snapped.rect.y, 50, 'the free axis keeps the raw pointer position');
  assert.equal(snapped.guides.y, null);
  const onlyY = resolveSnap({ raw: rect(50, 104), neighbors: [tile('b', 0, 100)], locks: {} });
  assert.equal(onlyY.rect.x, 50, 'the free axis keeps the raw pointer position');
  assert.equal(onlyY.rect.y, 100);
  assert.equal(onlyY.guides.x, null);
});

test('separated tiles align on X without pulling the free Y axis', () => {
  for (const direction of [-1, 1]) {
    const y = direction * (TILE_HEIGHT + 24);
    const result = resolveSnap({ raw: rect(104, y), neighbors: [tile('b', 100, 0)] });
    assert.deepEqual(result.rect, rect(100, y));
    assert.deepEqual(result.guides, { x: 0, y: null });
  }
});

test('separated tiles align on Y without pulling the free X axis', () => {
  for (const direction of [-1, 1]) {
    const x = direction * (TILE_WIDTH + 24);
    const result = resolveSnap({ raw: rect(x, 104), neighbors: [tile('b', 0, 100)] });
    assert.deepEqual(result.rect, rect(x, 100));
    assert.deepEqual(result.guides, { x: null, y: 0 });
  }
});

test('alignment preserves the default eight pixel gap instead of closing it', () => {
  const below = rect(104, TILE_HEIGHT + 8);
  const vertical = resolveSnap({ raw: below, neighbors: [tile('b', 100, 0)] });
  assert.deepEqual(vertical.rect, rect(100, below.y));
  const beside = rect(TILE_WIDTH + 8, 104);
  const horizontal = resolveSnap({ raw: beside, neighbors: [tile('b', 0, 100)] });
  assert.deepEqual(horizontal.rect, rect(beside.x, 100));
});

test('facing edges can align into an adjacent column', () => {
  const neighbour = tile('b', 200, 0);
  const snapped = resolveSnap({ raw: rect(202, 0), neighbors: [neighbour], locks: {} });
  assert.equal(snapped.rect.x, 200);
  const adjacent = resolveSnap({ raw: rect(378, 0), neighbors: [neighbour], locks: {} });
  assert.equal(adjacent.rect.x, 380, 'the dragged right edge can meet the neighbour left edge');
  assert.equal(adjacent.guides.x, 0, 'the guide stays on the dragged tile surface');
  const onTheLeft = resolveSnap({ raw: rect(20, 0), neighbors: [neighbour], locks: {} });
  assert.equal(onTheLeft.rect.x, 20);
  assert.equal(onTheLeft.guides.x, TILE_WIDTH, 'the shared right edge guides on the dragged surface');
});

test('a held target stays selected until the raw rectangle drifts past the release band', () => {
  const neighbour = tile('b', 100, 0);
  const first = resolveSnap({ raw: rect(106, 0), neighbors: [neighbour], locks: {} });
  assert.equal(first.rect.x, 100);
  assert.ok(first.locks.x);
  const held = resolveSnap({ raw: rect(112, 0), neighbors: [neighbour], locks: first.locks });
  assert.equal(held.rect.x, 100, 'twelve pixels of drift keep the target');
  assert.equal(held.locks.x.key, 'b');
  const released = resolveSnap({ raw: rect(113, 0), neighbors: [neighbour], locks: first.locks });
  assert.equal(released.rect.x, 113, 'past the release band the tile follows the pointer again');
  assert.equal(released.locks.x, null);
  assert.equal(SNAP_RELEASE, 12);
});

test('equal candidates are broken by tile identity and then edge type', () => {
  const raw = rect(100, 0);
  const candidates = xCandidates(raw, [tile('b', 100, 0), tile('a', 100, 0)]);
  assert.equal(candidates[0].key, 'a', 'the stable tile identity decides');
  assert.equal(candidates[0].edge, 'left-left');
  const sameTile = xCandidates(raw, [tile('a', 100, 0)]);
  const edges = sameTile.map(candidate => candidate.edge);
  assert.deepEqual(edges, ['left-left', 'right-right', 'left-right', 'right-left', 'left-right-gap', 'right-left-gap']);
  const yEdges = yCandidates(raw, [tile('a', 0, 0)]).map(candidate => candidate.edge);
  assert.deepEqual(yEdges, ['top-top', 'bottom-bottom', 'top-bottom', 'bottom-top', 'top-bottom-gap', 'bottom-top-gap']);
});

test('a held target is not replaced by a closer candidate', () => {
  const neighbours = [tile('a', 100, 0), tile('b', 108, 0)];
  const first = resolveSnap({ raw: rect(104, 0), neighbors: neighbours, locks: {} });
  assert.equal(first.locks.x.key, 'a');
  const moved = resolveSnap({ raw: rect(110, 0), neighbors: neighbours, locks: first.locks });
  assert.equal(moved.locks.x.key, 'a', 'the current target stays while it is eligible');
  assert.equal(moved.rect.x, 100);
});

test('nearby separated candidates are bounded on both orthogonal axes', () => {
  for (const gap of [ALIGNMENT_REACH, ALIGNMENT_REACH + 1]) {
    const x = resolveSnap({ raw: rect(104, TILE_HEIGHT + gap), neighbors: [tile('b', 100, 0)] });
    assert.equal(x.rect.x, gap === ALIGNMENT_REACH ? 100 : 104);
    const y = resolveSnap({ raw: rect(TILE_WIDTH + gap, 104), neighbors: [tile('b', 0, 100)] });
    assert.equal(y.rect.y, gap === ALIGNMENT_REACH ? 100 : 104);
  }
});

test('a snap lock releases when its orthogonal neighbour leaves the local range', () => {
  const neighbour = tile('b', 100, 0);
  const first = resolveSnap({ raw: rect(106, 0), neighbors: [neighbour], locks: {} });
  const nearby = resolveSnap({ raw: rect(110, TILE_HEIGHT + 24), neighbors: [neighbour], locks: first.locks });
  assert.equal(nearby.rect.x, 100);
  assert.equal(nearby.rect.y, TILE_HEIGHT + 24, 'the free axis can move across a gap');
  const movedAway = resolveSnap({ raw: rect(110, TILE_HEIGHT + ALIGNMENT_REACH + 1), neighbors: [neighbour], locks: nearby.locks });
  assert.equal(movedAway.rect.x, 110, 'a stale X lock cannot pull a tile after vertical overlap ends');
  assert.equal(movedAway.locks.x, null);
  assert.equal(movedAway.guides.x, null);

  const yNeighbour = tile('c', 0, 100);
  const firstY = resolveSnap({ raw: rect(0, 106), neighbors: [yNeighbour], locks: {} });
  const movedSideways = resolveSnap({ raw: rect(TILE_WIDTH + ALIGNMENT_REACH + 1, 110), neighbors: [yNeighbour], locks: firstY.locks });
  assert.equal(movedSideways.rect.y, 110, 'a stale Y lock cannot pull a tile after horizontal overlap ends');
  assert.equal(movedSideways.locks.y, null);
  assert.equal(movedSideways.guides.y, null);
});

test('negative desktop coordinates keep working', () => {
  const neighbour = tile('b', -1900, -400);
  const snapped = resolveSnap({ raw: rect(-1894, -400), neighbors: [neighbour], locks: {} });
  assert.equal(snapped.rect.x, -1900);
  assert.equal(snapped.rect.y, -400);
});

test('the neighbour snapshot and the raw rectangle are never mutated', () => {
  const neighbours = [tile('b', 100, 0)];
  const snapshot = JSON.parse(JSON.stringify(neighbours));
  const raw = rect(104, 0);
  const rawCopy = { ...raw };
  resolveSnap({ raw, neighbors: neighbours, locks: {} });
  assert.deepEqual(neighbours, snapshot);
  assert.deepEqual(raw, rawCopy);
});

test('guides are reported for the geometry that was applied', () => {
  const snapped = resolveSnap({ raw: rect(104, 50), neighbors: [tile('b', 100, 0)], locks: {} });
  assert.equal(snapped.guides.x, 0);
  assert.equal(snapped.guides.y, null);
  const far = resolveSnap({ raw: rect(400, 900), neighbors: [tile('b', 100, 0)], locks: {} });
  assert.equal(far.guides.x, null);
  assert.equal(far.guides.y, null);
});

test('the tile size stays the designed 180 by 148 content box', () => {
  assert.equal(TILE_WIDTH, 180);
  assert.equal(TILE_HEIGHT, 148);
  const snapped = resolveSnap({ raw: rect(0, 0), neighbors: [], locks: {} });
  assert.equal(snapped.rect.width, 180);
  assert.equal(snapped.rect.height, 148);
});
