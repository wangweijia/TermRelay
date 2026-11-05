import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { TurnCommandRepository } from './turn-command.repository';

@Controller('api/sessions')
export class TurnCommandController {
  constructor(private readonly sessions: SessionsService, private readonly commands: TurnCommandRepository) {}

  @Get(':sessionId/commands/:commandId')
  @Header('Cache-Control', 'no-store')
  async find(@Param('sessionId') sessionId: string, @Param('commandId') commandId: string) {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(commandId)) throw new NotFoundException();
    const session = await this.sessions.findById(sessionId);
    const command = await this.commands.find(commandId);
    if (!session || !command || command.sessionId !== sessionId || command.deviceId !== session.deviceId) throw new NotFoundException();
    return { commandId: command.commandId, deviceId: command.deviceId, sessionId, ack: command.ack };
  }
}
