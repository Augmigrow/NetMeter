import assert from 'node:assert/strict';
import test from 'node:test';
import { createDragController } from './tile-drag.mjs';

// A fake host records every native window write, so the tests can prove which
// windows a gesture touched instead of only inspecting the resulting state.
function createHost(initial = {}) {
  const tiles = new Map(Object.entries(initial).map(([key, value]) => [key, {
    key,
    bounds: { x: value.x, y: value.y },
    historyOpen: Boolean(value.historyOpen)
  }]));
  const writes = [];
  const feedback = [];
  const committed = [];
  let cursor = { x: 0, y: 0 };
  const dragController = createDragController({
    listTiles: () => [...tiles.values()].map(tile => ({
      key: tile.key,
      bounds: { ...tile.bounds },
      historyOpen: tile.historyOpen
    })),
    moveTile: (key, x, y) => {
      writes.push({ key, x, y });
      const tile = tiles.get(key);
      if (tile) tile.bounds = { x, y };
    },
    cursorAt: () => ({ ...cursor }),
    feedback: (key, payload) => feedback.push({ key, ...payload }),
    commit: positions => committed.push(positions)
  });
  let currentGestureId = 0;
  const controller = {
    pointerDown(payload) {
      currentGestureId = payload.gestureId ?? `test-${currentGestureId + 1}`;
      return dragController.pointerDown({ ...payload, gestureId: currentGestureId });
    },
    pointerMove(payload) {
      return dragController.pointerMove({ ...payload, gestureId: payload.gestureId ?? currentGestureId });
    },
    pointerUp(payload) {
      return dragController.pointerUp({ ...payload, gestureId: payload.gestureId ?? currentGestureId });
    },
    modifier(payload) {
      return dragController.modifier({ ...payload, gestureId: payload.gestureId ?? currentGestureId });
    },
    get active() { return dragController.active; },
    get state() { return dragController.state; }
  };
  return {
    tiles,
    writes,
    feedback,
    committed,
    controller,
    setCursor: (x, y) => { cursor = { x, y }; },
    bounds: key => ({ ...tiles.get(key).bounds }),
    writesFor: key => writes.filter(write => write.key === key)
  };
}

const ALPHA = { x: 100, y: 100 };
const BRAVO = { x: 400, y: 100 };

test('a single drag writes only the dragged window', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(230, 180);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  assert.ok(host.writes.length > 0, 'the dragged window moves');
  assert.deepEqual([...new Set(host.writes.map(write => write.key))], ['alpha']);
  assert.deepEqual(host.writesFor('bravo'), [], 'no sibling geometry write happens');
  assert.deepEqual(host.bounds('bravo'), BRAVO, 'the sibling keeps its bounds');
});

test('a distant neighbour produces no candidate and no snap', () => {
  const host = createHost({ alpha: ALPHA, bravo: { x: 100, y: 1000 } });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(130, 140);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  const last = host.writesFor('alpha').at(-1);
  assert.deepEqual(last, { key: 'alpha', x: 100, y: 110 }, 'the tile follows the pointer without a snap');
  const guide = host.feedback.at(-1);
  assert.equal(guide.guides.x, null);
  assert.equal(guide.guides.y, null);
});

test('an eligible neighbour produces a real snap on the dragged window only', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  // The raw content origin lands two pixels before the neighbour's left edge.
  host.setCursor(428, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  const last = host.writesFor('alpha').at(-1);
  assert.equal(last.x, 400, 'the dragged tile aligns with the neighbour');
  assert.equal(last.y, 100);
  assert.deepEqual(host.writesFor('bravo'), [], 'the neighbour is never written');
  assert.equal(host.feedback.at(-1).guides.x, 0, 'the guide marks the aligned edge');
});

test('an X-only snap preserves the free Y coordinate', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(426, 154);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  assert.deepEqual(host.bounds('alpha'), { x: 400, y: 124 });
  assert.equal(host.feedback.at(-1).guides.x, 0);
  assert.equal(host.feedback.at(-1).guides.y, null);
  assert.deepEqual(host.bounds('bravo'), BRAVO);
});

