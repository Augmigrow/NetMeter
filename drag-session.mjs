// Pure gesture state machine for tile dragging.
//
// One gesture owns one token, one pointer and one dragged tile. The machine
// never touches windows or the DOM; the main process applies the resulting
// state, so the transitions can be tested without Electron.

export const GESTURE_STATE = {
  IDLE: 'idle',
  PENDING: 'pending',
  GROUP: 'group',
  SINGLE: 'single',
  FINISHED: 'finished',
  CANCELLED: 'cancelled'
};

export function createSession() {
  return {
    state: GESTURE_STATE.IDLE,
    token: 0,
    sourceGestureId: null,
    key: '',
    pointerId: null,
    single: false,
    promoted: false,
    started: false,
    restore: {},
    grabOffset: null,
    locks: { x: null, y: null }
  };
}

export function isActive(session) {
  return session.state === GESTURE_STATE.PENDING ||
    session.state === GESTURE_STATE.GROUP ||
    session.state === GESTURE_STATE.SINGLE;
}

export function isTerminal(session) {
  return session.state === GESTURE_STATE.FINISHED || session.state === GESTURE_STATE.CANCELLED;
}

// A new gesture is only accepted while no other gesture is active, so a late
// pointer event can never restart a completed drag.
export function beginPending(session, { token, sourceGestureId = String(token), key, pointerId, ctrl, grabOffset }) {
  if (isActive(session)) return session;
  if (!key || !Number.isFinite(token) || typeof sourceGestureId !== 'string' || !sourceGestureId || sourceGestureId.length > 128) return session;
  return {
    ...session,
    state: GESTURE_STATE.PENDING,
    token,
    sourceGestureId,
    key,
    pointerId: pointerId ?? null,
    single: Boolean(ctrl),
    promoted: false,
    started: false,
    restore: {},
    grabOffset: grabOffset ? { ...grabOffset } : null,
    locks: { x: null, y: null }
  };
}

// Ctrl may be pressed before the mouse, after the mouse button or in the
// middle of a running group gesture. Once independent dragging is selected it
// stays selected until the gesture ends, so releasing Ctrl can never pull the
// other tiles along again.
export function applyCtrl(session, ctrl) {
  if (!isActive(session)) return session;
  if (session.single) return session;
  return { ...session, single: Boolean(ctrl) };
}

export function startGroup(session, { restore, grabOffset }) {
  if (session.state !== GESTURE_STATE.PENDING) return session;
  return {
    ...session,
    state: GESTURE_STATE.GROUP,
    started: true,
    single: false,
    restore: { ...restore },
    grabOffset: grabOffset || session.grabOffset ? { ...(grabOffset || session.grabOffset) } : null
  };
}

export function startSingle(session, { restore, grabOffset }) {
  if (session.state !== GESTURE_STATE.PENDING) return session;
  return {
    ...session,
    state: GESTURE_STATE.SINGLE,
    started: true,
    single: true,
    restore: { ...restore },
    grabOffset: grabOffset || session.grabOffset ? { ...(grabOffset || session.grabOffset) } : null
  };
}

// A group gesture that turns into an independent drag keeps the motion that
// already happened: the single phase starts from the current geometry and
// only the dragged tile can be restored later.
export function promoteToSingle(session, { restore, grabOffset }) {
  if (session.state !== GESTURE_STATE.GROUP) return session;
  return {
    ...session,
    state: GESTURE_STATE.SINGLE,
    single: true,
    promoted: true,
    restore: { ...restore },
    grabOffset: { ...grabOffset },
    locks: { x: null, y: null }
  };
}

export function updateLocks(session, locks) {
  if (!isActive(session)) return session;
  return { ...session, locks: { ...locks } };
}

export function finish(session) {
  if (!isActive(session)) return session;
  return { ...session, state: GESTURE_STATE.FINISHED, started: false, grabOffset: null, locks: { x: null, y: null } };
}

export function cancel(session) {
  if (!isActive(session)) return session;
  return { ...session, state: GESTURE_STATE.CANCELLED, started: false, grabOffset: null, locks: { x: null, y: null } };
}

export function reset(session) {
  return { ...createSession(), token: session.token };
}
