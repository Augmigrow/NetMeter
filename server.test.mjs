import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { createNetMeterServer } from './server.mjs';

const running = [];

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  running.push(server);
  return server.address().port;
}

async function postJson(url, value) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

test('local proxy keeps the secret in memory and forwards authenticated controller data', async () => {
  const requests = [];
  const savedConfigs = [];
  const upstream = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === '/connections') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ connections: [{ id: 'one', metadata: { host: 'example.com' }, upload: 42, download: 99 }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const upstreamPort = await listen(upstream);
  const app = createNetMeterServer({ backgroundCollection: false, projectRoot: process.cwd(), onConfigChanged: config => savedConfigs.push(config) });
  const appPort = await listen(app);
  const base = 'http://127.0.0.1:' + appPort;
  const secret = 'synthetic-test-secret';

  const saved = await postJson(base + '/api/config', { enabled: true, address: '127.0.0.1:' + upstreamPort, secret });
  assert.equal(saved.status, 200);
  const savedBody = await saved.text();
  assert.equal(savedBody.includes(secret), false);

  const proxied = await fetch(base + '/api/connections');
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { connections: [{ id: 'one', metadata: { host: 'example.com' }, upload: 42, download: 99 }] });
  assert.deepEqual(requests, [{ path: '/connections', authorization: 'Bearer ' + secret }]);

  const status = await (await fetch(base + '/api/status')).json();
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.deepEqual(savedConfigs[0], { enabled: true, address: '127.0.0.1:' + upstreamPort, secret });

  const disabled = await postJson(base + '/api/config', { enabled: false, address: '', secret: '' });
  assert.equal(disabled.status, 200);
  assert.equal((await fetch(base + '/api/connections')).status, 409);
  const disabledStatus = await (await fetch(base + '/api/status')).json();
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.configured, true);
  assert.deepEqual(savedConfigs[1], { enabled: false, address: '127.0.0.1:' + upstreamPort, secret });
});

test('controller addresses are restricted to loopback and secrets are required', async () => {
  const app = createNetMeterServer({ backgroundCollection: false, projectRoot: process.cwd() });
  const port = await listen(app);
  const base = 'http://127.0.0.1:' + port;

  const remote = await postJson(base + '/api/config', { enabled: true, address: 'https://example.com:9097', secret: 'not-used' });
  assert.equal(remote.status, 400);

  const missingSecret = await postJson(base + '/api/config', { enabled: true, address: '127.0.0.1:9097', secret: '' });
  assert.equal(missingSecret.status, 400);
});

test('a saved disabled controller can be re-enabled without submitting the secret again', async () => {
  const secret = 'synthetic-persisted-secret';
  let authorization;
  const app = createNetMeterServer({ backgroundCollection: false,
    projectRoot: process.cwd(),
    initialConfig: { enabled: false, address: '127.0.0.1:9097', secret },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return new Response(JSON.stringify({ connections: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  const port = await listen(app);
  const base = 'http://127.0.0.1:' + port;

  const initialStatus = await (await fetch(base + '/api/status')).json();
  assert.equal(initialStatus.enabled, false);
  assert.equal(initialStatus.configured, true);
  assert.equal(JSON.stringify(initialStatus).includes(secret), false);

  const enabled = await postJson(base + '/api/config', { enabled: true, address: '127.0.0.1:9097', secret: '' });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).persisted, true);
  assert.equal((await fetch(base + '/api/connections')).status, 200);
  assert.equal(authorization, 'Bearer ' + secret);
});


test('collector APIs are private to loopback, contain no secret, and import history/totals idempotently', async () => {
  const app = createNetMeterServer({ backgroundCollection: false });
  const port = await listen(app), base = 'http://127.0.0.1:' + port;
  const prefs = { targets: ['example.com'], history: '30天', legacyTotals: { 'example.com': { down: 100, up: 200 } } };
  for (let i = 0; i < 2; i++) assert.equal((await postJson(base + '/api/collector/settings', prefs)).status, 200);
  const sample = { target: 'example.com', at: 1794139200000, down: 100, up: 200, downSeconds: 2, upSeconds: 4 };
  for (let i = 0; i < 2; i++) assert.equal((await postJson(base + '/api/collector/import', { samples: [sample] })).status, 200);
  const history = await (await fetch(base + '/api/collector/history?target=example.com&since=0&until=9999999999999')).json();
  assert.equal(history.length, 1); assert.equal(history[0].up, 200);
  const state = await (await fetch(base + '/api/collector/state')).json();
  assert.equal(state.metrics[0].totalUp, 200);
  assert.equal(JSON.stringify(state).includes('secret'), false);
  assert.equal((await fetch(base + '/api/collector/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await postJson(base + '/api/collector/settings', { targets: 'not-array' })).status, 400);
});

test('the connections proxy accepts null idle lists with counters but rejects malformed payloads', async () => {
  let payload = { connections: null, downloadTotal: 100, uploadTotal: 200 };
  const app = createNetMeterServer({ backgroundCollection: false,
    initialConfig: { enabled: true, address: '127.0.0.1:9097', secret: 'synthetic' },
    fetchImpl: async () => new Response(JSON.stringify(payload))
  });
  const base = 'http://127.0.0.1:' + await listen(app);
  const idle = await fetch(base + '/api/connections');
  assert.equal(idle.status, 200);
  assert.deepEqual(await idle.json(), payload);
  for (const invalid of [null, {}, { connections: null }, { connections: 'invalid' }]) {
    payload = invalid;
    const response = await fetch(base + '/api/connections');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'invalid_controller_response' });
  }
});
