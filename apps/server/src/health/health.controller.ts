import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: 'termrelay-server' } {
    return { status: 'ok', service: 'termrelay-server' };
  }
}

