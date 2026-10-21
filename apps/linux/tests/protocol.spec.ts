import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { ToolEventPayload } from '@termrelay/contracts';
import { MAX_BUFFER, Protocol, type Command, type Packet } from '../src/protocol.js';

import { serverPacket } from './fixtures/relay.js';
function setup(mode: 'pty' | 'acp' = 'pty') {
  const packets: Packet[] = [], commands: Command[] = [];
  const protocol = new Protocol(randomUUID(), 'Linux', p => packets.push(p), c => commands.push(c));
  protocol.addWorkspace('w', 'Project'); protocol.start('s', 'w', mode === 'pty' ? 'shell' : 'codex', mode);
  const receive = (kind: string, payload: unknown, id = 's', commandId?: string) => protocol.receive(serverPacket(protocol.deviceId, kind, payload, id, commandId));
  protocol.connected(); receive('device.registered', { heartbeatIntervalMs: 15000 }); receive('session.synced', { lastAcceptedSeq: 0 });
  return { protocol, receive, packets, commands };
}

test('ordered PTY/ACP replay, acknowledgment and final event', () => {
  for (const mode of ['pty', 'acp'] as const) {
    const { protocol, receive, packets } = setup(mode);
    const event: ToolEventPayload = { kind: 'assistant.delta', occurredAt: new Date().toISOString(), correlation: {}, data: { text: 'hello 中文' } };
    protocol.append('s', mode === 'pty' ? Buffer.from('hello 中文') : event);
    assert.throws(() => protocol.append('s', mode === 'pty' ? event : Buffer.from('wrong')));
    protocol.end('s'); protocol.flush();
    const sent = packets.filter(p => p.data.seq === 1);
    assert.equal(sent.length, 1); assert.equal(sent[0]!.data.type, mode === 'pty' ? 'terminal.output' : 'tool.event');
    assert.equal(packets.some(p => p.data.type === 'session.ended'), false);
    protocol.connected(); receive('device.registered', { heartbeatIntervalMs: 15000 }); receive('session.synced', { lastAcceptedSeq: 0 });
    protocol.flush(); assert.equal(packets.filter(p => p.data.seq === 1).length, 2);
    receive('session.synced', { lastAcceptedSeq: 1 }); protocol.flush();
    assert.equal(packets.filter(p => p.data.type === 'session.ended').length, 1);
    assert.equal(protocol.unacknowledgedBytes, 0);
    assert.throws(() => receive('session.synced', { lastAcceptedSeq: 0 }));
  }
});

test('bounded output window, global exact memory threshold and no premature success', () => {
  const { protocol, receive, packets, commands } = setup();
  for (let i = 0; i < 100; i++) protocol.append('s', Buffer.from('x'));
  protocol.flush(); protocol.flush();
  assert.equal(packets.filter(p => p.data.type === 'terminal.output').length, 32);
  receive('session.synced', { lastAcceptedSeq: 32 }); protocol.flush();
  assert.equal(packets.filter(p => p.data.type === 'terminal.output').length, 64);
  const id = randomUUID(); receive('terminal.resize', { columns: 80, rows: 24 }, 's', id);
  assert.equal((packets.at(-1)!.data.payload as { status: string }).status, 'accepted');
  protocol.complete(commands[0]!);
  receive('terminal.resize', { columns: 80, rows: 24 }, 's', id);
  assert.equal(commands.length, 1);
  assert.equal((packets.at(-1)!.data.payload as { status: string }).status, 'completed');
  const fresh = setup().protocol;
  fresh.append('s', Buffer.alloc(MAX_BUFFER));
  assert.throws(() => fresh.append('s', Buffer.from('x')), /16 MiB/);
});

test('commands validate payload, mode, device identity and cross-session deduplication', () => {
  const { protocol, receive, packets, commands } = setup('acp');
  for (const [kind, payload] of [['terminal.resize', { columns: 80, rows: 24 }], ['tool.turn.start', {}], ['session.start', {}]] as const) {
    receive(kind, payload, 's', randomUUID());
    assert.equal((packets.at(-1)!.data.payload as { status: string }).status, 'rejected');
  }
  assert.equal(commands.length, 0);
  assert.throws(() => protocol.receive(serverPacket('other', 'session.synced', { lastAcceptedSeq: 0 }, 's')));
  const id = randomUUID(); receive('tool.turn.start', { text: 'hello' }, 's', id);
  assert.throws(() => receive('tool.turn.start', { text: 'hello' }, 'other', id));
});

test('remote creation validates workspace/mode and deduplicates accepted, failed and completed requests', () => {
  const { protocol, receive, packets, commands } = setup();
  protocol.addWorkspace('authorized', 'Project', [{ toolKey: 'codex', runtimeMode: 'acp' }]);
  const id = randomUUID();
  const payload = { workspaceId: 'authorized', toolKey: 'codex', runtimeMode: 'acp' };
  receive('session.start', payload, id, id);
  receive('session.start', payload, id, id);
  assert.equal(commands.length, 1);
  assert.equal((packets.at(-1)!.data.payload as { status: string }).status, 'accepted');
  protocol.complete(commands[0]!, new Error('Provider not ready'));
  receive('session.start', payload, id, id);
  assert.equal(commands.length, 1);
  assert.equal((packets.at(-1)!.data.payload as { status: string }).status, 'failed');
  receive('session.start', { ...payload, displayName: 'Changed' }, id, id);
  assert.equal((packets.at(-1)!.data.payload as { errorCode: string }).errorCode, 'conflict');
  for (const changed of [{ workspaceId: 'w' }, { runtimeMode: 'pty', rows: 24, columns: 80 }, { path: '/tmp' }, { rows: 24 }]) {
    const rejected = randomUUID();
    receive('session.start', { ...payload, ...changed }, rejected, rejected);
    assert.equal((packets.at(-1)!.data.payload as { status: string }).status, 'rejected');
  }
  const successful = randomUUID();
  receive('session.start', payload, successful, successful);
  protocol.start(successful, 'authorized', 'codex', 'acp');
  protocol.complete(commands.at(-1)!);
  receive('session.start', payload, successful, successful);
  assert.equal(commands.length, 2);
  assert.equal((packets.at(-1)!.data.payload as { status: string }).status, 'completed');
});
