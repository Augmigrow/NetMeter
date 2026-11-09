import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GESTURE_STATE,
  applyCtrl,
  beginPending,
  cancel,
  createSession,
  finish,
  isActive,
  promoteToSingle,
  reset,
  startGroup,
  startSingle,
  updateLocks
} from './drag-session.mjs';

const bounds = { alpha: { x: 10, y: 20 }, bravo: { x: 300, y: 20 } };
const grab = { x: 40, y: 12 };

test('a gesture starts pending and only one gesture may be active', () => {
  const session = beginPending(createSession(), { token: 1, key: 'alpha', pointerId: 7, ctrl: false });
  assert.equal(session.state, GESTURE_STATE.PENDING);
  assert.equal(isActive(session), true);
  const second = beginPending(session, { token: 2, key: 'bravo', pointerId: 8, ctrl: false });
  assert.equal(second.token, 1, 'a second gesture cannot replace a running one');
});

test('ctrl before the mouse selects independent dragging', () => {
  const session = beginPending(createSession(), { token: 1, key: 'alpha', pointerId: 7, ctrl: true });
  const single = startSingle(session, { restore: { alpha: bounds.alpha }, grabOffset: grab });
  assert.equal(single.state, GESTURE_STATE.SINGLE);
  assert.equal(single.single, true);
  assert.deepEqual(single.restore, { alpha: bounds.alpha });
});

test('ctrl pressed after the mouse button selects independent dragging', () => {
  const session = beginPending(createSession(), { token: 1, key: 'alpha', pointerId: 7, ctrl: false });
  const pressed = applyCtrl(session, true);
  assert.equal(pressed.single, true);
  const single = startSingle(pressed, { restore: { alpha: bounds.alpha }, grabOffset: grab });
  assert.equal(single.state, GESTURE_STATE.SINGLE);
});

test('releasing ctrl keeps independent dragging until the gesture ends', () => {
  const session = beginPending(createSession(), { token: 1, key: 'alpha', pointerId: 7, ctrl: true });
  const single = startSingle(session, { restore: { alpha: bounds.alpha }, grabOffset: grab });
  const released = applyCtrl(single, false);
  assert.equal(released.single, true);
  assert.equal(released.state, GESTURE_STATE.SINGLE);
});

test('a group gesture can be promoted without undoing the group motion', () => {
  const session = beginPending(createSession(), { token: 1, key: 'alpha', pointerId: 7, ctrl: false });
  const group = startGroup(session, { restore: bounds, grabOffset: grab });
  assert.equal(group.state, GESTURE_STATE.GROUP);
  const promoted = promoteToSingle(group, { restore: { alpha: { x: 60, y: 70 } }, grabOffset: { x: 40, y: 12 } });
  assert.equal(promoted.state, GESTURE_STATE.SINGLE);
  assert.equal(promoted.promoted, true);
  assert.deepEqual(promoted.restore, { alpha: { x: 60, y: 70 } }, 'only the dragged tile can be restored');
  assert.deepEqual(promoted.grabOffset, { x: 40, y: 12 });
});

test('a finished or cancelled gesture cannot be restarted by late events', () => {
  const session = beginPending(createSession(), { token: 1, key: 'alpha', pointerId: 7, ctrl: false });
  const group = startGroup(session, { restore: bounds, grabOffset: grab });
  const done = finish(group);
  assert.equal(done.state, GESTURE_STATE.FINISHED);
  assert.equal(isActive(done), false);
  assert.equal(applyCtrl(done, true).state, GESTURE_STATE.FINISHED);
  assert.equal(startGroup(done, { restore: bounds, grabOffset: grab }).state, GESTURE_STATE.FINISHED);
  assert.equal(cancel(done).state, GESTURE_STATE.FINISHED, 'a cancelled gesture stays terminal');
  const next = beginPending(done, { token: 2, key: 'alpha', pointerId: 9, ctrl: false });
  assert.equal(next.state, GESTURE_STATE.PENDING, 'a later gesture may start after the previous one ended');
  assert.equal(next.token, 2, 'a later gesture carries its own identity');
});

test('cancelling keeps the restore points and clears the locks', () => {
  const session = beginPending(createSession(), { token: 1, key: 'alpha', pointerId: 7, ctrl: false });
  const group = startGroup(session, { restore: bounds, grabOffset: grab });
  const locked = updateLocks(group, { x: { key: 'bravo' }, y: null });
  const cancelled = cancel(locked);
  assert.equal(cancelled.state, GESTURE_STATE.CANCELLED);
  assert.deepEqual(cancelled.restore, bounds);
  assert.equal(cancelled.locks.x, null);
  assert.equal(cancelled.grabOffset, null);
});

test('reset returns an idle session and keeps the token counter', () => {
  const session = beginPending(createSession(), { token: 5, key: 'alpha', pointerId: 7, ctrl: false });
  const idle = reset(session);
  assert.equal(idle.state, GESTURE_STATE.IDLE);
  assert.equal(idle.token, 5);
});
