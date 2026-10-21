import WebSocket from 'ws';
import { MAX_MESSAGE, serverURL } from './util.js';
import { credential } from './config.js';
import type { Packet } from './protocol.js';

export type RelayEvent = { kind: 'connected' } | { kind: 'disconnected'; reason: string } | { kind: 'message'; packet: unknown } | { kind: 'fatal'; error: Error };
export interface Connection { start(): void; send(packet: Packet): void; close(): void }

export class RelayConnection implements Connection {
  private socket?: WebSocket;
  private retry?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private closing = false;
  private delay = 1000;
  constructor(private readonly url: string, private readonly token: string, private readonly event: (event: RelayEvent) => void) {
    const parsed = serverURL(url);
    if (token) credential(token);
    if (parsed.pathname === '/ws/client-public' && !token) throw new Error('Public connection requires pairing');
  }
  start(): void {
    if (this.closing) throw new Error('Connection is closed');
    const socket = new WebSocket(this.url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      handshakeTimeout: 10000, maxPayload: MAX_MESSAGE, followRedirects: false,
    });
    this.socket = socket;
    let alive = true;
    socket.on('open', () => {
      if (this.closing || this.socket !== socket) return;
      this.delay = 1000;
      this.ping = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false; socket.ping();
      }, 15000);
      this.event({ kind: 'connected' });
    });
    socket.on('pong', () => { alive = true; });
    socket.on('message', (data, binary) => {
      if (this.closing || this.socket !== socket) return;
      try {
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (binary || raw.byteLength > MAX_MESSAGE) throw new Error('Invalid Server frame');
        this.event({ kind: 'message', packet: JSON.parse(raw.toString()) });
      } catch {
        this.event({ kind: 'fatal', error: new Error('Invalid Server message or protocol callback failure') });
        this.close();
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.event({ kind: 'fatal', error: new Error('Device authorization rejected; pair again') });
        this.close();
      } else {
        // No response body, headers, credential or URL is exposed.
        socket.terminate();
      }
    });
    socket.on('error', () => {
      // ws emits close after errors; reconnect and report sanitized state there.
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      clearInterval(this.ping);
      if (this.closing) return;
      this.event({ kind: 'disconnected', reason: 'Relay connection closed; retrying' });
      this.retry = setTimeout(() => this.start(), this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    });
  }
  send(packet: Packet): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Relay is not connected');
    const data = JSON.stringify(packet);
    if (Buffer.byteLength(data) > MAX_MESSAGE || socket.bufferedAmount > 4 * MAX_MESSAGE) throw new Error('Relay output buffer exceeded');
    socket.send(data, error => {
      if (error && !this.closing) socket.terminate();
    });
  }
  close(): void {
    this.closing = true;
    clearInterval(this.ping); clearTimeout(this.retry);
    this.socket?.terminate();
  }
}
