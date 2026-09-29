import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { ShortcutsController } from './shortcuts.controller';
import { ShortcutsRepository } from './shortcuts.repository';
import { ShortcutsService } from './shortcuts.service';

@Module({
  imports: [DevicesModule],
  controllers: [ShortcutsController],
  providers: [ShortcutsRepository, ShortcutsService],
  exports: [ShortcutsService],
})
export class ShortcutsModule {}
