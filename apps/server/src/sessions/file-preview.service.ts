import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Envelope, FilePreviewRequestPayload, FilePreviewResultPayload } from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { SessionsService } from './sessions.service';

interface PendingPreview {
  client: WebSocket;
  deviceId: string;
  sessionId: string;
  resolve: (result: FilePreviewResultPayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class FilePreviewService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingPreview>();

  constructor(
    private readonly sessions: SessionsService,
    private readonly registry: DeviceConnectionRegistry,
  ) {}

  onModuleDestroy(): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new ServiceUnavailableException('Server is shutting down'));
      this.pending.delete(id);
    }
  }

  async preview(sessionId: string, path: string): Promise<{ name: string; content: string }> {
    if (path.length > 4096 || !/^\/(?:Users|Volumes)\//u.test(path) || path.includes('\0')) {
      throw new BadRequestException('Expected an absolute Mac file path');
    }
    const session = await this.sessions.findById(sessionId);
    if (!session || session.runtimeMode !== 'acp') throw new NotFoundException('session not found');
    const client = this.registry.getClient(session.deviceId);
    if (!client) throw new ServiceUnavailableException('Mac is offline');
    if (this.pending.size >= 32) throw new ServiceUnavailableException('Too many file previews');

    const requestId = randomUUID();
    const result = await new Promise<FilePreviewResultPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new GatewayTimeoutException('Mac did not return the file preview'));
      }, 15_000);
      timer.unref();
      this.pending.set(requestId, { client, deviceId: session.deviceId, sessionId, resolve, reject, timer });
      try {
        const envelope: Envelope<FilePreviewRequestPayload> = {
          type: 'file.preview.request', protocolVersion: '2', messageId: randomUUID(),
          deviceId: session.deviceId, sessionId, sentAt: new Date().toISOString(),
          payload: { requestId, workspaceId: session.workspaceId, path },
        };
        client.send(JSON.stringify({
          event: 'message',
          data: envelope,
        }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new ServiceUnavailableException('Unable to contact Mac'));
      }
    });
    switch (result.status) {
      case 'ok': return { name: result.name!, content: result.content! };
      case 'not_found': throw new NotFoundException('File not found');
      case 'forbidden': throw new BadRequestException('File is outside this session workspace');
      case 'too_large': throw new BadRequestException('File exceeds 512 KiB');
      case 'unsupported': throw new BadRequestException('Only UTF-8 Markdown files can be previewed');
      case 'error': throw new BadGatewayException('Mac could not read the file');
    }
  }

  accept(client: WebSocket, envelope: Envelope<FilePreviewResultPayload>): boolean {
    const { requestId } = envelope.payload;
    const request = this.pending.get(requestId);
    if (!request || request.client !== client || request.deviceId !== envelope.deviceId
      || request.sessionId !== envelope.sessionId
      || !this.registry.isRegisteredClient(client, envelope.deviceId)) return false;
    clearTimeout(request.timer);
    this.pending.delete(requestId);
    if (envelope.payload.content !== undefined
      && Buffer.byteLength(envelope.payload.content, 'utf8') > 512 * 1024) {
      request.reject(new BadGatewayException('File preview exceeds size limit'));
    } else {
      request.resolve(envelope.payload);
    }
    return true;
  }
}
