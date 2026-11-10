import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CommandRelayService } from './command-relay.service';
import { TurnCommandRepository } from './turn-command.repository';
import { TurnCommandController } from './turn-command.controller';

@Module({
  imports: [DevicesModule, SessionsModule],
  controllers: [TurnCommandController],
  providers: [CommandRelayService, TurnCommandRepository],
  exports: [CommandRelayService, TurnCommandRepository],
})
export class CommandRelayModule {}
