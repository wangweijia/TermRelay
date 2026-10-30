import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { HOST, secretMatches } from './model.mjs';

export function attachProxy(server, { token, hostname = HOST, enabled = true }) {
  const sockets = new Set();
  const authenticated = request => {
    const password = typeof token === 'function' ? token() : token;
    return typeof password === 'string'
      && secretMatches(request.headers['proxy-authorization'], `Basic ${Buffer.from(`preview:${password}`).toString('base64')}`);
  };
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const httpTarget = request => {
    let url;
    try { url = new URL(request.url); } catch { return; }
    if (!enabled || !['http:', 'ws:'].includes(url.protocol) || url.hostname !== hostname
      || url.username || url.password || Number(url.port || 80) < 1) return;
    return url;
  };
  const headersFor = (request, url) => Object.fromEntries(Object.entries({ ...request.headers, host: url.host })
    .filter(([name]) => !['proxy-authorization', 'proxy-connection'].includes(name)));
  server.on('request', (request, response) => {
    if (!/^http:\/\//i.test(request.url ?? '')) return;
    const target = httpTarget(request);
    const code = !authenticated(request) ? 407 : !target ? 403 : 0;
    if (code) {
      response.writeHead(code, { ...(code === 407 ? { 'Proxy-Authenticate': 'Basic realm="TermRelay Preview"' } : {}), Connection: 'close' });
      response.end();
      return;
    }
    track(request.socket);
    const upstream = httpRequest({ hostname: '127.0.0.1', port: target.port || 80,
      method: request.method, path: `${target.pathname}${target.search}`, headers: headersFor(request, target), agent: false }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on('socket', track);
    upstream.setTimeout(5000, () => upstream.destroy(new Error('Local service connection timed out.')));
    upstream.on('response', () => upstream.setTimeout(0));
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, client, head) => {
    const target = httpTarget(request);
    const code = !authenticated(request) ? 407 : !target ? 403 : 0;
    if (code) {
      client.end(`HTTP/1.1 ${code} Rejected\r\n${code === 407 ? 'Proxy-Authenticate: Basic realm="TermRelay Preview"\r\n' : ''}Connection: close\r\n\r\n`);
      return;
    }
    track(client);
    const upstream = track(connect({ host: '127.0.0.1', port: Number(target.port || 80) }));
    upstream.setTimeout(5000, () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      const headers = Object.entries(headersFor(request, target)).map(([name, value]) => `${name}: ${value}`).join('\r\n');
      upstream.write(`${request.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  server.on('connect', (request, client, head) => {
    const reject = (status, extra = '') => client.end(
      `HTTP/1.1 ${status}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    if (!authenticated(request)) {
      reject('407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="TermRelay Preview"\r\n');
      return;
    }
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    const [host, rawPort, extra] = (request.url ?? '').split(':');
    const port = Number(rawPort);
    if (!enabled || host !== hostname || extra !== undefined || !/^\d{1,5}$/.test(rawPort ?? '') || port < 1 || port > 65535) {
      reject('403 Forbidden'); return;
    }
    const upstream = connect({ host: '127.0.0.1', port });
    sockets.add(upstream);
    upstream.setTimeout(5000);
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Local service connection timed out.')));
    upstream.on('error', () => {
      if (!connected) reject('502 Bad Gateway');
      else client.destroy();
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  return () => { for (const socket of sockets) socket.destroy(); };
}
