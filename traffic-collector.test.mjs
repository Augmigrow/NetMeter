import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TrafficLedger, GLOBAL_TARGET, connectionIdentity } from './traffic-ledger.mjs';
import { TrafficCollector } from './traffic-collector.mjs';

const BASE = Date.UTC(2026, 10, 8, 12, 0, 0);
function connection(bytes, { start = BASE + 100, id = 'a', port = 1000, upload = bytes } = {}) {
  return { id, start: new Date(start).toISOString(), metadata: { host: 'example.com', sourceIP: '127.0.0.1', sourcePort: port, destinationIP: '1.2.3.4', destinationPort: 443, network: 'tcp' }, download: bytes, upload };
}
function fixture(path) {
  const ledger = new TrafficLedger(path);
  ledger.setPreferences({ targets: ['example.com'], history: '30天' });
  return ledger;
}
function feed(l, list, total, at, source = 'controller') { l.ingest({ connections: list, downloadTotal: total, uploadTotal: total }, BASE + at, source); }
function total(l, at = BASE + 5000) { return l.snapshot(at).metrics[0]; }

test('first observation establishes a baseline; new connections include bytes already sent on first sight', () => {
  const l = fixture();
  feed(l, [connection(500, { start: BASE - 10000 })], 500, 0);
  feed(l, [connection(550, { start: BASE - 10000 }), connection(80, { port: 1001 })], 630, 1000);
  assert.equal(total(l).totalDown, 130);
  assert.equal(l.snapshot().global.down, 130); l.close();
});

test('changed IDs and duplicate entries do not create a new connection lifetime', () => {
  const l = fixture(); feed(l, [], 0, 0);
  feed(l, [connection(100)], 100, 1000);
  feed(l, [connection(150, { id: 'renamed' }), connection(150), connection(120)], 150, 2000);
  feed(l, [connection(150, { id: 'again' })], 150, 3000);
  assert.equal(total(l).totalDown, 150); l.close();
});

test('disappearance/reappearance and ID reuse are deduplicated by lifetime, not list position', () => {
  const l = fixture(); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000);
  feed(l, [], 120, 2000);
  feed(l, [connection(130)], 130, 3000);
  feed(l, [connection(70, { start: BASE + 3500 })], 200, 4000);
  assert.equal(total(l).totalDown, 200);
  assert.equal(l.snapshot().global.down, 200); l.close();
});

test('five-second connections every fifteen seconds remain observed in a 1s background cadence', () => {
  const l = fixture(); feed(l, [], 0, 0);
  let cumulative = 0;
  for (let s = 1; s <= 300; s++) {
    const phase = (s - 1) % 15, group = Math.floor((s - 1) / 15);
    const running = phase < 5;
    if (running) cumulative += 100;
    // Start just after the preceding idle sample; full cumulative bytes on first observation matter.
    const list = running ? [connection((phase + 1) * 100, { id: 'reused', start: BASE + group * 15000 + 1, port: 1000 })] : [];
    feed(l, list, cumulative, s * 1000);
  }
  assert.equal(total(l).totalDown, 20 * 500);
  assert.equal(l.snapshot().global.down, 20 * 500); l.close();
});

test('a connection entirely between snapshots is included in global totals, never invented per domain', () => {
  const l = fixture(); feed(l, [], 1000, 0); feed(l, [], 1600, 1000);
  const state = l.snapshot(); assert.equal(state.global.down, 600); assert.equal(total(l).totalDown, 0);
  assert.equal(state.coverage.unobservedDown, 600); assert.equal(state.coverage.finalConnectionEvents, false);
  assert.equal(state.coverage.domain, 'active-snapshots-lower-bound'); l.close();
});

test('unseen closing tails stay in the cumulative total and missing attribution is explicit', () => {
  const l = fixture(); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000); feed(l, [], 170, 2000);
  assert.equal(total(l).totalDown, 100); assert.equal(l.snapshot().global.down, 170);
  assert.equal(l.snapshot().coverage.unobservedDown, 70); l.close();
});

test('minute buckets use the response observation time across a minute boundary', () => {
  const l = fixture(); feed(l, [], 0, 58000);
  feed(l, [connection(100, { start: BASE + 58100 })], 100, 59000);
  feed(l, [connection(220, { start: BASE + 58100 })], 220, 60010);
  const rows = l.history('example.com', BASE, BASE + 120000);
  assert.deepEqual(rows.map(r => [r.at - BASE, r.down]), [[0, 100], [60000, 120]]);
  assert.deepEqual(l.history(GLOBAL_TARGET, BASE, BASE + 120000).map(r => r.down), [100, 120]); l.close();
});

