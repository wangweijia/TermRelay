import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DeviceHeartbeatPayload, DeviceRegisterPayload } from '@termrelay/contracts';
import type WebSocket from 'ws';

export type ClientConnectionState = 'connected' | 'registered';
export type DevicePresence = 'online' | 'offline';

export interface DeviceSnapshot {
  deviceId: string;
  name: string;
  appVersion: string;
  platform: 'macOS';
  tools: string[];
  presence: DevicePresence;
  connectionState: DeviceHeartbeatPayload['connectionState'];
  activeSessionCount: number;
  registeredAt: string;
  lastSeenAt: string;
  disconnectedAt?: string;
}

interface ClientConnection {
  client: WebSocket;
  state: ClientConnectionState;
  connectedAtMs: number;
  lastSeenAtMs: number;
  deviceId?: string;
}

export interface ExpiredConnection {
  reason: 'registration_timeout' | 'heartbeat_timeout';
  deviceId?: string;
}

export type DeviceSnapshotListener = (snapshot: DeviceSnapshot) => void;

@Injectable()
export class DeviceConnectionRegistry implements OnModuleInit, OnModuleDestroy {
  readonly heartbeatIntervalMs = readPositiveInteger(
    'CLIENT_HEARTBEAT_INTERVAL_MS',
    15_000,
  );
  readonly heartbeatTimeoutMs = readPositiveInteger(
    'CLIENT_HEARTBEAT_TIMEOUT_MS',
    45_000,
  );
  readonly registrationTimeoutMs = readPositiveInteger(
    'CLIENT_REGISTRATION_TIMEOUT_MS',
    10_000,
  );
  private readonly sweepIntervalMs = readPositiveInteger(
    'CLIENT_SWEEP_INTERVAL_MS',
    5_000,
  );

  private readonly connections = new Map<WebSocket, ClientConnection>();
  private readonly clientsByDeviceId = new Map<string, WebSocket>();
  private readonly devices = new Map<string, DeviceSnapshot>();
  private readonly listeners = new Set<DeviceSnapshotListener>();
  private sweepTimer?: NodeJS.Timeout;

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.expireStaleConnections(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  connect(client: WebSocket, nowMs = Date.now()): void {
    this.connections.set(client, {
      client,
      state: 'connected',
      connectedAtMs: nowMs,
      lastSeenAtMs: nowMs,
    });
  }

  register(
    client: WebSocket,
    deviceId: string,
    payload: DeviceRegisterPayload,
    nowMs = Date.now(),
  ): DeviceSnapshot {
    const connection = this.connections.get(client);
    if (!connection) throw new Error('Client connection is not registered with the gateway.');

    const previousClient = this.clientsByDeviceId.get(deviceId);
    if (previousClient && previousClient !== client) {
      this.connections.delete(previousClient);
      safeClose(previousClient, 4000, 'replaced by a newer device connection');
    }

    if (connection.deviceId && connection.deviceId !== deviceId) {
      this.clientsByDeviceId.delete(connection.deviceId);
      this.markOffline(connection.deviceId, nowMs);
    }

    const registeredAt = new Date(nowMs).toISOString();
    const snapshot: DeviceSnapshot = {
      deviceId,
      name: payload.name,
      appVersion: payload.appVersion,
      platform: payload.platform,
      tools: [...payload.tools],
      presence: 'online',
      connectionState: 'connected',
      activeSessionCount: 0,
      registeredAt,
      lastSeenAt: registeredAt,
    };

    connection.state = 'registered';
    connection.deviceId = deviceId;
    connection.lastSeenAtMs = nowMs;
    this.clientsByDeviceId.set(deviceId, client);
    this.devices.set(deviceId, snapshot);
    this.publish(snapshot);
    return cloneSnapshot(snapshot);
  }

  heartbeat(
    client: WebSocket,
    deviceId: string,
    payload: DeviceHeartbeatPayload,
    nowMs = Date.now(),
  ): DeviceSnapshot | undefined {
    const connection = this.connections.get(client);
    if (
      !connection ||
      connection.state !== 'registered' ||
      connection.deviceId !== deviceId ||
      this.clientsByDeviceId.get(deviceId) !== client
    ) {
      return undefined;
    }

    const device = this.devices.get(deviceId);
    if (!device) return undefined;

    connection.lastSeenAtMs = nowMs;
    device.presence = 'online';
    device.connectionState = payload.connectionState;
    device.activeSessionCount = payload.activeSessionCount ?? 0;
    device.lastSeenAt = new Date(nowMs).toISOString();
    delete device.disconnectedAt;
    this.publish(device);
    return cloneSnapshot(device);
  }

  disconnect(client: WebSocket, nowMs = Date.now()): void {
    const connection = this.connections.get(client);
    if (!connection) return;

    this.connections.delete(client);
    if (
      connection.deviceId &&
      this.clientsByDeviceId.get(connection.deviceId) === client
    ) {
      this.clientsByDeviceId.delete(connection.deviceId);
      this.markOffline(connection.deviceId, nowMs);
    }
  }

  expireStaleConnections(nowMs = Date.now()): ExpiredConnection[] {
    const expired: ExpiredConnection[] = [];
    for (const connection of [...this.connections.values()]) {
      if (
        connection.state === 'connected' &&
        nowMs - connection.connectedAtMs >= this.registrationTimeoutMs
      ) {
        expired.push({ reason: 'registration_timeout' });
        this.disconnect(connection.client, nowMs);
        safeClose(connection.client, 4001, 'device registration timeout');
        continue;
      }

      if (
        connection.state === 'registered' &&
        nowMs - connection.lastSeenAtMs >= this.heartbeatTimeoutMs
      ) {
        expired.push({
          reason: 'heartbeat_timeout',
          ...(connection.deviceId ? { deviceId: connection.deviceId } : {}),
        });
        this.disconnect(connection.client, nowMs);
        safeClose(connection.client, 4002, 'device heartbeat timeout');
      }
    }
    return expired;
  }

  getConnectionState(client: WebSocket): ClientConnectionState | undefined {
    return this.connections.get(client)?.state;
  }

  getDeviceId(client: WebSocket): string | undefined {
    return this.connections.get(client)?.deviceId;
  }

  getClient(deviceId: string): WebSocket | undefined {
    return this.clientsByDeviceId.get(deviceId);
  }

  getDevice(deviceId: string): DeviceSnapshot | undefined {
    const device = this.devices.get(deviceId);
    return device ? cloneSnapshot(device) : undefined;
  }

  listDevices(): DeviceSnapshot[] {
    return [...this.devices.values()].map(cloneSnapshot);
  }

  subscribe(listener: DeviceSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private markOffline(deviceId: string, nowMs: number): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.presence = 'offline';
    device.disconnectedAt = new Date(nowMs).toISOString();
    this.publish(device);
  }

  private publish(device: DeviceSnapshot): void {
    const snapshot = cloneSnapshot(device);
    for (const listener of this.listeners) listener(snapshot);
  }
}

function cloneSnapshot(device: DeviceSnapshot): DeviceSnapshot {
  return { ...device, tools: [...device.tools] };
}

function safeClose(client: WebSocket, code: number, reason: string): void {
  try {
    client.close(code, reason);
  } catch {
    // The socket may already be closing; registry cleanup has still completed.
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
