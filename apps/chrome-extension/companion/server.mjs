import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RequestError, UUID, reviewerView, secretMatches, validateFeedback } from './model.mjs';
import { attachProxy } from './proxy.mjs';

async function bodyOf(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 24_000) throw new RequestError(413, 'Feedback exceeds 24 KB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON body.'); }
}

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function authorize(request, token) {
  if (!secretMatches(request.headers.authorization, `Bearer ${token}`)) throw new RequestError(401, 'Invalid access token.');
}

export function createCompanion({ store, relay, binding, ports, reviewerToken, adminToken, proxyToken }) {
  let busy = false;
  const update = async (record, patch) => {
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    await store.save();
    return record;
  };
  const handle = admin => async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const origin = request.headers.origin;
      if (admin) {
        const host = request.headers.host;
        if (!/^127\.0\.0\.1:\d+$/.test(host ?? '') || (origin && origin !== `http://${host}`)) {
          throw new RequestError(403, 'Owner console is loopback-only and same-origin.');
        }
        if (url.pathname === '/' && request.method === 'GET') {
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          });
          response.end(await readFile(new URL('./owner.html', import.meta.url)));
          return;
        }
        if (['/owner.js', '/owner.css'].includes(url.pathname) && request.method === 'GET') {
          response.writeHead(200, {
            'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(await readFile(new URL(`.${url.pathname}`, import.meta.url)));
          return;
        }
        authorize(request, adminToken);
        if (url.pathname === '/api/state' && request.method === 'GET') {
          json(response, 200, { binding, ports, busy, records: store.records, reviewerToken, proxyToken });
          return;
        }
      } else {
        if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
          throw new RequestError(403, 'Use the authorized browser extension, not a business page script.');
        }
        authorize(request, reviewerToken);
        if (url.pathname === '/v1/meta' && request.method === 'GET') {
          json(response, 200, { name: binding.name, ports });
          return;
        }
        if (url.pathname === '/v1/feedback' && request.method === 'GET') {
          json(response, 200, store.records.map(reviewerView));
          return;
        }
        if (url.pathname === '/v1/feedback' && request.method === 'POST') {
          const input = validateFeedback(await bodyOf(request), ports);
          const prior = store.records.find(record => record.id === input.id);
          if (prior) {
            const original = Object.fromEntries(Object.keys(input).map(key => [key, prior[key]]));
            if (JSON.stringify(original) !== JSON.stringify(input)) throw new RequestError(409, 'Feedback ID already used with different content.');
            await store.save();
            json(response, 200, reviewerView(prior));
            return;
          }
          if (store.records.length >= 1000) throw new RequestError(409, 'Feedback storage is full. Ask the owner to archive this preview.');
          const now = new Date().toISOString();
          const record = { ...input, status: 'pending', createdAt: now, updatedAt: now, note: '' };
          store.records.unshift(record);
          await store.save();
          json(response, 201, reviewerView(record));
          return;
        }
      }

      const match = /^\/(?:api|v1)\/feedback\/([^/]+)\/(deliver|review|verify)$/.exec(url.pathname);
      if (!match || request.method !== 'POST' || !UUID.test(match[1])) throw new RequestError(404, 'Not found.');
      const record = store.records.find(item => item.id === match[1]);
      if (!record) throw new RequestError(404, 'Feedback not found.');
      const action = match[2];
      if (!admin && action === 'verify' && url.pathname.startsWith('/v1/')) {
        const body = await bodyOf(request);
        if (record.status !== 'awaiting_review' || !['verified', 'changes_requested'].includes(body.status)) {
          throw new RequestError(409, 'Feedback is not awaiting review.');
        }
        if (typeof body.note !== 'string' || body.note.length > 2000 || (body.status === 'changes_requested' && !body.note.trim())) {
          throw new RequestError(400, 'A short follow-up description is required when changes are requested.');
        }
        await update(record, { status: body.status, note: body.note.trim() });
        json(response, 200, reviewerView(record));
        return;
      }
      if (!admin || !url.pathname.startsWith('/api/')) throw new RequestError(403, 'Owner confirmation is required.');
      if (action === 'review') {
        const body = await bodyOf(request);
        if (!['delivered', 'unknown'].includes(record.status) || body.checked !== true
          || !['completed', 'failed'].includes(body.outcome ?? 'completed')
          || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 2000) {
          throw new RequestError(409, 'Inspect execution in TermRelay and provide a result summary first.');
        }
        await update(record, { status: body.outcome === 'failed' ? 'failed' : 'awaiting_review', note: body.note.trim() });
        json(response, 200, record);
        return;
      }
      if (action !== 'deliver' || record.status !== 'pending') throw new RequestError(409, 'Feedback was already attempted; no automatic resend is allowed.');
      if (busy || store.records.some(item => ['sending', 'delivered', 'unknown'].includes(item.status))) {
        throw new RequestError(409, 'Finish or reconcile the previous execution in TermRelay first.');
      }
      busy = true;
      try {
        // Persist intent before network I/O; after a crash this becomes unknown, never pending.
        await update(record, { status: 'sending', commandId: randomUUID(), note: '' });
        let result;
        try { result = await relay.deliver(record, binding); }
        catch (error) { result = { status: 'failed', note: error.message }; }
        await update(record, result);
        json(response, 200, record);
      } finally { busy = false; }
    } catch (error) {
      if (!(error instanceof RequestError)) console.error('Companion request failed:', error.message);
      if (!response.headersSent) json(response, error.status ?? 500, { error: error instanceof RequestError ? error.message : 'Local companion failed. Check its terminal.' });
      else response.destroy();
    }
  };
  const publicServer = createServer(handle(false));
  const adminServer = createServer(handle(true));
  const closeProxy = attachProxy(publicServer, { ports, token: proxyToken });
  for (const server of [publicServer, adminServer]) {
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
  }
  return { publicServer, adminServer, closeProxy };
}
