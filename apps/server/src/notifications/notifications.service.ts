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
  }

  onModuleDestroy(): void { this.unsubscribe?.(); }

  getSettings(): NotificationSettings {
    return { enabled: this.enabled, configured: Boolean(this.barkURL) };
  }

  async setEnabled(enabled: boolean): Promise<NotificationSettings> {
    if (enabled && !this.barkURL) throw new Error('BARK_PUSH_URL is not configured.');
    this.enabled = enabled;
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
    if (payload.kind !== 'approval.requested') return;
    void this.pushApproval(notification, payload).catch((error: unknown) => {
      this.logger.error(`Bark approval push failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async pushApproval(notification: SessionEventNotification, payload: ToolEventPayload): Promise<void> {
    const session = await this.sessions.findById(notification.sessionId);
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
