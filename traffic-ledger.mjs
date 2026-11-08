import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const GLOBAL_TARGET = '__netmeter_controller_total__';
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const seconds = (value, bytes) => Number.isFinite(value) && value > 0 ? value : bytes ? null : 0;
export function connectionIdentity(c) {
  const m = c.metadata || {};
  // IDs can change or be reused. A start timestamp + transport endpoints identify a lifetime.
  const started = Date.parse(c.start);
  const stable = Number.isFinite(started) && m.sourcePort !== undefined && Boolean(m.sourceIP);
  const key = stable ? [started, String(m.network || '').toLowerCase(), String(m.sourceIP).toLowerCase(), String(m.sourcePort), String(m.destinationIP || '').toLowerCase(), String(m.destinationPort ?? '')] : ['ambiguous', c.id];
  return { key: createHash('sha256').update(JSON.stringify(key)).digest('hex'), stable: Boolean(stable) };
}
function matches(host, target) {
  try {
    const expected = new URL(/^[a-z]+:\/\//i.test(target) ? target : 'http://' + target).hostname.toLowerCase();
    const actual = String(host || '').toLowerCase();
    return actual === expected || actual.endsWith('.' + expected);
  } catch { return false; }
}

export class TrafficLedger {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen(key TEXT PRIMARY KEY,down INTEGER,up INTEGER);
      CREATE TABLE IF NOT EXISTS totals(target TEXT PRIMARY KEY,down INTEGER NOT NULL,up INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS minutes(target TEXT,at INTEGER,down INTEGER,up INTEGER,ds REAL,us REAL,PRIMARY KEY(target,at));
      CREATE TABLE IF NOT EXISTS legacy(id TEXT PRIMARY KEY,target TEXT,at INTEGER,down INTEGER,up INTEGER,ds REAL,us REAL);
      CREATE TABLE IF NOT EXISTS legacy_totals(target TEXT PRIMARY KEY,down INTEGER,up INTEGER);
      CREATE INDEX IF NOT EXISTS legacy_time ON legacy(target,at);
      CREATE INDEX IF NOT EXISTS minutes_retention ON minutes(at);
      CREATE INDEX IF NOT EXISTS legacy_retention ON legacy(at);`);
    this.preferences = this.get('preferences') || { targets: [], history: '7天' };
    this.recent = new Map();
  }
  get(key) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  put(key, value) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?)').run(key, JSON.stringify(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setPreferences({ targets, history, legacyTotals }) {
    if (!Array.isArray(targets) || targets.length > 200 || targets.some(n => typeof n !== 'string' || n.length > 512)) throw Error('invalid_preferences');
    const next = { targets: [...new Set(targets)], history: ['7天', '30天', '长期'].includes(history) ? history : '7天' };
    this.transaction(() => {
      this.put('preferences', next);
      // An early preferences sync without legacy data must not seal a zero import
      // before the renderer has loaded the user's actual stored totals.
      for (const [target, value] of Object.entries(legacyTotals || {}).slice(0, 500)) {
        if (target.length <= 512 && value && (number(value.down) !== null || number(value.up) !== null))
          this.db.prepare('INSERT OR IGNORE INTO legacy_totals VALUES(?,?,?)').run(target, number(value.down) || 0, number(value.up) || 0);
      }
    });
    this.preferences = next;
  }
  importLegacy(samples) {
    if (!Array.isArray(samples) || samples.length > 100) throw Error('invalid_import');
    this.transaction(() => {
      const stmt = this.db.prepare('INSERT OR IGNORE INTO legacy VALUES(?,?,?,?,?,?,?)');
      for (const s of samples) {
        if (!s || typeof s.target !== 'string' || s.target.length > 512 || !Number.isSafeInteger(s.at) || s.at < 0) throw Error('invalid_import');
        const down = number(s.down) || 0, up = number(s.up) || 0;
        stmt.run(s.target + '|' + s.at, s.target, s.at, down, up, seconds(s.downSeconds, down), seconds(s.upSeconds, up));
      }
    });
  }
  add(target, at, down, up, elapsed, reliable) {
    const ds = down ? reliable ? elapsed : null : 0, us = up ? reliable ? elapsed : null : 0;
    this.db.prepare(`INSERT INTO totals VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET down=down+excluded.down,up=up+excluded.up`).run(target, down, up);
    if (down || up) this.db.prepare(`INSERT INTO minutes VALUES(?,?,?,?,?,?) ON CONFLICT(target,at) DO UPDATE SET
      down=down+excluded.down,up=up+excluded.up,ds=CASE WHEN ds IS NULL OR excluded.ds IS NULL THEN NULL ELSE ds+excluded.ds END,
      us=CASE WHEN us IS NULL OR excluded.us IS NULL THEN NULL ELSE us+excluded.us END`).run(target, Math.floor(at / 60000) * 60000, down, up, ds, us);
    return { at, down, up, elapsed: reliable ? elapsed : 0 };
  }
  ingest(payload, at, source) {
    if (!Array.isArray(payload?.connections)) throw Error('invalid_controller_response');
    const previous = this.get('checkpoint');
    if (previous?.source === source && at <= previous.at) return false;
    const same = previous?.source === source;
    const resetGlobal = same && number(payload.downloadTotal) !== null && number(payload.uploadTotal) !== null && previous.globalDown !== null && previous.globalUp !== null && (payload.downloadTotal < previous.globalDown || payload.uploadTotal < previous.globalUp);
    const elapsed = same ? (at - previous.at) / 1000 : 0;
    const reliable = elapsed > 0 && elapsed <= 2.5;
    const deltas = new Map(this.preferences.targets.map(target => [target, { down: 0, up: 0, reliable }]));
    const active = new Set(), writes = new Map();
    let observedDown = 0, observedUp = 0;
    let resets = same ? previous.resets || 0 : 0;
    const globalDown = number(payload.downloadTotal), globalUp = number(payload.uploadTotal);
    const totalsAvailable = globalDown !== null && globalUp !== null;
    const pending = [];
    this.transaction(() => {
      if (!same) this.db.exec('DELETE FROM seen');
      for (const c of payload.connections) {
        if (!c || typeof c !== 'object') continue;
        const identity = connectionIdentity(c);
        if (!identity.stable && !c.id) continue;
        const prior = writes.get(identity.key) || this.db.prepare('SELECT down,up FROM seen WHERE key=?').get(identity.key);
        const down = number(c.download), up = number(c.upload);
        if (down === null || up === null) continue;
        const started = Date.parse(c.start);
        const firstObserved = !prior && same && identity.stable && Number.isFinite(started) && started >= previous.epochAt;
        // Counter regression with an unchanged lifetime is ambiguous: baseline, never re-add the full counter.
        const dd = prior ? Math.max(0, down - prior.down) : firstObserved ? down : 0;
        const du = prior ? Math.max(0, up - prior.up) : firstObserved ? up : 0;
        const counterReset = prior && (down < prior.down || up < prior.up);
        // Duplicate entries and ID changes within this response share the same high-water mark.
        const next = { down: prior ? Math.max(down, prior.down) : down, up: prior ? Math.max(up, prior.up) : up };
        writes.set(identity.key, next);
        if (counterReset) resets++;
        observedDown += dd; observedUp += du;
        const host = c.metadata?.host || c.metadata?.destinationIP || c.host;
        const target = this.preferences.targets.find(name => matches(host, name));
        if (target) {
          active.add(target);
          const delta = deltas.get(target);
          delta.down += dd; delta.up += du;
          if (counterReset || (firstObserved && started < previous.at)) delta.reliable = false;
        }
      }
      for (const [key, value] of writes) this.db.prepare('INSERT OR REPLACE INTO seen VALUES(?,?,?)').run(key, value.down, value.up);
      for (const [target, delta] of deltas) pending.push([target, this.add(target, at, delta.down, delta.up, elapsed, delta.reliable)]);
      let gd = 0, gu = 0;
      if (same && totalsAvailable && previous.globalDown !== null && previous.globalUp !== null) {
        // A regressed response is not evidence of a new controller epoch. Never lower the
        // persisted high-water mark: retries/stale responses must not make the next response count twice.
        gd = Math.max(0, globalDown - previous.globalDown); gu = Math.max(0, globalUp - previous.globalUp);
        if (resetGlobal) resets++;
      }
      if (totalsAvailable) this.add(GLOBAL_TARGET, at, gd, gu, elapsed, reliable);
      this.put('checkpoint', { source, at, epochAt: same ? previous.epochAt : at, globalDown: same ? globalDown === null ? previous.globalDown : Math.max(previous.globalDown ?? 0, globalDown) : globalDown,
        globalUp: same ? globalUp === null ? previous.globalUp : Math.max(previous.globalUp ?? 0, globalUp) : globalUp, totalsAvailable,
        observedDown: (same ? previous.observedDown || 0 : 0) + observedDown, observedUp: (same ? previous.observedUp || 0 : 0) + observedUp,
        accountedDown: (same ? previous.accountedDown || 0 : 0) + gd, accountedUp: (same ? previous.accountedUp || 0 : 0) + gu, resets,
        count: payload.connections.length, active: [...active] });
      const cutoff = this.preferences.history === '长期' ? 0 : at - (this.preferences.history === '30天' ? 30 : 7) * 86400000;
      this.db.prepare('DELETE FROM minutes WHERE at<?').run(cutoff);
      this.db.prepare('DELETE FROM legacy WHERE at<?').run(cutoff);
    });
    for (const [target, sample] of pending) {
      const recent = this.recent.get(target) || [];
      recent.push(sample);
      while (recent.length && recent[0].at < at - 600000) recent.shift();
      this.recent.set(target, recent);
    }
    return true;
  }
  history(target, since, until) {
    return this.db.prepare(`SELECT target,at,SUM(down) down,SUM(up) up,
      CASE WHEN COUNT(ds)=COUNT(*) THEN SUM(ds) ELSE NULL END downSeconds,
      CASE WHEN COUNT(us)=COUNT(*) THEN SUM(us) ELSE NULL END upSeconds FROM
      (SELECT * FROM minutes UNION ALL SELECT target,at,down,up,ds,us FROM legacy)
      WHERE target=? AND at>=? AND at<=? GROUP BY target,at ORDER BY at`).all(target, since, until).map(row => ({ ...row, id: row.target + '|' + row.at }));
  }
  snapshot(now = Date.now()) {
    const point = this.get('checkpoint');
    const totals = this.db.prepare(`SELECT target,SUM(down) down,SUM(up) up FROM (SELECT * FROM totals UNION ALL SELECT * FROM legacy_totals) GROUP BY target`).all();
    const byTarget = new Map(totals.map(row => [row.target, row]));
    const fresh = point && now - point.at <= 2500;
    const metrics = this.preferences.targets.map(target => {
      const total = byTarget.get(target) || { down: 0, up: 0 };
      const recent = (this.recent.get(target) || []).filter(s => s.at >= now - 600000);
      const last = recent.at(-1);
      return { target, totalDown: total.down, totalUp: total.up, connected: Boolean(fresh && point.active.includes(target)), updatedAt: point?.at || 0,
        downRate: fresh && last?.elapsed > 0 ? last.down / last.elapsed : 0, upRate: fresh && last?.elapsed > 0 ? last.up / last.elapsed : 0, rateSamples: recent };
    });
    return { metrics, at: point?.at || 0, count: fresh ? point.count : 0, global: byTarget.get(GLOBAL_TARGET) || { down: 0, up: 0 },
      coverage: { domain: 'active-snapshots-lower-bound', global: point?.totalsAvailable ? point.resets ? 'cumulative-with-discontinuities' : 'cumulative-controller-counters' : 'unavailable',
        unobservedDown: Math.max(0, (point?.accountedDown || 0) - (point?.observedDown || 0)), unobservedUp: Math.max(0, (point?.accountedUp || 0) - (point?.observedUp || 0)),
        discontinuities: point?.resets || 0, minuteAssignment: 'observation-time; outage timing unknown', finalConnectionEvents: false } };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
