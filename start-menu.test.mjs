import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createPinToStartAction } from './start-menu.mjs';

const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const dictionary = new Function(main.slice(main.indexOf('const UI_STRINGS = {'), main.indexOf('function strings()')) + '; return UI_STRINGS;')();
function fixture(overrides = {}) {
  const calls = { install: 0, request: 0, reveal: 0, dialogs: [] };
  const action = createPinToStartAction({
    installShortcut: async () => { calls.install += 1; return true; },
    requestPin: async () => { calls.request += 1; return { state: 'manual-required' }; },
    revealShortcut: async () => { calls.reveal += 1; },
    showDialog: async options => { calls.dialogs.push(options); return { response: 0 }; },
    getStrings: () => dictionary.zh,
    ...overrides
  });
  return { action, calls };
}

test('creating a shortcut alone never reports that the app is pinned', async () => {
  const { action, calls } = fixture();
  assert.deepEqual(await action(), { state: 'manual-required', revealed: true });
  assert.equal(calls.install, 1);
  assert.equal(calls.request, 1);
  assert.equal(calls.reveal, 1);
  assert.equal(calls.dialogs[0].message, dictionary.zh.pinManual);
  assert.match(calls.dialogs[0].detail, /尚未固定/);
});

test('the manual flow can be cancelled without opening Explorer', async () => {
  const { action, calls } = fixture({ showDialog: async () => ({ response: 1 }) });
  assert.deepEqual(await action(), { state: 'manual-required', revealed: false });
  assert.equal(calls.reveal, 0);
});

test('only confirmed pinned and already-pinned results produce a success message', async () => {
  for (const state of ['pinned', 'already-pinned']) {
    const { action, calls } = fixture({ requestPin: async () => ({ state }) });
    assert.deepEqual(await action(), { state });
    assert.equal(calls.reveal, 0);
    assert.equal(calls.dialogs[0].message, state === 'pinned' ? dictionary.zh.pinSuccess : dictionary.zh.pinAlready);
  }
});

test('an unsupported, malformed, or rejected native result uses the manual flow', async () => {
  for (const result of [undefined, null, {}, { state: 'pin-available' }, { state: 'unknown' }]) {
    const { action, calls } = fixture({ requestPin: async () => result });
    assert.equal((await action()).state, 'manual-required');
    assert.equal(calls.reveal, 1);
  }
  const { action, calls } = fixture({ requestPin: async () => { throw new Error('E_ACCESSDENIED'); } });
  assert.equal((await action()).state, 'manual-required');
  assert.equal(calls.reveal, 1);
});

test('shortcut installation failure is shown and never attempts to pin or reveal', async () => {
  for (const installShortcut of [async () => false, async () => { throw new Error('write denied'); }]) {
    const { action, calls } = fixture({ installShortcut });
    assert.deepEqual(await action(), { state: 'failed' });
    assert.equal(calls.request, 0);
    assert.equal(calls.reveal, 0);
    assert.equal(calls.dialogs[0].type, 'error');
    assert.equal(calls.dialogs[0].message, dictionary.zh.pinInstallFailed);
  }
});

test('repeated menu clicks share one pending operation and a later click can retry', async () => {
  let finish;
  const { action, calls } = fixture({ requestPin: () => new Promise(resolve => { finish = resolve; }) });
  const first = action();
  const second = action();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  finish({ state: 'already-pinned' });
  await first;
  assert.equal(calls.install, 1);
  assert.equal(calls.dialogs.length, 1);
  const third = action();
  assert.notEqual(first, third);
  await new Promise(resolve => setImmediate(resolve));
  finish({ state: 'already-pinned' });
  await third;
  assert.equal(calls.install, 2);
});

test('pinning prompts and menu labels have matching Chinese and English keys', () => {
  assert.deepEqual(Object.keys(dictionary.zh).sort(), Object.keys(dictionary.en).sort());
  for (const [key, text] of Object.entries(dictionary.en)) {
    assert.ok(text.trim(), key);
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, key);
  }
  assert.match(dictionary.zh.pinToStart, /…$/);
  assert.match(dictionary.en.pinToStart, /…$/);
});

test('both native menu entries call the full workflow and startup never automatically pins', () => {
  assert.equal((main.match(/id: 'pin-to-start'/g) || []).length, 2);
  assert.equal((main.match(/pinToStartMenu\(\)\.catch/g) || []).length, 2);
  const startup = main.slice(main.indexOf('app.whenReady().then'));
  assert.match(startup, /installStartMenuShortcut\(\)/);
  assert.doesNotMatch(startup, /pinToStartMenu\(|requestStartMenuPin\(/);
  assert.match(main, /shell\.showItemInFolder\(startMenuShortcutPath\(\)\)/);
});

function pinRequestFixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kill = () => { child.killed = true; };
  let timeout;
  const source = main.slice(main.indexOf('function requestStartMenuPin()'), main.indexOf('async function loadControllerConfig()'));
  const request = new Function('root', 'resolve', 'spawn', 'startMenuShortcutPath', 'setTimeout', 'clearTimeout', source + '; return requestStartMenuPin;')(
    'root', (...parts) => parts.join('/'), () => child, () => 'NetMeter.lnk', callback => { timeout = callback; return 1; }, () => {});
  return { request, child, expire: () => timeout() };
}

test('native pin adapter parses verified JSON and malformed output falls back safely', async () => {
  for (const [output, state] of [['{"state":"pinned"}', 'pinned'], ['not JSON', 'manual-required']]) {
    const { request, child } = pinRequestFixture();
    const result = request();
    child.stdout.emit('data', output);
    child.emit('close', 0);
    assert.equal((await result).state, state);
  }
});

test('a native request timeout terminates the helper and offers manual completion', async () => {
  const { request, child, expire } = pinRequestFixture();
  const result = request();
  expire();
  assert.equal(child.killed, true);
  assert.deepEqual(await result, { state: 'manual-required', reason: 'timeout' });
});

test('native helper launch errors do not leave a permanently pending action', async () => {
  const { request, child } = pinRequestFixture();
  const result = request();
  child.emit('error', new Error('spawn failed'));
  assert.deepEqual(await result, { state: 'manual-required', reason: 'launch-failed' });
});

test('the native script confirms an Unpin verb and never edits Windows pin storage', () => {
  const script = readFileSync(new URL('./scripts/pin-start-menu.ps1', import.meta.url), 'utf8');
  assert.match(script, /\$actions\.Pin\.DoIt\(\)/);
  assert.match(script, /if \(\$confirmed\.AlreadyPinned\)/);
  assert.match(script, /Write-PinResult 'pinned' 'unpin-verb-confirmed'/);
  assert.doesNotMatch(script, /Set-ItemProperty|reg\.exe|start\d*\.bin|CloudStore|Unpin\.DoIt/);
  assert.match(script, /\[switch\]\$CheckOnly/);
});
