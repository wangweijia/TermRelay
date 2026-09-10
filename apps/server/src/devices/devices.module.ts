import { Module } from '@nestjs/common';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { DevicesController } from './devices.controller';
import { DeviceRepository } from './device.repository';
import { DevicesService } from './devices.service';

@Module({
  controllers: [DevicesController],
  providers: [DeviceConnectionRegistry, DeviceRepository, DevicesService],
  exports: [DeviceConnectionRegistry, DeviceRepository, DevicesService],
})
export class DevicesModule {}