test('a Y-only snap preserves the free X coordinate', () => {
  const host = createHost({ alpha: ALPHA, charlie: { x: 100, y: 600 } });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(154, 632);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  assert.deepEqual(host.bounds('alpha'), { x: 124, y: 600 });
  assert.equal(host.feedback.at(-1).guides.x, null);
  assert.equal(host.feedback.at(-1).guides.y, 0);
  assert.deepEqual(host.bounds('charlie'), { x: 100, y: 600 });
});

test('non-overlapping single-axis drags never write a sibling and commit the aligned position', () => {
  const cases = [
    { target: { x: 404, y: 272 }, expected: { x: 400, y: 272 }, guides: { x: 0, y: null } },
    { target: { x: 604, y: 104 }, expected: { x: 604, y: 100 }, guides: { x: null, y: 0 } }
  ];
  for (const { target, expected, guides } of cases) {
    const host = createHost({ alpha: ALPHA, bravo: BRAVO });
    host.setCursor(130, 130);
    host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
    for (let frame = 0; frame < 4; frame++) {
      host.setCursor(target.x + 30, target.y + 30);
      host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
      assert.deepEqual(host.bounds('alpha'), expected);
      assert.deepEqual(host.feedback.at(-1).guides, guides);
      assert.deepEqual(host.writesFor('bravo'), []);
    }
    host.controller.pointerUp({ key: 'alpha', pointerId: 1, cancelled: false });
    assert.deepEqual(host.committed, [{ alpha: { x: expected.x + 6, y: expected.y + 6 } }]);
  }
});

test('releasing keeps the snapped position instead of falling back to the pointer', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(428, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  host.controller.pointerUp({ key: 'alpha', pointerId: 1, cancelled: false });
  assert.deepEqual(host.committed, [{ alpha: { x: 406, y: 106 } }], 'the committed tile origin is the snapped one');
});

test('a plain drag moves every visible tile by the same displacement', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: false });
  host.setCursor(230, 230);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: false });
  assert.deepEqual(host.bounds('alpha'), { x: 200, y: 200 });
  assert.deepEqual(host.bounds('bravo'), { x: 500, y: 200 });
  assert.equal(host.bounds('bravo').x - host.bounds('alpha').x, 300, 'the relative position is unchanged');
});

test('ctrl before the mouse selects independent dragging', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(230, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  assert.deepEqual([...new Set(host.writes.map(write => write.key))], ['alpha']);
});

test('ctrl pressed after the mouse button selects independent dragging', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: false });
  host.controller.modifier({ key: 'alpha', ctrl: true });
  host.setCursor(230, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  assert.deepEqual([...new Set(host.writes.map(write => write.key))], ['alpha']);
});

test('ctrl during a group drag promotes to a single drag without moving the siblings back', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: false });
  host.setCursor(180, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: false });
  assert.deepEqual(host.bounds('alpha'), { x: 150, y: 100 });
  assert.deepEqual(host.bounds('bravo'), { x: 450, y: 100 });
  host.controller.modifier({ key: 'alpha', ctrl: true });
  const beforePromotion = host.bounds('alpha');
  host.setCursor(230, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  assert.deepEqual(host.bounds('bravo'), { x: 450, y: 100 }, 'the group motion is not undone');
  assert.notDeepEqual(host.bounds('alpha'), beforePromotion, 'the promoted drag continues from the current position');
  const writesAfterPromotion = host.writes.filter(write => write.key === 'bravo');
  assert.equal(writesAfterPromotion.length, 1, 'the sibling received only the group write');
});

test('cancelling restores only the affected objects', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(330, 230);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  host.controller.pointerUp({ key: 'alpha', pointerId: 1, cancelled: true });
  assert.deepEqual(host.bounds('alpha'), ALPHA, 'the dragged tile returns to its start position');
  assert.deepEqual(host.bounds('bravo'), BRAVO, 'the sibling never moved');
  assert.deepEqual(host.committed, [], 'a cancelled gesture is not committed');
});

