import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { AIController } from './ai.controller';
import { AIRepository } from './ai.repository';
import { AIService } from './ai.service';
import { AISettingsController } from './ai-settings.controller';
import { AISettingsService } from './ai-settings.service';
@Module({imports:[DevicesModule],controllers:[AIController,AISettingsController],providers:[AIRepository,AIService,AISettingsService],exports:[AIService]})
export class AIModule {}
