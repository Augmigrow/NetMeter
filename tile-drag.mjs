// Composed tile drag behaviour for the main process.
//
// The controller owns the gesture and the geometry decisions; the host owns
// the native windows. Every window write goes through the injected
// `moveTile` callback, so a single drag can be proven to touch exactly one
// window and a group drag can be proven to move every visible tile by the
// same displacement.
import { TILE_HEIGHT, TILE_WIDTH, resolveSnap } from './drag-geometry.mjs';
import {
  GESTURE_STATE,
  applyCtrl,
  beginPending,
  cancel as cancelSession,
  createSession,
  finish as finishSession,
  isActive,
  promoteToSingle,
  reset as resetSession,
  startGroup,
  startSingle,
  updateLocks
} from './drag-session.mjs';

// The native window keeps a fixed shadow padding around the tile content box.
export const TILE_PADDING = 6;

export function createDragController({ listTiles, moveTile, cursorAt, feedback, commit }) {
  let session = createSession();
  let token = 0;

  const tileFor = key => (listTiles() || []).find(tile => tile.key === key) || null;
  const tileRects = key => (listTiles() || [])
    .filter(tile => tile.key !== key && !tile.historyOpen)
    .map(tile => ({
      key: tile.key,
      x: tile.bounds.x + TILE_PADDING,
      y: tile.bounds.y + TILE_PADDING,
      width: TILE_WIDTH,
      height: TILE_HEIGHT
    }));

  function contentPositions(keys) {
    const positions = {};
    for (const key of keys) {
      const tile = tileFor(key);
      if (!tile) continue;
      positions[key] = { x: tile.bounds.x + TILE_PADDING, y: tile.bounds.y + TILE_PADDING };
    }
    return positions;
  }

  function begin(cursor) {
    const key = session.key;
    const tile = tileFor(key);
    if (!tile) {
      cancel();
      return false;
    }
    const bounds = tile.bounds;
    const grabOffset = session.grabOffset || { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    if (session.single) {
      session = startSingle(session, { restore: { [key]: { x: bounds.x, y: bounds.y } }, grabOffset });
    } else {
      const targets = (listTiles() || []).filter(item => !item.historyOpen);
      const restore = {};
      for (const item of targets) restore[item.key] = { x: item.bounds.x, y: item.bounds.y };
      session = startGroup(session, { restore, grabOffset });
    }
    return true;
  }

  function apply(cursor) {
    if (!isActive(session) || !session.grabOffset) return;
    const key = session.key;
    const start = session.restore[key];
    if (!start) return;
    // The grab offset is kept, so the tile stays exactly under the pointer.
    const target = {
      x: cursor.x - session.grabOffset.x,
      y: cursor.y - session.grabOffset.y
    };
    if (session.state === GESTURE_STATE.GROUP) {
      const delta = { x: Math.round(target.x - start.x), y: Math.round(target.y - start.y) };
      for (const [other, origin] of Object.entries(session.restore)) {
        moveTile(other, origin.x + delta.x, origin.y + delta.y);
      }
      feedback?.(key, { mode: 'group', guides: { x: null, y: null } });
      return;
    }
    const raw = {
      x: target.x + TILE_PADDING,
      y: target.y + TILE_PADDING,
      width: TILE_WIDTH,
      height: TILE_HEIGHT
    };
    const snapped = resolveSnap({ raw, neighbors: tileRects(key), locks: session.locks });
    session = updateLocks(session, snapped.locks);
    // Only the dragged window is written in single mode.
    moveTile(key, Math.round(snapped.rect.x - TILE_PADDING), Math.round(snapped.rect.y - TILE_PADDING));
    feedback?.(key, { mode: 'single', guides: snapped.guides });
  }

  function pointerDown({ key, pointerId, gestureId, ctrl, ...payload }) {
    if (!key || !Number.isFinite(pointerId) || typeof gestureId !== 'string' || !gestureId || gestureId.length > 128) return false;
    if (isActive(session)) cancel();
    const tile = tileFor(key);
    if (!tile) return false;
    const cursor = cursorAt?.(payload);
    token += 1;
    session = beginPending(session, {
      token,
      sourceGestureId: gestureId,
      key,
      pointerId,
      ctrl: Boolean(ctrl),
      grabOffset: cursor ? { x: cursor.x - tile.bounds.x, y: cursor.y - tile.bounds.y } : null
    });
    return true;
  }

  function pointerMove({ key, pointerId, gestureId, ctrl, ...payload }) {
    if (!isActive(session) || session.key !== key || session.pointerId !== pointerId || session.sourceGestureId !== gestureId) return false;
    const cursor = cursorAt?.(payload);
    if (!cursor) return false;
    if (session.state === GESTURE_STATE.PENDING) {
      if (ctrl) session = applyCtrl(session, true);
      if (!begin(cursor)) return false;
    }
    apply(cursor);
    return true;
  }

  function pointerUp({ key, pointerId, gestureId, cancelled }) {
    if (!isActive(session) || session.key !== key || session.pointerId !== pointerId || session.sourceGestureId !== gestureId) return false;
    const active = session.key;
    if (cancelled) {
      cancel();
      feedback?.(active, { mode: null, guides: { x: null, y: null } });
      return true;
    }
    const positions = contentPositions(Object.keys(session.restore));
    session = finishSession(session);
    session = resetSession(session);
    feedback?.(active, { mode: null, guides: { x: null, y: null } });
    commit?.(positions);
    return true;
  }

  function modifier({ key, gestureId, ctrl }) {
    if (!isActive(session) || session.key !== key || session.sourceGestureId !== gestureId) return false;
    const previous = session;
    session = applyCtrl(session, Boolean(ctrl));
    if (session.single && previous.state === GESTURE_STATE.GROUP) {
      const tile = tileFor(key);
      if (!tile) return false;
      const cursor = cursorAt?.();
      const grabOffset = cursor
        ? { x: cursor.x - tile.bounds.x, y: cursor.y - tile.bounds.y }
        : session.grabOffset;
      // The group motion that already happened stays: only the dragged tile
      // can be restored when the gesture is cancelled.
      session = promoteToSingle(session, { restore: { [key]: { x: tile.bounds.x, y: tile.bounds.y } }, grabOffset });
    }
    return true;
  }

  function cancel() {
    if (!isActive(session)) return false;
    for (const [other, origin] of Object.entries(session.restore)) {
      moveTile(other, origin.x, origin.y);
    }
    session = cancelSession(session);
    session = resetSession(session);
    return true;
  }

  return {
    pointerDown,
    pointerMove,
    pointerUp,
    modifier,
    cancel,
    get state() { return session; },
    get active() { return isActive(session); }
  };
}
