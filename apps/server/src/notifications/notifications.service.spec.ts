import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEventRecord, SessionRecord } from '../sessions/session.repository';
import type {
  SessionEventListener,
  SessionsService,
} from '../sessions/sessions.service';
import { NotificationsService } from './notifications.service';

test('does not push approval notifications for auto-approved sessions', async () => {
  await withNotificationsService(true, async ({ publish, requests }) => {
    publish(approvalNotification());
    await settle();

    assert.equal(requests.length, 0);
  });
});

test('pushes approval notifications when auto-approve is disabled', async () => {
  await withNotificationsService(false, async ({ publish, requests }) => {
    publish(approvalNotification());
    await settle();

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://api.day.app/device-key');
    assert.match(requests[0]?.body ?? '', /运行测试/);
  });
});

async function withNotificationsService(
  autoApproveEnabled: boolean,
  run: (context: {
    publish: (notification: ReturnType<typeof approvalNotification>) => void;
    requests: Array<{ url: string; body: string }>;
  }) => Promise<void>,
): Promise<void> {
  const originalURL = process.env.BARK_PUSH_URL;
  const originalFetch = globalThis.fetch;
  process.env.BARK_PUSH_URL = 'https://api.day.app/device-key';
  const requests: Array<{ url: string; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response(null, { status: 200 });
  };

  let listener: SessionEventListener | undefined;
  const session = sessionRecord(autoApproveEnabled);
  const sessions = {
    subscribe: (value: SessionEventListener) => {
      listener = value;
      return () => { listener = undefined; };
    },
    findById: async () => session,
  } as unknown as SessionsService;
  const service = new NotificationsService(sessions);

  try {
    await service.onModuleInit();
    await service.setEnabled(true);
    await run({
      publish: (notification) => listener?.(notification),
      requests,
    });
  } finally {
    service.onModuleDestroy();
    globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.BARK_PUSH_URL;
    else process.env.BARK_PUSH_URL = originalURL;
  }
}

function approvalNotification() {
  return {
    deviceId: 'device-a',
    sessionId: 'session-a',
    event: {
      seq: 1,
      type: 'tool.event',
      payload: {
        kind: 'approval.requested',
        occurredAt: new Date(1_000).toISOString(),
        correlation: { turnId: 'turn-a', approvalId: 'approval-a' },
        data: {
          approvalId: 'approval-a',
          turnId: 'turn-a',
          kind: 'command',
          risk: 'high',
          title: '运行测试',
        },
      },
      createdAt: new Date(1_000).toISOString(),
    } satisfies SessionEventRecord,
  };
}

function sessionRecord(autoApproveEnabled: boolean): SessionRecord {
  const timestamp = new Date(1_000).toISOString();
  return {
    id: 'session-a',
    deviceId: 'device-a',
    workspaceId: 'workspace-a',
    toolKey: 'copilot',
    displayName: 'Copilot Session',
    runtimeMode: 'acp',
    status: 'running',
    stateVersion: 1,
    autoApproveEnabled,
    startedAt: timestamp,
    finishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}