test('outage catch-up is not squeezed into one second or made into a peak', () => {
  const l = fixture(); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000);
  feed(l, [connection(5100)], 5100, 61000);
  const row = l.history('example.com', BASE + 60000, BASE + 120000)[0];
  assert.equal(row.down, 5000); assert.equal(row.downSeconds, null);
  const state = l.snapshot(BASE + 61000); assert.equal(state.metrics[0].downRate, 0); assert.equal(state.metrics[0].rateSamples.at(-1).elapsed, 0);
  assert.equal(l.snapshot(BASE + 120000).metrics[0].downRate, 0); l.close();
});

test('stale retries and regressed counters do not lower a lifetime high-water mark', () => {
  const l = fixture(); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000);
  feed(l, [connection(50)], 100, 2000); feed(l, [connection(120)], 120, 3000);
  feed(l, [connection(120)], 120, 3000);
  assert.equal(total(l).totalDown, 120); l.close();
});

test('ambiguous resets and stale totals never lower baselines or re-add old counters', () => {
  const l = fixture(); feed(l, [], 1000, 0); feed(l, [connection(100)], 1100, 1000);
  feed(l, [connection(50)], 50, 2000); feed(l, [connection(70)], 70, 3000);
  assert.equal(total(l).totalDown, 100);
  assert.equal(l.snapshot().coverage.global, 'cumulative-with-discontinuities');
  feed(l, [connection(500)], 5000, 4000, 'another');
  assert.equal(total(l).totalDown, 100); assert.equal(l.snapshot().global.down, 100); l.close();
});

test('atomic checkpoint survives process restart and repeated legacy imports stay idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netmeter-ledger-test-'));
  try {
    let l = fixture(join(dir, 'traffic.sqlite'));
    l.setPreferences({ targets: ['example.com'], legacyTotals: { 'example.com': { down: 500, up: 600 } } });
    const old = { target: 'example.com', at: BASE - 60000, down: 500, up: 600, downSeconds: 2, upSeconds: 3 };
    l.importLegacy([old, old]); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000); l.close();
    l = new TrafficLedger(join(dir, 'traffic.sqlite'));
    l.importLegacy([old]); feed(l, [connection(100)], 100, 2000); feed(l, [connection(120)], 120, 3000);
    // The explicit old total is retained once; reopening and importing history do not add it again.
    assert.equal(total(l).totalDown, 620);
    assert.equal(total(l).totalUp, 720);
    assert.equal(l.history('example.com', BASE - 60000, BASE)[0].down, 500); l.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed request keeps counters; retry is non-overlapping and accounts bytes exactly once', async () => {
  const l = fixture(); let now = BASE, calls = 0, fail = false;
  const timers = { setTimeout: () => 1, clearTimeout() {} };
  const c = new TrafficCollector({ ledger: l, now: () => now, timers, fetchImpl: async () => {
    calls++; if (fail) throw Error('synthetic network error');
    return new Response(JSON.stringify({ connections: now === BASE ? [] : [connection(100)], downloadTotal: now === BASE ? 0 : 100, uploadTotal: now === BASE ? 0 : 100 }));
  } });
  c.configure({ enabled: true, address: '127.0.0.1:1', secret: 'synthetic-only' }); c.running = true;
  await c.tick(); now += 1000; fail = true; await c.tick();
  now += 1000; fail = false; await Promise.all([c.tick(), c.tick()]);
  now += 1000; await c.tick();
  assert.equal(calls, 4); assert.equal(total(l).totalDown, 100); assert.equal(l.snapshot().global.down, 100);
  c.stop(); l.close();
});

test('backend windows explicitly disable renderer background throttling', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.equal((main.match(/backgroundThrottling: false/g) || []).length, 2);
  assert.match(main, /trafficStorePath: join\(app.getPath\('userData'\), 'traffic.sqlite'\)/);
});

