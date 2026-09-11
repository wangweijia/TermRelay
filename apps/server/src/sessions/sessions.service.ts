import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type {
  SessionStartedPayload,
  TerminalOutputPayload,
  WorkspaceRegisteredPayload,
} from '@termrelay/contracts';
import { DevicesService } from '../devices/devices.service';
import {
  DeviceConnectionRegistry,
  type DeviceSnapshot,
} from '../realtime/device-connection.registry';
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

export interface SessionEventNotification {
  deviceId: string;
  sessionId: string;
  event: SessionEventRecord;
}

export type SessionEventListener = (notification: SessionEventNotification) => void;

@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private readonly queues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<SessionEventListener>();
  private unsubscribeDevices?: () => void;

  constructor(
    private readonly devices: DevicesService,
    private readonly registry: DeviceConnectionRegistry,
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: SessionRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribeDevices = this.registry.subscribe((snapshot) => {
      if (snapshot.presence === 'offline') this.finishDisconnectedDevice(snapshot);
    });
    // No client connection survives a Server restart. Any genuinely active App
    // session will announce itself again immediately after reconnecting.
    await this.sessions.finishAllActive();
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = undefined;
    await this.waitForWrites();
  }

  async finishSession(sessionId: string): Promise<void> {
    await this.sessions.finishById(sessionId);
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
      const result = await this.sessions.registerStarted(
        deviceId,
        sessionId,
        payload,
      );
      this.publishAccepted(deviceId, sessionId, result);
      return mapSessionWrite(result);
    });
  }

  appendTerminalOutput(
    deviceId: string,
    sessionId: string,
    seq: number,
    payload: TerminalOutputPayload,
  ): Promise<ClientEventResult> {
    return this.serialize(deviceId, async () => {
      const result = await this.sessions.appendTerminalOutput(
        deviceId,
        sessionId,
        seq,
        payload,
      );
      this.publishAccepted(deviceId, sessionId, result);
      return mapSessionWrite(result);
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

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  private finishDisconnectedDevice(snapshot: DeviceSnapshot): void {
    void this.serialize(snapshot.deviceId, () =>
      this.sessions.finishActiveForDevice(
        snapshot.deviceId,
        snapshot.disconnectedAt ? new Date(snapshot.disconnectedAt) : new Date(),
      ),
    ).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to finish sessions for ${snapshot.deviceId}: ${detail}`);
    });
  }

  private publishAccepted(
    deviceId: string,
    sessionId: string,
    result: SessionWriteResult,
  ): void {
    if (result.status !== 'accepted') return;
    const notification: SessionEventNotification = {
      deviceId,
      sessionId,
      event: cloneEvent(result.event),
    };
    for (const listener of this.listeners) listener(notification);
  }
}

function mapSessionWrite(result: SessionWriteResult): ClientEventResult {
  switch (result.status) {
    case 'accepted':
    case 'duplicate':
      return { status: result.status };
    case 'unknown_session':
      return error('unknown_session', 'Session does not exist for this device.');
    case 'conflict':
      return error('conflict', result.detail);
  }
}

function cloneEvent(event: SessionEventRecord): SessionEventRecord {
  return {
    ...event,
    payload: structuredClone(event.payload),
  };
}

function error(
  code: Extract<ClientEventResult, { status: 'error' }>['code'],
  detail: string,
): ClientEventResult {
  return { status: 'error', code, detail };
}
