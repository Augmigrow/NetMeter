import { createHash } from 'node:crypto';

export class TrafficCollector {
  constructor({ ledger, fetchImpl = fetch, intervalMs = 1000, now = Date.now, timers = globalThis } = {}) {
    this.ledger = ledger; this.fetch = fetchImpl; this.interval = intervalMs; this.now = now; this.timers = timers;
    this.config = null; this.running = false; this.busy = false; this.generation = 0; this.status = 'disabled'; this.observations = [];
  }
  configure(config) {
    const key = config?.enabled ? createHash('sha256').update(config.address + '\0' + config.secret).digest('hex') : '';
    if (key === this.key) return;
    this.key = key; this.config = config; this.generation++; this.abort?.abort();
    this.status = config?.enabled ? 'connecting' : 'disabled';
    if (this.running && !this.busy) this.schedule(0);
  }
  start() { if (this.running) return; this.running = true; this.schedule(0); }
  schedule(delay) { if (this.timer) this.timers.clearTimeout(this.timer); if (this.running) this.timer = this.timers.setTimeout(() => this.tick(), delay); }
  async tick() {
    if (!this.running || this.busy) return;
    const generation = this.generation, key = this.key, config = this.config, started = this.now();
    if (!config?.enabled || !key) { this.schedule(this.interval); return; }
    this.busy = true; this.abort = new AbortController();
    const timeout = this.timers.setTimeout(() => this.abort?.abort(), 4000);
    try {
      const address = /^[a-z]+:\/\//i.test(config.address) ? config.address : 'http://' + config.address;
      const response = await this.fetch(new URL('/connections', address), { headers: { Authorization: 'Bearer ' + config.secret, Accept: 'application/json' }, cache: 'no-store', signal: this.abort.signal });
      if (!response.ok) throw Error('controller_error');
      const payload = await response.json();
      if (generation !== this.generation || !this.running) return;
      const at = this.now();
      this.ledger.ingest(payload, at, key);
      this.observations.push(at); if (this.observations.length > 400) this.observations.shift();
      this.status = 'connected';
    } catch { if (generation === this.generation) this.status = 'error'; }
    finally {
      this.timers.clearTimeout(timeout); this.busy = false;
      // Fixed cadence, no catch-up loop and no overlapping requests after stalls.
      this.schedule(generation === this.generation ? Math.max(0, this.interval - (this.now() - started)) : 0);
    }
  }
  snapshot() { return { ...this.ledger.snapshot(this.now()), status: this.status, enabled: Boolean(this.config?.enabled), diagnostics: { intervalMs: this.interval, observations: [...this.observations] } }; }
  stop() { this.running = false; this.generation++; if (this.timer) this.timers.clearTimeout(this.timer); this.abort?.abort(); }
}
