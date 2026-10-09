import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { DeviceBootstrapService } from './device-bootstrap.service';

@Controller('partner/ota')
export class DeviceBootstrapController {
  constructor(private readonly bootstrap: DeviceBootstrapService) {}
  @Post()
  @HttpCode(200)
  configure(@Headers() headers: Record<string, string | string[] | undefined>, @Body() body: Record<string, unknown>) {
    return this.bootstrap.configure(headers, body);
  }
}
