import { Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { ToolEventPayload } from '@termrelay/contracts';
import { DataSource } from 'typeorm';
import { SessionsService, type SessionEventNotification } from '../sessions/sessions.service';

export interface NotificationSettings { enabled: boolean; configured: boolean }

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private enabled = false;
  private unsubscribe?: () => void;
  private unsubscribeState?: () => void;
  private readonly pending = new Map<string, { sessionId: string; timer: NodeJS.Timeout }>();
  private readonly barkURL = process.env.BARK_PUSH_URL?.trim();

  constructor(
    private readonly sessions: SessionsService,
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.dataSource) {
      const rows = await this.dataSource.query<Array<{ enabled: number | boolean }>>(
        "SELECT enabled FROM notification_settings WHERE setting_key = 'bark_approval_push' LIMIT 1",
      );
      this.enabled = Boolean(rows[0]?.enabled);
    }
    this.unsubscribe = this.sessions.subscribe((event) => this.handleEvent(event));
    this.unsubscribeState = this.sessions.subscribeState((session) => {
      if (session.autoApproveEnabled || session.origin === 'external' || ['finished', 'failed'].includes(session.status)) {
        this.cancelPending(session.id);
      }
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.(); this.unsubscribeState?.(); this.cancelPending();
  }

  private cancelPending(sessionId?: string): void {
    for (const [key, item] of this.pending) {
      if (sessionId && item.sessionId !== sessionId) continue;
      clearTimeout(item.timer); this.pending.delete(key);
    }
  }

  getSettings(): NotificationSettings {
    return { enabled: this.enabled, configured: Boolean(this.barkURL) };
  }

  async setEnabled(enabled: boolean): Promise<NotificationSettings> {
    if (enabled && !this.barkURL) throw new Error('BARK_PUSH_URL is not configured.');
    this.enabled = enabled;
    if (!enabled) this.cancelPending();
    if (this.dataSource) {
      await this.dataSource.query(
        `INSERT INTO notification_settings (setting_key, enabled) VALUES ('bark_approval_push', ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
        [enabled],
      );
    }
    return this.getSettings();
  }

  private handleEvent(notification: SessionEventNotification): void {
    if (!this.enabled || !this.barkURL || notification.event.type !== 'tool.event') return;
    const payload = notification.event.payload as unknown as ToolEventPayload;
    const approvalId = payload.data.approvalId ?? payload.correlation.approvalId;
    if (typeof approvalId !== 'string' || !approvalId) return;
    const key = JSON.stringify([notification.sessionId, approvalId]);
    if (payload.kind === 'approval.resolved') {
      const pending = this.pending.get(key);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(key); }
      return;
    }
    if (payload.kind !== 'approval.requested') return;
    if (this.pending.has(key)) return;
    // Auto-resolution and reconnect replay often follow the request immediately.
    // Notify only after the durable pending-approval projection has caught up.
    const timer = setTimeout(() => {
      void this.pushApproval(notification, payload, () => this.pending.get(key) === item).catch((error: unknown) => {
        this.logger.error(`Bark approval push failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        if (this.pending.get(key) === item) this.pending.delete(key);
      });
    }, 500);
    timer.unref();
    const item = { sessionId: notification.sessionId, timer };
    this.pending.set(key, item);
  }

  private async pushApproval(notification: SessionEventNotification, payload: ToolEventPayload, isCurrent: () => boolean): Promise<void> {
    if (!this.enabled || !isCurrent()) return;
    const pending = (await this.sessions.listPendingApprovals()).some(approval =>
      approval.sessionId === notification.sessionId && approval.approvalId === (payload.data.approvalId ?? payload.correlation.approvalId)
      && approval.turnId === (payload.data.turnId ?? payload.correlation.turnId));
    if (!pending) return;
    const session = await this.sessions.findById(notification.sessionId);
    if (!session) {
      this.logger.warn(`Skipping approval push for missing session ${notification.sessionId}.`);
      return;
    }
    if (!this.enabled || !isCurrent() || session.deviceId !== notification.deviceId || session.autoApproveEnabled
      || session.origin === 'external' || !['starting', 'running'].includes(session.status)) return;
    const data = payload.data as Record<string, unknown>;
    const sessionName = session?.displayName?.trim() || session?.toolKey || notification.sessionId;
    const detail = String(data.detail || data.title || data.kind || 'Codex 请求批准一项操作');
    const response = await fetch(this.barkURL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        title: 'TermRelay · 待审批',
        subtitle: sessionName,
        body: detail.slice(0, 1500),
        group: 'TermRelay 审批',
        level: 'timeSensitive',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Bark returned HTTP ${response.status}`);
  }
}
