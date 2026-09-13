import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { NotificationsService, type NotificationSettings } from './notifications.service';

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('settings')
  settings(): NotificationSettings { return this.notifications.getSettings(); }

  @Put('settings')
  async update(@Body() body: unknown): Promise<NotificationSettings> {
    if (!body || typeof body !== 'object' || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }
    try {
      return await this.notifications.setEnabled((body as { enabled: boolean }).enabled);
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }
}
