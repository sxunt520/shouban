import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Repository } from 'typeorm';
import { DeviceEntity } from '../figure-companion/entities';
import { localFixtures, PARTNER_SIM_PROFILE, topicPrefix } from './partner-profile';

/** Reference authentication only. Production eFuse activation remains a separate profile. */
@Injectable()
export class DeviceBootstrapService {
  constructor(@InjectRepository(DeviceEntity) private readonly devices: Repository<DeviceEntity>) {}

  async configure(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('系统信息必须是 JSON 对象');
    if (process.env.PARTNER_MQTT_ENABLED !== 'true') throw new NotFoundException('设备配置入口尚未启用');
    const mac = headers['device-id'];
    const client = headers['client-id'];
    const auth = headers.authorization;
    if (typeof mac !== 'string' || !/^([a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/.test(mac) || typeof client !== 'string') {
      throw new BadRequestException('缺少合法 Device-Id / Client-Id');
    }
    const externalDeviceId = mac.replaceAll(':', '').toLowerCase();
    const fixture = localFixtures().find(f => f.externalDeviceId === externalDeviceId);
    const device = await this.devices.findOneBy({ externalDeviceId, protocolProfile: PARTNER_SIM_PROFILE });
    const hash = createHash('sha256').update(typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '').digest('hex');
    if (!device || !fixture || client !== (fixture.clientUuid || fixture.clientId) ||
        !timingSafeEqual(Buffer.from(device.deviceSecretHash), Buffer.from(hash))) throw new UnauthorizedException('设备凭证无效');
    if (typeof body.mac_address !== 'string' || body.mac_address.toLowerCase() !== mac.toLowerCase() || body.uuid !== client) {
      throw new BadRequestException('请求头与系统身份不一致');
    }
    const version = (body.application as Record<string, unknown> | undefined)?.version;
    if (typeof version === 'string' && version.length <= 64) await this.devices.update(device.id, { firmwareVersion: version });
    const url = new URL(process.env.PARTNER_MQTT_DEVICE_URL || process.env.PARTNER_MQTT_URL!);
    if (!['mqtt:', 'mqtts:'].includes(url.protocol) || url.username || url.password) throw new BadRequestException('设备 MQTT 地址配置无效');
    return {
      server_time: { timestamp: Date.now(), timezone_offset: 480 },
      mqtt: { endpoint: url.host, client_id: fixture.clientId, username: fixture.username, password: fixture.password,
        keepalive: 30, publish_topic: `${topicPrefix()}/devices/${externalDeviceId}/up`,
        subscribe_topic: `${topicPrefix()}/devices/${externalDeviceId}/down` },
      // These two fields are explicitly reference extensions, not vendor OTA fields.
      profile: PARTNER_SIM_PROFILE, reference_transport: url.protocol === 'mqtts:' ? 'tls' : 'tcp',
    };
  }
}
