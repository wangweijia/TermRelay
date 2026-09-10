import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import type { DeviceRecord } from './device.repository';
import { DevicesService } from './devices.service';

@Controller('api/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(): Promise<DeviceRecord[]> {
    return this.devices.list();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<DeviceRecord> {
    const device = await this.devices.findById(id);
    if (!device) throw new NotFoundException('device not found');
    return device;
  }
}
