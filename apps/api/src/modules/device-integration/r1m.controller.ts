import { BadRequestException, Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { R1mAccessService } from './r1m-access.service';
import { DeviceIntegrationService } from './device-integration.service';

type HeadersMap = Record<string, string | string[] | undefined>;
@Controller('partner/r1m')
export class R1mController {
  constructor(private readonly access: R1mAccessService, private readonly integration: DeviceIntegrationService) {}
  @Post('ota') @HttpCode(200)
  ota(@Headers() headers: HeadersMap, @Body() body: Record<string, unknown>) { return this.access.ota(headers, body); }
  @Post('ota/activate') @HttpCode(200)
  activate(@Headers() headers: HeadersMap, @Body() body: Record<string, unknown>) { return this.access.activate(headers, body); }
  @Post('broker/auth') @HttpCode(200)
  broker(@Headers('x-broker-token') admin: unknown, @Body() body: Record<string, unknown>) {
    this.access.brokerAdmin(admin); return this.access.mqttAuthenticate(body.clientId, body.username, body.password);
  }
  private async device(headers: HeadersMap, body: Record<string, unknown>) {
    const device = await this.access.authenticate(headers, true);
    if (!body || (body.deviceId !== device.id && body.deviceId !== device.externalDeviceId && (typeof body.deviceId !== 'string' || body.deviceId.replaceAll(':', '').toLowerCase() !== device.externalDeviceId))) throw new BadRequestException('设备身份不一致');
    return device;
  }
  // This HTTP side path requires partner firmware support; OTA token is shared with control authentication.
  @Post('deviceCommands') @HttpCode(200)
  async poll(@Headers() headers: HeadersMap, @Body() body: Record<string, unknown>) {
    const device = await this.device(headers, body);
    return this.integration.pollR1m(device.id);
  }
  @Post('deviceCommands/ack') @HttpCode(200)
  async ack(@Headers() headers: HeadersMap, @Body() body: Record<string, unknown>) {
    const device = await this.device(headers, body);
    return this.integration.acknowledgeR1m(device.id, body);
  }
}

@Controller('api/zckj')
export class R1mDeviceHttpController {
  constructor(private readonly access: R1mAccessService, private readonly integration: DeviceIntegrationService) {}
  private async device(headers: HeadersMap, body: Record<string, unknown>, polling = false) {
    const device = await this.access.authenticate(headers, polling);
    if (!body || typeof body.deviceId !== 'string' || ![device.id, device.externalDeviceId].includes(body.deviceId.replaceAll(':', '').toLowerCase())) throw new BadRequestException('设备身份不一致');
    return device;
  }
  @Post('deviceCommands') @HttpCode(200)
  async poll(@Headers() headers: HeadersMap, @Body() body: Record<string, unknown>) {
    const device = await this.device(headers, body, true); return this.integration.pollR1m(device.id);
  }
  @Post('deviceCommands/ack') @HttpCode(200)
  async ack(@Headers() headers: HeadersMap, @Body() body: Record<string, unknown>) {
    const device = await this.device(headers, body, true); return this.integration.acknowledgeR1m(device.id, body);
  }
  @Post('deviceEventReport') @HttpCode(200)
  async event(@Headers() headers: HeadersMap, @Body() body: Record<string, unknown>) {
    const device = await this.device(headers, body);
    const payload = body.payload as Record<string, unknown> | undefined;
    if (['nfc_tag_present', 'nfc_tag_removed', 'nfc_state'].includes(String(body.type))) return this.integration.receiveNfcHttp(device.id, body);
    if (body.type !== 'cmd_ack' || !payload) throw new BadRequestException('当前仅支持 cmd_ack 事件');
    return this.integration.acknowledgeR1m(device.id, { id: body.eventId, status: payload.result, result: payload, error: payload.error });
  }
}
