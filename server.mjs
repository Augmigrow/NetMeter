import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TrafficLedger } from './traffic-ledger.mjs';
import { TrafficCollector } from './traffic-collector.mjs';

const LOOPBACKS = new Set(['localhost', '127.0.0.1', '::1']);
const MAX_BODY_BYTES = 65536;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(JSON.stringify(payload));
}

function hostnameIsLoopback(hostname) {
  return LOOPBACKS.has(String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''));
}

function localRequestAllowed(request) {
  try {
    const requestHost = new URL('http://' + request.headers.host).host.toLowerCase();
    const requestHostname = new URL('http://' + request.headers.host).hostname;
    if (!hostnameIsLoopback(requestHostname)) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    const originUrl = new URL(origin);
    return hostnameIsLoopback(originUrl.hostname) && originUrl.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

function controllerUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 512) throw new Error('invalid_address');
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw);
  if (url.protocol !== 'http:' || !hostnameIsLoopback(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('invalid_address');
  }
  return url;
}

function restoredControllerConfig(value) {
  if (!value || typeof value.address !== 'string' || typeof value.secret !== 'string' || !value.secret || value.secret.length > 512) return null;
  try {
    return { enabled: value.enabled === true, address: controllerUrl(value.address), secret: value.secret };
  } catch {
    return null;
  }
}

function storableControllerConfig(config) {
  return config ? { enabled: config.enabled, address: config.address.host, secret: config.secret } : null;
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createNetMeterServer({ projectRoot = process.cwd(), fetchImpl = fetch, initialConfig = null, onConfigChanged = null, trafficStorePath = ':memory:', backgroundCollection = true } = {}) {
  let config = restoredControllerConfig(initialConfig);
  const root = resolve(projectRoot);
  const ledger = new TrafficLedger(trafficStorePath);
  const collector = new TrafficCollector({ ledger, fetchImpl });
  collector.configure(storableControllerConfig(config));
  const persistConfig = async nextConfig => {
    if (typeof onConfigChanged !== 'function') return true;
    try {
      await onConfigChanged(storableControllerConfig(nextConfig));
      return true;
    } catch {
      return false;
    }
  };

  const server = createHttpServer(async (request, response) => {
    if (!localRequestAllowed(request)) {
      sendJson(response, 403, { error: 'local_requests_only' });
      return;
    }

    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      try {
        const html = await readFile(join(root, 'index.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        });
        response.end(html);
      } catch {
        sendJson(response, 500, { error: 'page_unavailable' });
      }
      return;
    }

    if (request.method === 'GET' && pathname === '/api/status') {
      sendJson(response, 200, { enabled: Boolean(config?.enabled), configured: Boolean(config?.secret), address: config?.address?.host || '', collector: backgroundCollection });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/config') {
      try {
        const body = await readJson(request);
        if (typeof body.enabled !== 'boolean' || typeof body.address !== 'string' || typeof body.secret !== 'string' || body.secret.length > 512) {
          sendJson(response, 400, { error: 'invalid_config' });
          return;
        }
        const address = !body.enabled && !body.address.trim() ? (config?.address || null) : controllerUrl(body.address);
        const savedSecret = address && config?.address.host === address.host ? config.secret : '';
        const secret = body.secret.trim() ? body.secret : savedSecret;
        if (!body.enabled) {
          config = secret && address ? { enabled: false, address, secret } : null;
          collector.configure(storableControllerConfig(config));
          const persisted = await persistConfig(config);
          sendJson(response, 200, { ok: true, enabled: false, configured: Boolean(config?.secret), address: address?.host || '', persisted });
          return;
        }
        if (!secret.trim()) {
          sendJson(response, 400, { error: 'controller_secret_required' });
          return;
        }
        config = { enabled: true, address, secret };
        collector.configure(storableControllerConfig(config));
        const persisted = await persistConfig(config);
        sendJson(response, 200, { ok: true, enabled: true, configured: true, address: address.host, persisted });
      } catch (error) {
        sendJson(response, 400, { error: error.message === 'body_too_large' ? 'body_too_large' : 'invalid_config' });
      }
      return;
    }

    if (request.method === 'GET' && pathname === '/api/collector/state') {
      sendJson(response, 200, collector.snapshot()); return;
    }
    if (request.method === 'POST' && pathname === '/api/collector/settings') {
      try { ledger.setPreferences(await readJson(request)); sendJson(response, 200, { ok: true }); }
      catch { sendJson(response, 400, { error: 'invalid_preferences' }); }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/collector/import') {
      try { ledger.importLegacy((await readJson(request)).samples); sendJson(response, 200, { ok: true }); }
      catch { sendJson(response, 400, { error: 'invalid_import' }); }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/collector/history') {
      const query = new URL(request.url, 'http://localhost').searchParams;
      const target = query.get('target'), since = Number(query.get('since')), until = Number(query.get('until') || Date.now());
      if (!target || target.length > 512 || !Number.isFinite(since) || !Number.isFinite(until)) { sendJson(response, 400, { error: 'invalid_query' }); return; }
      sendJson(response, 200, ledger.history(target, since, until)); return;
    }

    if (request.method === 'GET' && pathname === '/api/connections') {
      if (!config?.enabled) {
        sendJson(response, 409, { error: 'controller_disabled' });
        return;
      }
      if (!config.secret) {
        sendJson(response, 401, { error: 'controller_secret_required' });
        return;
      }
      try {
        const upstream = await fetchImpl(new URL('/connections', config.address), {
          headers: { Authorization: 'Bearer ' + config.secret, Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(4000)
        });
        if (!upstream.ok) {
          sendJson(response, upstream.status, { error: upstream.status === 401 ? 'controller_unauthorized' : 'controller_error' });
          return;
        }
        const payload = await upstream.json();
        if (!payload || !Array.isArray(payload.connections)) {
          sendJson(response, 502, { error: 'invalid_controller_response' });
          return;
        }
        sendJson(response, 200, payload);
      } catch {
        sendJson(response, 502, { error: 'controller_unreachable' });
      }
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
  const closeServer = server.close.bind(server);
  server.close = (...args) => { collector.stop(); return closeServer(...args); };
  server.netmeterCollector = collector;
  server.netmeterLedger = ledger;
  server.once('listening', () => { if (backgroundCollection) collector.start(); });
  server.once('close', () => { collector.stop(); ledger.close(); });
  return server;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const port = Number(process.env.PORT || 4174);
  const server = createNetMeterServer({ projectRoot: resolve('.') });
  server.listen(port, '127.0.0.1', () => {
    console.log('NetMeter listening on http://127.0.0.1:' + port);
  });
}