test('cancelling a group drag restores every moved tile', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: false });
  host.setCursor(230, 230);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: false });
  host.controller.pointerUp({ key: 'alpha', pointerId: 1, cancelled: true });
  assert.deepEqual(host.bounds('alpha'), ALPHA);
  assert.deepEqual(host.bounds('bravo'), BRAVO);
});

test('late events after a finished gesture cannot move anything', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(230, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  host.controller.pointerUp({ key: 'alpha', pointerId: 1, cancelled: false });
  const writes = host.writes.length;
  host.setCursor(430, 130);
  assert.equal(host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true }), false);
  assert.equal(host.controller.pointerUp({ key: 'alpha', pointerId: 1, cancelled: false }), false);
  assert.equal(host.writes.length, writes, 'no late event writes geometry');
});

test('a stale event with a reused pointer id cannot affect the next gesture', () => {
  const host = createHost({ alpha: ALPHA, bravo: BRAVO });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, gestureId: 'gesture-a', ctrl: true });
  host.setCursor(230, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, gestureId: 'gesture-a', ctrl: true });
  host.controller.pointerUp({ key: 'alpha', pointerId: 1, gestureId: 'gesture-a', cancelled: false });

  host.setCursor(230, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, gestureId: 'gesture-b', ctrl: true });
  const writes = host.writes.length;
  host.setCursor(430, 130);
  assert.equal(host.controller.pointerMove({ key: 'alpha', pointerId: 1, gestureId: 'gesture-a', ctrl: true }), false);
  assert.equal(host.controller.pointerUp({ key: 'alpha', pointerId: 1, gestureId: 'gesture-a', cancelled: true }), false);
  assert.equal(host.writes.length, writes, 'stale events cannot move or cancel the current gesture');
  assert.equal(host.controller.active, true);
  assert.equal(host.controller.pointerMove({ key: 'alpha', pointerId: 1, gestureId: 'gesture-b', ctrl: true }), true);
});

test('a gesture from a window that owns no tile is rejected', () => {
  const host = createHost({ alpha: ALPHA });
  assert.equal(host.controller.pointerDown({ key: 'stranger', pointerId: 1, ctrl: true }), false);
  assert.equal(host.controller.pointerMove({ key: 'stranger', pointerId: 1, ctrl: true }), false);
  assert.deepEqual(host.writes, []);
});

test('a tile that opened its history is not a snap target', () => {
  const host = createHost({ alpha: ALPHA, bravo: { x: 400, y: 100, historyOpen: true } });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(328, 130);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  const last = host.writesFor('alpha').at(-1);
  assert.equal(last.x, 298, 'the enlarged history surface is not a candidate');
});

test('negative desktop coordinates are kept without scaling', () => {
  const host = createHost({ alpha: { x: -1000, y: -500 }, bravo: { x: -1900, y: -500 } });
  host.setCursor(-970, -470);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(-1870, -470);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  const last = host.writesFor('alpha').at(-1);
  assert.equal(last.x, -1900, 'the tile lands on the negative neighbour position');
  assert.equal(last.y, -500);
});

test('the grab offset survives a release and a following gesture', () => {
  const host = createHost({ alpha: ALPHA });
  host.setCursor(130, 130);
  host.controller.pointerDown({ key: 'alpha', pointerId: 1, ctrl: true });
  host.setCursor(180, 160);
  host.controller.pointerMove({ key: 'alpha', pointerId: 1, ctrl: true });
  host.controller.pointerUp({ key: 'alpha', pointerId: 1, cancelled: false });
  host.setCursor(230, 210);
  host.controller.pointerDown({ key: 'alpha', pointerId: 2, ctrl: true });
  host.setCursor(280, 240);
  host.controller.pointerMove({ key: 'alpha', pointerId: 2, ctrl: true });
  const last = host.writesFor('alpha').at(-1);
  assert.deepEqual(last, { key: 'alpha', x: 200, y: 160 }, 'the new gesture anchors on the current position');
});
