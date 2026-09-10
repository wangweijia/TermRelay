import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type {
  SessionStartedPayload,
  TerminalOutputPayload,
  WorkspaceRegisteredPayload,
} from '@termrelay/contracts';
import { DevicesService } from '../devices/devices.service';
import {
  SessionRepository,
  type SessionEventRecord,
  type SessionRecord,
  type SessionWriteResult,
} from './session.repository';
import { WorkspaceRepository } from './workspace.repository';

export type ClientEventResult =
  | { status: 'accepted' | 'duplicate' }
  | {
      status: 'error';
      code: 'unknown_device' | 'unknown_session' | 'unauthorized_workspace' | 'conflict';
      detail: string;
    };

@Injectable()
export class SessionsService implements OnModuleDestroy {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly devices: DevicesService,
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: SessionRepository,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.waitForWrites();
  }

  registerWorkspace(
    deviceId: string,
    payload: WorkspaceRegisteredPayload,
  ): Promise<ClientEventResult> {
    return this.serialize(deviceId, async () => {
      if (!(await this.devices.findById(deviceId))) {
        return error('unknown_device', 'Device is not registered.');
      }
      if (!this.workspaces.enabled) {
        return error('conflict', 'Workspace persistence requires a database.');
      }
      const result = await this.workspaces.register(deviceId, payload);
      return result === 'accepted'
        ? { status: 'accepted' }
        : error('conflict', 'Workspace ID belongs to another device.');
    });
  }

  registerSession(
    deviceId: string,
    sessionId: string,
    payload: SessionStartedPayload,
  ): Promise<ClientEventResult> {
    return this.serialize(deviceId, async () => {
      const workspace = await this.workspaces.findById(payload.workspaceId);
      if (
        !workspace ||
        workspace.deviceId !== deviceId ||
        !workspace.available
      ) {
        return error(
          'unauthorized_workspace',
          'Session workspace is not registered and available for this device.',
        );
      }
      return mapSessionWrite(
        await this.sessions.registerStarted(deviceId, sessionId, payload),
      );
    });
  }

  appendTerminalOutput(
    deviceId: string,
    sessionId: string,
    seq: number,
    payload: TerminalOutputPayload,
  ): Promise<ClientEventResult> {
    return this.serialize(deviceId, async () => {
      return mapSessionWrite(
        await this.sessions.appendTerminalOutput(
          deviceId,
          sessionId,
          seq,
          payload,
        ),
      );
    });
  }

  async list(): Promise<SessionRecord[]> {
    await this.waitForWrites();
    return this.sessions.list();
  }

  async findById(id: string): Promise<SessionRecord | undefined> {
    await this.waitForWrites();
    return this.sessions.findById(id);
  }

  async listEvents(
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<SessionEventRecord[] | undefined> {
    await this.waitForWrites();
    if (!(await this.sessions.findById(sessionId))) return undefined;
    return this.sessions.listEvents(sessionId, afterSeq, limit);
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    const tracked = operation
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.queues.get(key) === tracked) this.queues.delete(key);
      });
    this.queues.set(key, tracked);
    return operation;
  }

  private async waitForWrites(): Promise<void> {
    await Promise.all(this.queues.values());
  }
}

function mapSessionWrite(result: SessionWriteResult): ClientEventResult {
  switch (result.status) {
    case 'accepted':
    case 'duplicate':
      return result;
    case 'unknown_session':
      return error('unknown_session', 'Session does not exist for this device.');
    case 'conflict':
      return error('conflict', result.detail);
  }
}

function error(
  code: Extract<ClientEventResult, { status: 'error' }>['code'],
  detail: string,
): ClientEventResult {
  return { status: 'error', code, detail };
}
