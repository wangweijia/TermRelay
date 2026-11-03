import { BadGatewayException, BadRequestException, GatewayTimeoutException, Injectable, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { attachmentRequestSchema, type AttachmentRequestPayload, type AttachmentResultPayload, type Envelope } from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { ProtocolSchemaValidator } from '../realtime/protocol-schema-validator';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { SessionsService } from './sessions.service';

@Injectable()
export class AttachmentsService implements OnModuleDestroy {
  private readonly pending = new Map<string, {
    client: WebSocket; deviceId: string; sessionId: string; timer: NodeJS.Timeout;
    resolve: (result: AttachmentResultPayload) => void; reject: (error: Error) => void;
  }>();
  private readonly validator = new ProtocolSchemaValidator<{ type: 'attachment.request'; envelope: Envelope<AttachmentRequestPayload> }>('browser', { 'attachment.request': attachmentRequestSchema });

  constructor(private readonly sessions: SessionsService, private readonly registry: DeviceConnectionRegistry) {}

  onModuleDestroy(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ServiceUnavailableException('Server is shutting down'));
    }
    this.pending.clear();
  }

  async capabilities(sessionId: string): Promise<{ supported: boolean }> {
    const session = await this.sessions.findById(sessionId);
    return { supported: !!session && session.runtimeMode === 'acp' && session.origin !== 'external'
      && this.registry.getDevice(session.deviceId)?.chatAttachments === true };
  }

  async transfer(sessionId: string, body: unknown): Promise<AttachmentResultPayload> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.runtimeMode !== 'acp' || session.origin === 'external') throw new NotFoundException('Chat session not found');
    if (typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body).some(key => !['operation', 'attachmentId', 'offset', 'attachment', 'data', 'final'].includes(key))) {
      throw new BadRequestException('Invalid attachment request');
    }
    const envelope: Envelope<unknown> = {
      type: 'attachment.request', protocolVersion: '2', messageId: randomUUID(), deviceId: session.deviceId,
      sessionId, sentAt: new Date().toISOString(),
      payload: { ...body, requestId: randomUUID(), workspaceId: session.workspaceId },
    };
    const checked = this.validator.validate(envelope);
    if (!checked.ok) throw new BadRequestException(checked.detail);
    const payload = checked.message.envelope.payload;
    if (payload.operation === 'purge') throw new BadRequestException('Use session deletion to remove history attachments');
    if (payload.operation !== 'read' && !['starting', 'running'].includes(session.status)) throw new BadRequestException('Session has ended');
    if (payload.operation === 'upload' && (!payload.attachment || payload.attachment.id !== payload.attachmentId || payload.data === undefined || payload.final === undefined)) {
      throw new BadRequestException('Upload requires matching metadata, data and final');
    }
    if (this.registry.getDevice(session.deviceId)?.chatAttachments !== true) throw new BadRequestException('This device does not support chat attachments; update the Mac client');
    const client = this.registry.getClient(session.deviceId);
    if (!client) throw new ServiceUnavailableException('Device is offline');
    if (this.pending.size >= 32 || [...this.pending.values()].filter(p => p.deviceId === session.deviceId).length >= 8) {
      throw new ServiceUnavailableException('Too many attachment transfers');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.requestId);
        reject(new GatewayTimeoutException('Device did not confirm attachment transfer'));
      }, 30_000);
      timer.unref();
      this.pending.set(payload.requestId, { client, deviceId: session.deviceId, sessionId, timer, resolve, reject });
      try { client.send(JSON.stringify({ event: 'message', data: envelope })); }
      catch {
        clearTimeout(timer); this.pending.delete(payload.requestId);
        reject(new ServiceUnavailableException('Unable to contact device'));
      }
    });
  }

  cleanup(session: { id: string; deviceId: string; workspaceId: string }): void {
    const client = this.registry.getClient(session.deviceId);
    if (!client || !this.registry.getDevice(session.deviceId)?.chatAttachments) return;
    const envelope: Envelope<AttachmentRequestPayload> = {
      type: 'attachment.request', protocolVersion: '2', messageId: randomUUID(), deviceId: session.deviceId,
      sessionId: session.id, sentAt: new Date().toISOString(),
      payload: { requestId: randomUUID(), workspaceId: session.workspaceId, operation: 'purge', attachmentId: randomUUID(), offset: 0 },
    };
    try { client.send(JSON.stringify({ event: 'message', data: envelope })); } catch { /* Device can disconnect during deletion. */ }
  }

  accept(client: WebSocket, envelope: Envelope<AttachmentResultPayload>): boolean {
    const entry = this.pending.get(envelope.payload.requestId);
    if (!entry || entry.client !== client || entry.sessionId !== envelope.sessionId || entry.deviceId !== envelope.deviceId
      || !this.registry.isRegisteredClient(client, envelope.deviceId)) return false;
    clearTimeout(entry.timer); this.pending.delete(envelope.payload.requestId);
    if (envelope.payload.status === 'error') entry.reject(new BadGatewayException(envelope.payload.message ?? 'Attachment unavailable'));
    else entry.resolve(envelope.payload);
    return true;
  }
}