test('a stale successful response from an earlier configuration cannot touch the ledger', async () => {
  const l = fixture(); let release;
  const c = new TrafficCollector({ ledger: l, timers: { setTimeout: () => 1, clearTimeout() {} }, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  c.configure({ enabled: true, address: '127.0.0.1:1', secret: 'old-synthetic' }); c.running = true;
  const pending = c.tick();
  c.configure({ enabled: true, address: '127.0.0.1:2', secret: 'new-synthetic' });
  release(new Response(JSON.stringify({ connections: [], downloadTotal: 900, uploadTotal: 1000 })));
  await pending;
  assert.equal(l.get('checkpoint'), null); c.stop(); l.close();
});

test('legacy totals are imported once without adding authoritative renderer totals a second time', () => {
  const l = new TrafficLedger();
  l.setPreferences({ targets: ['example.com'], legacyTotals: { 'example.com': { down: 500, up: 600 } } });
  feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000);
  l.setPreferences({ targets: ['example.com'], legacyTotals: { 'example.com': { down: 600, up: 700 } } });
  assert.equal(total(l).totalDown, 600); assert.equal(total(l).totalUp, 700); l.close();
});

test('history imports are atomic and preserve unknown legacy active seconds', () => {
  const l = fixture();
  assert.throws(() => l.importLegacy([{target:'example.com',at:BASE,down:100,up:0}, {at:-1}]));
  assert.equal(l.history('example.com', BASE, BASE+60000).length,0);
  l.importLegacy([{target:'example.com',at:BASE,down:100,up:0}]);
  assert.equal(l.history('example.com', BASE, BASE+60000)[0].downSeconds,null); l.close();
});


test('a stale lower global snapshot followed by a retry cannot duplicate global traffic', () => {
  const l = fixture(); feed(l, [], 1000, 0); feed(l, [connection(100)], 1100, 1000);
  feed(l, [], 1050, 2000); feed(l, [connection(120)], 1120, 3000);
  assert.equal(l.snapshot().global.down,120); assert.equal(total(l).totalDown,120); l.close();
});

test('mutable sniffed host and connection ID do not alter the stable transport lifetime', () => {
  const l = fixture(); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000);
  const changed = connection(100, {id:'changed'}); changed.metadata.host='www.example.com';
  feed(l,[changed],100,2000); assert.equal(total(l).totalDown,100); l.close();
});

test('transport identity normalizes timestamps and ports without treating a cosmetic ID change as new traffic', () => {
  const l=fixture();feed(l,[],0,0);feed(l,[connection(100)],100,1000);
  const c=connection(100,{id:'new'}); c.metadata.sourcePort='1000';c.metadata.destinationPort='443';c.start=c.start.replace('.100Z','.100000Z');
  feed(l,[c],100,2000);assert.equal(total(l).totalDown,100);l.close();
});

test('optional global totals missing from one response do not reset the cumulative baseline', () => {
  const l=fixture();feed(l,[],1000,0);l.ingest({connections:[]},BASE+1000,'controller');feed(l,[],1100,2000);
  assert.equal(l.snapshot().global.down,100);l.close();
});

test('stopping the collector cancels requests and never reschedules itself', async () => {
  const l=fixture();let schedules=0,aborted=false;
  const c=new TrafficCollector({ledger:l,timers:{setTimeout:()=>{schedules++;return schedules;},clearTimeout(){}},fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));}))});
  c.configure({enabled:true,address:'127.0.0.1:1',secret:'synthetic'});c.running=true;
  const pending=c.tick();c.stop();await pending;
  assert.equal(aborted,true);assert.equal(schedules,1);assert.equal(c.running,false);l.close();
});


test('preferences without legacy totals do not seal a zero before the real migration arrives', () => {
  const l=fixture();
  l.setPreferences({targets:['example.com'], legacyTotals:{'example.com':{down:900,up:300}}});
  l.setPreferences({targets:['example.com'], legacyTotals:{'example.com':{down:900,up:300}}});
  assert.equal(total(l).totalDown,900);assert.equal(total(l).totalUp,300);l.close();
});


test('renderer persistence never turns authoritative backend totals into a new legacy import', async () => {
  const { readFile }=await import('node:fs/promises');const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html, /if \(view === 'widget' && !backgroundCollection\) metrics\.forEach/);
  assert.match(html, /if \(backgroundCollection\) \{\s*try \{ await displayCollectedTraffic\(\); \}/);
});

test('ledger shutdown is idempotent for server-close and quit cleanup paths', () => {
  const ledger = fixture();
  ledger.close();
  assert.doesNotThrow(() => ledger.close());
});

test('null idle connections still record ended download/upload bytes in their observation minute', () => {
  const l = fixture();
  try {
    l.ingest({ connections: null, downloadTotal: 1000, uploadTotal: 2000 }, BASE + 58000, 'controller');
    l.ingest({ connections: null, downloadTotal: 1100, uploadTotal: 2300 }, BASE + 59000, 'controller');
    l.ingest({ connections: null, downloadTotal: 1170, uploadTotal: 2350 }, BASE + 60010, 'controller');
    l.ingest({ connections: null, downloadTotal: 1170, uploadTotal: 2350 }, BASE + 61000, 'controller');
    const state = l.snapshot(BASE + 61000);
    assert.equal(state.count, 0);
    assert.equal(state.global.down, 170);
    assert.equal(state.global.up, 350);
    assert.equal(state.metrics[0].totalDown, 0);
    assert.equal(state.coverage.unobservedDown, 170);
    assert.equal(state.coverage.unobservedUp, 350);
    assert.deepEqual(l.history(GLOBAL_TARGET, BASE, BASE + 120000).map(r => [r.at - BASE, r.down, r.up]), [[0, 100, 300], [60000, 70, 50]]);
  } finally { l.close(); }
});

