import { connect } from 'node:net';
import { secretMatches } from './model.mjs';

export function attachProxy(server, { ports, token }) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, client, head) => {
    const reject = (status, extra = '') => client.end(
      `HTTP/1.1 ${status}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    if (!secretMatches(request.headers['proxy-authorization'], `Basic ${Buffer.from(`preview:${token}`).toString('base64')}`)) {
      reject('407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="TermRelay Preview"\r\n');
      return;
    }
    const match = /^page-gateway-local\.nioint\.com:(\d{1,5})$/.exec(request.url ?? '');
    const port = Number(match?.[1]);
    if (!match || !ports.includes(port)) { reject('403 Forbidden'); return; }
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
