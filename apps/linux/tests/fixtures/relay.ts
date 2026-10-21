import { randomUUID } from 'node:crypto';
import type { Packet } from '../../src/protocol.js';

export function serverPacket(deviceId: string, type: string, payload: unknown, sessionId?: string, commandId?: string): Packet {
  return { event: 'message', data: {
    type, payload, deviceId, protocolVersion: '2', messageId: randomUUID(), sentAt: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}), ...(commandId ? { commandId } : {}),
  } };
}