test('malformed empty snapshots cannot advance checkpoints or corrupt cumulative baselines', () => {
  const l = fixture();
  try {
    feed(l, [], 1000, 0);
    for (const payload of [null, {}, { connections: {} }, { connections: null }, { connections: null, downloadTotal: -1, uploadTotal: 20 }, { connections: null, downloadTotal: 50, uploadTotal: '20' }]) {
      assert.throws(() => l.ingest(payload, BASE + 1000, 'controller'), /invalid_controller_response/);
      assert.equal(l.get('checkpoint').at, BASE);
    }
    feed(l, [], 1100, 2000);
    assert.equal(l.snapshot().global.down, 100);
  } finally { l.close(); }
});

test('the collector remains connected across null idle snapshots and includes closing tails once', async () => {
  const l = fixture();
  let now = BASE, payload = { connections: null, downloadTotal: 0, uploadTotal: 0 };
  const c = new TrafficCollector({ ledger: l, now: () => now, timers: { setTimeout: () => 1, clearTimeout() {} }, fetchImpl: async () => new Response(JSON.stringify(payload)) });
  try {
    c.configure({ enabled: true, address: '127.0.0.1:1', secret: 'synthetic' }); c.running = true;
    await c.tick();
    now += 1000; payload = { connections: [connection(100)], downloadTotal: 100, uploadTotal: 100 }; await c.tick();
    now += 1000; payload = { connections: null, downloadTotal: 170, uploadTotal: 190 }; await c.tick();
    now += 1000; await c.tick();
    assert.equal(c.status, 'connected');
    assert.equal(c.observations.length, 4);
    assert.equal(l.snapshot().global.down, 170);
    assert.equal(l.snapshot().global.up, 190);
    assert.equal(total(l).totalDown, 100);
  } finally { c.stop(); l.close(); }
});

test('expired dedup rows are compacted without replaying old lifetimes, including after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netmeter-ledger-retention-'));
  const path = join(dir, 'traffic.sqlite'), late = 7 * 86400000 + 10000;
  let l;
  try {
    l = fixture(path); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000);
    feed(l, [], 100, late);
    assert.equal(l.db.prepare('SELECT COUNT(*) count FROM seen').get().count, 0);
    assert.equal(l.get('checkpoint').epochAt, BASE + 10000);
    l.close(); l = new TrafficLedger(path);
    feed(l, [connection(100, { id: 'changed' })], 100, late + 1000);
    feed(l, [connection(130, { id: 'changed-again' })], 130, late + 2000);
    assert.equal(total(l).totalDown, 130);
    assert.equal(l.snapshot().global.down, 130);
  } finally { l?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('compaction retains recently observed long-lived connections and accepts new lifetimes reusing IDs', () => {
  const l = fixture(), week = 7 * 86400000;
  try {
    feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000);
    feed(l, [connection(150)], 150, week - 1000);
    feed(l, [connection(180)], 180, week + 10000);
    feed(l, [connection(20, { start: BASE + week + 10500 })], 200, week + 11000);
    assert.equal(total(l).totalDown, 200);
    assert.equal(l.db.prepare('SELECT COUNT(*) count FROM seen').get().count, 2);
    assert.equal(l.snapshot().global.down, 200);
  } finally { l.close(); }
});

test('legacy three-column dedup tables migrate atomically without losing high-water marks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netmeter-ledger-migration-'));
  const path = join(dir, 'traffic.sqlite');
  let l;
  try {
    l = fixture(path); feed(l, [], 0, 0); feed(l, [connection(100)], 100, 1000); l.close();
    const old = new DatabaseSync(path);
    try {
      old.exec('DROP INDEX seen_retention; ALTER TABLE seen DROP COLUMN at');
      const checkpoint = JSON.parse(old.prepare("SELECT value FROM kv WHERE key='checkpoint'").get().value);
      delete checkpoint.compactedAt;
      old.prepare("UPDATE kv SET value=? WHERE key='checkpoint'").run(JSON.stringify(checkpoint));
    } finally { old.close(); }
    l = new TrafficLedger(path);
    assert.equal(l.db.prepare('SELECT at FROM seen WHERE key=?').get(connectionIdentity(connection(100)).key).at, BASE + 1000);
    feed(l, [connection(100, { id: 'changed' })], 100, 2000);
    feed(l, [connection(120)], 120, 3000);
    assert.equal(total(l).totalDown, 120);
    assert.equal(l.snapshot().global.down, 120);
    l.close(); l = new TrafficLedger(path);
    feed(l, [connection(120)], 120, 4000);
    assert.equal(total(l).totalDown, 120);
  } finally { l?.close(); rmSync(dir, { recursive: true, force: true }); }
});
