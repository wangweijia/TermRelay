import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEventRecord, SessionRecord } from '../sessions/session.repository';
import type {
  SessionEventListener,
  SessionStateListener,
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

test('does not push approval notifications for project API sessions', async () => {
  await withNotificationsService(false, async ({ publish, requests }) => {
    publish(approvalNotification());
    await settle();

    assert.equal(requests.length, 0);
  }, 'external');
});

test('does not push approval notifications when the session is gone', async () => {
  await withNotificationsService(false, async ({ publish, requests }) => {
    publish(approvalNotification());
    await settle();

    assert.equal(requests.length, 0);
  }, 'missing');
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

test('cancels a queued push when auto-approve is enabled after the request', async () => {
  await withNotificationsService(false, async ({ publish, requests, enableAutoApprove }) => {
    publish(approvalNotification());
    enableAutoApprove();
    await settle();
    assert.equal(requests.length, 0);
  });
});

test('does not push a request resolved immediately by the device', async () => {
  await withNotificationsService(false, async ({ publish, requests, clearPending }) => {
    publish(approvalNotification());
    clearPending();
    const resolved = approvalNotification();
    resolved.event.payload.kind = 'approval.resolved';
    publish(resolved);
    await settle();
    assert.equal(requests.length, 0);
  });
});

test('does not push replayed or expired requests absent from the pending projection', async () => {
  await withNotificationsService(false, async ({ publish, requests, clearPending }) => {
    clearPending();
    publish(approvalNotification());
    await settle();
    assert.equal(requests.length, 0);
  });
});

test('disabling push cancels already queued notifications', async () => {
  await withNotificationsService(false, async ({ publish, requests, disablePush }) => {
    publish(approvalNotification());
    await disablePush();
    await settle();
    assert.equal(requests.length, 0);
  });
});

test('duplicate requests queued together produce only one push', async () => {
  await withNotificationsService(false, async ({ publish, requests }) => {
    publish(approvalNotification()); publish(approvalNotification());
    await settle();
    assert.equal(requests.length, 1);
  });
});

test('resolution during the final session lookup cancels the in-flight notification check', async () => {
  await withNotificationsService(false, async ({ publish, requests, clearPending, setLookup }) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    setLookup(async () => { entered(); await resume; });
    // Production timers are unref'ed; keep this test alive while the check starts.
    const ticking = settle();
    publish(approvalNotification());
    await started;
    clearPending();
    const resolved = approvalNotification();
    resolved.event.payload.kind = 'approval.resolved';
    publish(resolved);
    release();
    await ticking;
    assert.equal(requests.length, 0);
  });
});

async function withNotificationsService(
  autoApproveEnabled: boolean,
  run: (context: {
    publish: (notification: ReturnType<typeof approvalNotification>) => void;
    requests: Array<{ url: string; body: string }>;
    enableAutoApprove: () => void;
    clearPending: () => void;
    disablePush: () => Promise<unknown>;
    setLookup: (lookup: () => Promise<void>) => void;
  }) => Promise<void>,
  origin: 'local' | 'external' | 'missing' = 'local',
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
  let stateListener: SessionStateListener | undefined;
  let isPending = true;
  let lookup = async () => {};
  const session = origin === 'missing' ? undefined : sessionRecord(autoApproveEnabled, origin);
  const sessions = {
    subscribe: (value: SessionEventListener) => {
      listener = value;
      return () => { listener = undefined; };
    },
    findById: async () => { await lookup(); return session; },
    listPendingApprovals: async () => isPending ? [{ sessionId: 'session-a', approvalId: 'approval-a', turnId: 'turn-a' }] : [],
    subscribeState: (value: SessionStateListener) => {
      stateListener = value;
      return () => { stateListener = undefined; };
    },
  } as unknown as SessionsService;
  const service = new NotificationsService(sessions);

  try {
    await service.onModuleInit();
    await service.setEnabled(true);
    await run({
      publish: (notification) => listener?.(notification),
      requests,
      enableAutoApprove: () => { if (session) { session.autoApproveEnabled = true; stateListener?.(session); } },
      clearPending: () => { isPending = false; },
      disablePush: () => service.setEnabled(false),
      setLookup: (value) => { lookup = value; },
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

function sessionRecord(autoApproveEnabled: boolean, origin: 'local' | 'external'): SessionRecord {
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
    origin,
    startedAt: timestamp,
    finishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 650));
}
