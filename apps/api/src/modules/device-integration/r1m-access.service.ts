import { BadRequestException, Injectable, NotFoundException, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Repository } from 'typeorm';
import { DeviceEntity } from '../figure-companion/entities';
import { R1M_UDP_PROPOSAL } from './r1m-proposal-codec';
import { R1mControlService, R1M_PROFILE } from './r1m-control.service';

export interface R1mFixture {
  id: string; hardwareId: string; mac: string; clientUuid: string; name: string;
  bootstrapSecret: string; pairingCode: string; transport: 'websocket' | 'mqtt'; httpPolling?: boolean; serialNumber?: string; activationKeyHex?: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
/** Local provisioning boundary. Real factory HMAC verification must replace this explicitly enabled bootstrap fixture. */
@Injectable()
export class R1mAccessService implements OnModuleInit {
  private fixtures: R1mFixture[] = [];
  private challenges = new Map<string, { value: string; expires: number; attempts: number }>();
  private activationTickets = new Map<string, { hash: Buffer; expires: number }>();
  private credentials = new Map<string, { hash: Buffer; expires: number; uuid: string }>();
  constructor(@InjectRepository(DeviceEntity) private readonly devices: Repository<DeviceEntity>, private readonly control: R1mControlService) {}
  isSimulator(id: string) { return this.fixtures.some(f => f.id === id && /SIM/.test(f.hardwareId)); }
  async onModuleInit() {
    if (process.env.R1M_DEV_ENABLED !== 'true') return;
    if (!/_mqtt_(dev|test)$/.test(process.env.DB_DATABASE || '') || !process.env.R1M_FIXTURES_PATH) throw new Error('R1M bootstrap fixtures require an isolated database and a private R1M_FIXTURES_PATH');
    const fixtures: unknown = JSON.parse(readFileSync(process.env.R1M_FIXTURES_PATH, 'utf8'));
    if (!Array.isArray(fixtures) || fixtures.length > 100) throw new Error('Invalid R1M fixture registry');
    for (const f of fixtures as R1mFixture[]) {
      if (!/^([a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/.test(f.mac) || !/^[a-f0-9-]{36}$/i.test(f.id) ||
          !f.clientUuid || f.clientUuid.length > 64 || !f.hardwareId || f.hardwareId.length > 100 || !f.name || f.name.length > 80 ||
          typeof f.bootstrapSecret !== 'string' || f.bootstrapSecret.length < 32 || !/^[A-Z0-9-]{16,32}$/.test(f.pairingCode) || !['websocket', 'mqtt'].includes(f.transport)) throw new Error('Invalid R1M fixture identity or credentials');
      if (f.serialNumber && (!/^[A-Za-z0-9_-]{1,64}$/.test(f.serialNumber) || !/^[a-f0-9]{64}$/i.test(f.activationKeyHex || '') || this.fixtures.some(x => x.serialNumber === f.serialNumber))) throw new Error('Invalid development activation material');
      const externalDeviceId = f.mac.replaceAll(':', '').toLowerCase();
      if (this.fixtures.some(x => x.id === f.id || x.mac.toLowerCase() === f.mac.toLowerCase())) throw new Error('Duplicate R1M fixture');
      const existing = await this.devices.findOneBy({ id: f.id });
      if (existing && (existing.protocolProfile !== R1M_PROFILE || existing.externalDeviceId !== externalDeviceId || existing.clientUuid !== f.clientUuid || existing.deviceSecretHash !== digest(f.bootstrapSecret).toString('hex'))) throw new Error('R1M registry conflicts with stored identity');
      if (!existing) await this.devices.save(this.devices.create({ id: f.id, hardwareId: f.hardwareId, externalDeviceId, clientUuid: f.clientUuid,
        name: f.name, pairingCode: f.pairingCode, deviceSecretHash: digest(f.bootstrapSecret).toString('hex'), firmwareVersion: 'r1m-simulator-1',
        ownerUserId: null, characterId: null, protocolProfile: R1M_PROFILE, volume: 60,
        capabilities: { setVolume: true, conversation: false, nfc: false, offlineAlarms: false } }));
      this.fixtures.push(f);
    }
  }
  private identity(headers: Record<string, string | string[] | undefined>) {
    const mac = headers['device-id'], uuid = headers['client-id'];
    if (typeof mac !== 'string' || typeof uuid !== 'string') throw new UnauthorizedException('缺少设备身份');
    const f = this.fixtures.find(x => x.mac.toLowerCase() === mac.toLowerCase() && x.clientUuid === uuid);
    if (!f) throw new UnauthorizedException('设备未登记');
    return f;
  }
  private bearer(headers: Record<string, string | string[] | undefined>) {
    const auth = headers.authorization;
    return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  }
  async ota(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>) {
    if (process.env.R1M_DEV_ENABLED !== 'true') throw new NotFoundException('R1M 接入尚未启用');
    const f = this.identity(headers);
    if (f.serialNumber) {
      if (headers['serial-number'] !== f.serialNumber) throw new UnauthorizedException('设备序列号不匹配');
    } else if (!timingSafeEqual(digest(this.bearer(headers)), digest(f.bootstrapSecret))) throw new UnauthorizedException('设备启动凭证无效');
    if (!body || body.mac_address !== f.mac || body.uuid !== f.clientUuid) throw new BadRequestException('系统信息与登记身份不一致');
    const ticket = this.activationTickets.get(f.id);
    if (f.serialNumber && (!ticket || ticket.expires <= Date.now() || !timingSafeEqual(ticket.hash, digest(this.bearer(headers))))) {
      let challenge = this.challenges.get(f.id);
      if (!challenge || challenge.expires <= Date.now()) {
        challenge = { value: randomBytes(32).toString('base64url'), expires: Date.now() + 120000, attempts: 0 }; this.challenges.set(f.id, challenge);
      }
      return { server_time: { timestamp: Date.now(), timezone_offset: 480 }, activation: { message: '开发激活：请提交 challenge HMAC', challenge: challenge.value, timeout_ms: Math.max(0, challenge.expires - Date.now()) } };
    }
    if (f.transport === 'mqtt') {
      if (process.env.R1M_MQTT_PROPOSAL_ENABLED !== 'true') throw new ServiceUnavailableException('R1M MQTT/UDP 正式主题和加密配置尚待验证，请使用参考 profile 联调');
      const endpoint = new URL(process.env.R1M_MQTT_DEVICE_URL || process.env.PARTNER_MQTT_DEVICE_URL || process.env.PARTNER_MQTT_URL || 'mqtt://127.0.0.1:18883');
      if (!['mqtt:', 'mqtts:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new ServiceUnavailableException('MQTT 地址无效');
      const token = this.issue(f);
      return { server_time: { timestamp: Date.now(), timezone_offset: 480 }, mqtt: { endpoint: endpoint.host, client_id: `r1m-${f.mac.replaceAll(':', '').toLowerCase()}`, username: f.mac.replaceAll(':', '').toLowerCase(), password: token, keepalive: 240,
        publish_topic: `shouban/r1m/v1/devices/${f.mac.replaceAll(':', '').toLowerCase()}/up` }, integration: { contract: 'company-r1m-proposal-v1', udp_profile: R1M_UDP_PROPOSAL, mqtt_transport: endpoint.protocol === 'mqtts:' ? 'tls' : 'tcp' } };
    }
    const url = new URL(process.env.R1M_WS_PUBLIC_URL || 'ws://127.0.0.1:3000/v1/partner/r1m/voice');
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.pathname !== '/v1/partner/r1m/voice') throw new ServiceUnavailableException('R1M WebSocket 地址无效');
    const token = this.issue(f);
    this.control.observe(f.id); // An OTA observation alone does not mark persistent online.
    const version = (body.application as Record<string, unknown> | undefined)?.version;
    if (typeof version === 'string' && version.length <= 64) await this.devices.update(f.id, { firmwareVersion: version });
    return { server_time: { timestamp: Date.now(), timezone_offset: 480 }, websocket: { url: url.toString(), token, version: 1 } };
  }
  async authenticate(headers: Record<string, string | string[] | undefined>, polling = false) {
    const f = this.identity(headers), credential = this.credentials.get(f.id);
    if (!credential || credential.expires <= Date.now() || !timingSafeEqual(credential.hash, digest(this.bearer(headers))) || (polling && !f.httpPolling)) throw new UnauthorizedException('设备通道凭证无效或轮询未启用');
    const device = await this.devices.findOneBy({ id: f.id, protocolProfile: R1M_PROFILE });
    if (!device || this.credentials.get(f.id) !== credential || credential.expires <= Date.now()) throw new UnauthorizedException('设备登记或通道凭证已失效');
    return device;
  }
  private issue(f: R1mFixture) {
    const token = randomBytes(32).toString('base64url'); this.activationTickets.delete(f.id); this.control.revoke(f.id); this.control.clearBroker(f.id);
    this.credentials.set(f.id, { hash: digest(token), expires: Date.now() + 6 * 3600_000, uuid: f.clientUuid }); return token;
  }
  async activate(headers?: Record<string, string | string[] | undefined>, body?: Record<string, unknown>) {
    if (!headers || !body || !this.fixtures.some(f => f.serialNumber)) throw new ServiceUnavailableException('正式 eFuse 激活需要出厂验证资料；开发 profile 使用独立启动凭证，不接受模拟 HMAC');
    const f = this.identity(headers), challenge = this.challenges.get(f.id);
    if (!f.serialNumber || body.serial_number !== f.serialNumber || headers['serial-number'] !== f.serialNumber || body.algorithm !== 'hmac-sha256' || !challenge || challenge.expires <= Date.now() || challenge.attempts >= 5 || body.challenge !== challenge.value || typeof body.hmac !== 'string' || !/^[a-f0-9]{64}$/i.test(body.hmac)) throw new UnauthorizedException('激活请求无效或 challenge 已过期');
    challenge.attempts++;
    const expected = createHmac('sha256', Buffer.from(f.activationKeyHex!, 'hex')).update(challenge.value, 'utf8').digest();
    if (!timingSafeEqual(expected, Buffer.from(body.hmac, 'hex'))) throw new UnauthorizedException('激活证明无效');
    this.challenges.delete(f.id);
    const token = randomBytes(32).toString('base64url'); this.activationTickets.set(f.id, { hash: digest(token), expires: Date.now() + 60000 });
    return { activated: true, profile: 'development-hmac-v1', activation_token: token };
  }
  brokerAdmin(value: unknown) {
    if (process.env.R1M_MQTT_PROPOSAL_ENABLED !== 'true' || !process.env.R1M_BROKER_ADMIN_TOKEN || typeof value !== 'string' || !timingSafeEqual(digest(value), digest(process.env.R1M_BROKER_ADMIN_TOKEN))) throw new UnauthorizedException('Broker 管理凭证无效');
  }
  async mqttAuthenticate(clientId: unknown, username: unknown, password: unknown) {
    const f = this.fixtures.find(f => f.transport === 'mqtt' && `r1m-${f.mac.replaceAll(':', '').toLowerCase()}` === clientId && f.mac.replaceAll(':', '').toLowerCase() === username);
    if (!f || typeof password !== 'string') throw new UnauthorizedException('MQTT 身份无效');
    const device = await this.authenticate({ 'device-id': f.mac, 'client-id': f.clientUuid, authorization: `Bearer ${password}` });
    return { id: device.id, mac: device.externalDeviceId };
  }
  async mqttDevice(mac: string) {
    const f = this.fixtures.find(f => f.transport === 'mqtt' && f.mac.replaceAll(':', '').toLowerCase() === mac);
    if (!f || !this.credentials.has(f.id) || this.credentials.get(f.id)!.expires <= Date.now()) return null;
    return this.devices.findOneBy({ id: f.id, protocolProfile: R1M_PROFILE });
  }
}
