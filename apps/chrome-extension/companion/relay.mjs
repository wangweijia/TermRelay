import { randomUUID } from 'node:crypto';
import { RequestError, UUID, privateHost, promptFor } from './model.mjs';

export class Relay {
  constructor(baseURL, sessionId, { fetchImpl = fetch, Socket = WebSocket, timeout = 20_000 } = {}) {
    this.base = new URL(baseURL);
    if (!['http:', 'https:'].includes(this.base.protocol) || !privateHost(this.base.hostname)
      || this.base.username || this.base.password || this.base.pathname !== '/' || this.base.search || this.base.hash) {
      throw new Error('Relay URL must be a direct trusted LAN/loopback HTTP(S) origin, not a tunnel.');
    }
    if (!UUID.test(sessionId)) throw new Error('A valid --session UUID is required.');
    this.sessionId = sessionId;
    this.fetch = fetchImpl;
    this.Socket = Socket;
    this.timeout = timeout;
  }

  async session() {
    const response = await this.fetch(new URL(`/api/sessions/${this.sessionId}`, this.base), {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new RequestError(502, `TermRelay session lookup failed (${response.status}).`);
    const session = await response.json();
    if (session.id !== this.sessionId || !UUID.test(session.deviceId ?? '')
      || typeof session.workspaceId !== 'string' || !session.workspaceId.length || session.workspaceId.length > 256
      || session.status !== 'running' || session.runtimeMode !== 'acp' || session.origin === 'external') {
      throw new RequestError(409, 'Bind a running ordinary ACP session, not PTY or an external AI conversation.');
    }
    return session;
  }

  async deliver(record, expected) {
    const session = await this.session();
    if (session.deviceId !== expected.deviceId || session.workspaceId !== expected.workspaceId) {
      throw new RequestError(409, 'Session binding changed. Restart and verify the binding.');
    }
    const url = new URL('/ws/web', this.base);
    url.protocol = this.base.protocol === 'https:' ? 'wss:' : 'ws:';
    const envelope = {
      type: 'tool.turn.start', protocolVersion: '2', messageId: randomUUID(),
      commandId: record.commandId, deviceId: session.deviceId, sessionId: session.id,
      sentAt: new Date().toISOString(), payload: { text: promptFor(record) },
    };
    return new Promise(resolve => {
      let sent = false;
      let settled = false;
      const socket = new this.Socket(url);
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve(result);
      };
      const uncertain = detail => finish({ status: sent ? 'unknown' : 'failed', note: detail });
      const timer = setTimeout(() => uncertain('Delivery timed out. Verify the session in TermRelay before any further action.'), this.timeout);
      socket.addEventListener('open', () => {
        try {
          sent = true;
          socket.send(JSON.stringify({ event: 'message', data: envelope }));
        } catch (error) { uncertain(`WebSocket send failed: ${error.message}`); }
      });
      socket.addEventListener('message', event => {
        let reply;
        try { const wire = JSON.parse(String(event.data)); reply = wire.data ?? wire; }
        catch { uncertain('Invalid response from TermRelay.'); return; }
        if (reply.type === 'protocol.error' && reply.payload?.relatedMessageId === envelope.messageId) {
          finish({
            status: reply.payload.code === 'internal_error' ? 'unknown' : 'failed',
            note: String(reply.payload.detail ?? 'Command rejected.').slice(0, 1000),
          });
        }
        if (reply.type !== 'command.ack' || reply.commandId !== envelope.commandId
          || reply.sessionId !== session.id || reply.deviceId !== session.deviceId) return;
        if (reply.payload?.status === 'completed') {
          finish({ status: 'delivered', note: 'Command acknowledged, not AI completion. Developer must inspect the result in TermRelay.' });
        } else if (['rejected', 'failed'].includes(reply.payload?.status)) {
          const unknown = ['ack_timeout', 'agent_action_failed'].includes(reply.payload.errorCode);
          finish({
            status: unknown ? 'unknown' : 'failed',
            note: unknown ? 'Mac could not confirm execution; verify its outcome in TermRelay.'
              : String(reply.payload.message ?? 'Command rejected.').slice(0, 1000),
          });
        }
      });
      socket.addEventListener('error', () => uncertain('TermRelay WebSocket connection failed.'));
      socket.addEventListener('close', () => uncertain('TermRelay WebSocket disconnected before final acknowledgement.'));
    });
  }
}
