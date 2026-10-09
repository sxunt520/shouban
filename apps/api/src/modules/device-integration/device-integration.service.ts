import { R1mControlService, R1M_PROFILE, r1mCommandArgs } from './r1m-control.service';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { DeviceCommandEntity, DeviceEntity, DeviceEventEntity, ReminderEntity } from '../figure-companion/entities';
import { PartnerInbound, PartnerMqttAdapter } from './partner-mqtt.adapter';
import { localFixtures, MQTT_ACTIVE_STATUSES, PARTNER_SIM_PROFILE, positiveSetting } from './partner-profile';

@Injectable()
export class DeviceIntegrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceIntegrationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;
  private lastProbe = 0;
  private contextListeners = new Set<(id: string) => void>();
  onContextChanged(listener: (id: string) => void) { this.contextListeners.add(listener); }
  invalidateContext(id: string) { for (const listener of this.contextListeners) listener(id); this.r1m.revoke(id); }
  canUseReferenceVoice(device: DeviceEntity) {
    return process.env.PARTNER_VOICE_ENABLED === 'true' && process.env.MQTT_SIMULATOR_FIXTURES === 'true' &&
      /_mqtt_(dev|test)$/.test(process.env.DB_DATABASE || '') && device.protocolProfile === PARTNER_SIM_PROFILE && /^MQTT-SIM-[AB]$/.test(device.hardwareId);
  }
  canUseCloudVoice(device: DeviceEntity) { return this.canUseReferenceVoice(device) || (process.env.R1M_DEV_ENABLED === 'true' && device.protocolProfile === R1M_PROFILE); }
  r1mConnectivity(device: DeviceEntity) { return device.protocolProfile === R1M_PROFILE ? this.r1m.view(device.id) : undefined; }
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(DeviceEntity) private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(DeviceCommandEntity) private readonly commands: Repository<DeviceCommandEntity>,
    private readonly adapter: PartnerMqttAdapter,
    private readonly r1m: R1mControlService = new R1mControlService(),
  ) {}

  async onModuleInit() {
    this.r1m.onAck((id, payload) => this.acknowledgeR1m(id, payload));
    this.adapter.receiveWith(event => this.receive(event), () => this.resetPresence());
    await this.seedFixtures();
    await this.resetPresence();
    if (process.env.R1M_DEV_ENABLED === 'true') {
      const devices = await this.devices.findBy({ protocolProfile: R1M_PROFILE });
      if (devices.length) await this.commands.update({ deviceId: In(devices.map(d => d.id)), type: 'speak_text', status: 'dispatched' }, { status: 'cancelled', completedAt: new Date(), failureReason: '服务重启中断播报，请重新发起', result: { phase: 'cancelled' } });
    }
    if (process.env.PARTNER_MQTT_ENABLED === 'true' || process.env.R1M_DEV_ENABLED === 'true') this.timer = setInterval(() => void this.tick(), 250);
  }

  private async seedFixtures() {
    if (process.env.MQTT_SIMULATOR_FIXTURES !== 'true') return;
    if (process.env.PARTNER_MQTT_ENABLED !== 'true' || !/_mqtt_(dev|test)$/.test(process.env.DB_DATABASE || '')) {
      throw new Error('MQTT fixtures require MQTT enabled and an isolated *_mqtt_dev or *_mqtt_test database');
    }
    for (const fixture of localFixtures()) {
      const existing = await this.devices.findOneBy({ hardwareId: fixture.hardwareId });
      if (existing) {
        if (existing.protocolProfile === PARTNER_SIM_PROFILE && existing.externalDeviceId === fixture.externalDeviceId &&
            fixture.clientUuid && existing.clientUuid === fixture.clientId) {
          await this.devices.update(existing.id, { clientUuid: fixture.clientUuid });
        }
        continue;
      }
      await this.devices.save(this.devices.create({
        id: fixture.id, hardwareId: fixture.hardwareId, externalDeviceId: fixture.externalDeviceId,
        clientUuid: fixture.clientUuid || fixture.clientId, name: fixture.name, pairingCode: fixture.pairingCode,
        deviceSecretHash: createHash('sha256').update(fixture.bootstrapSecret || fixture.password).digest('hex'),
        firmwareVersion: 'mqtt-simulator-1.0.0', ownerUserId: fixture.autoBind === false ? null : 'user-demo',
        protocolProfile: PARTNER_SIM_PROFILE, volume: fixture.initialVolume,
        capabilities: { setVolume: true, conversation: false, nfc: false, offlineAlarms: false },
      }));
    }
  }

  private async resetPresence() {
    if (this.stopping) return;
    await this.devices.update({ protocolProfile: PARTNER_SIM_PROFILE }, { mqttOnline: false });
    this.lastProbe = 0;
  }

  assertSupported(device: DeviceEntity, type: DeviceCommandEntity['type']) {
    if (device.protocolProfile === 'legacy') return;
    if (device.protocolProfile === R1M_PROFILE && process.env.R1M_DEV_ENABLED === 'true' && ['set_volume', 'identify_device', 'speak_text'].includes(type)) return;
    if (device.protocolProfile !== this.adapter.profile || !this.adapter.supports(type)) {
      throw new BadRequestException('当前设备接入版本尚未支持此功能');
    }
    if (process.env.PARTNER_MQTT_ENABLED !== 'true') throw new BadRequestException('MQTT 设备接入尚未启用');
  }

  async enqueue(deviceId: string, type: DeviceCommandEntity['type'], payload: Record<string, unknown>) {
    const device = await this.devices.findOneBy({ id: deviceId });
    if (!device) throw new NotFoundException('设备不存在');
    this.assertSupported(device, type);
    return this.commands.save(this.commands.create({ deviceId, type, payload, status: 'pending', acknowledgedAt: null }));
  }

  async requestVolume(userId: string, deviceId: string, volume: number) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.ownerUserId !== userId) throw new NotFoundException('设备不存在或不属于当前账号');
      this.assertSupported(device, 'set_volume');
      const now = new Date();
      // A newer request replaces earlier volume intentions; old ACKs cannot win.
      await manager.update(DeviceCommandEntity, {
        deviceId, type: 'set_volume', status: In([...MQTT_ACTIVE_STATUSES]), acknowledgedAt: IsNull(),
      }, { status: 'cancelled', completedAt: now, failureReason: '已被新的音量设置替代' });
      device.desiredVolume = volume;
      device.controlRevision += 1;
      await manager.save(device);
      return manager.save(DeviceCommandEntity, manager.create(DeviceCommandEntity, {
        deviceId, type: 'set_volume', payload: { volume, revision: device.controlRevision },
        revision: device.controlRevision, requestedByUserId: userId, status: 'pending',
        expiresAt: device.protocolProfile === 'legacy' ? null : new Date(now.getTime() + positiveSetting('PARTNER_MQTT_COMMAND_TIMEOUT_MS', 15000)),
      }));
    });
  }

  async selectR1mCharacter(userId: string, id: string, characterId: string) {
    let changed = false;
    await this.dataSource.transaction(async m => {
      const d = await m.findOne(DeviceEntity, { where: { id, ownerUserId: userId, protocolProfile: R1M_PROFILE }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw new NotFoundException('设备归属已变化');
      changed = d.characterId !== characterId;
      if (changed) {
        await m.update(DeviceEntity, id, { characterId });
        await m.update(DeviceCommandEntity, { deviceId: id, type: 'speak_text', status: In([...MQTT_ACTIVE_STATUSES]) }, { status: 'cancelled', completedAt: new Date(), failureReason: '角色已切换', result: { phase: 'cancelled' } });
      }
    });
    if (changed) this.invalidateContext(id);
  }
  receiveNfcHttp(id: string, body: Record<string, unknown>) {
    if (typeof body.session_id !== 'string') throw new BadRequestException('NFC 事件需要当前 session_id');
    return this.r1m.receiveDeviceEvent(id, body, body.session_id);
  }
  async createCloudReminder(userId: string, dto: { deviceId: string; title: string; scheduledAt: string; repeat?: 'none' | 'daily'; kind?: string }) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: dto.deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.ownerUserId !== userId) throw new NotFoundException('设备不存在或不属于当前账号');
      this.assertSupported(device, 'speak_text');
      if (dto.kind && dto.kind !== 'reminder') throw new BadRequestException('R1M 本阶段仅支持云端提醒，尚未支持离线闹钟');
      if (!dto.title.trim() || new Date(dto.scheduledAt).getTime() <= Date.now() || !Number.isFinite(new Date(dto.scheduledAt).getTime())) throw new BadRequestException('提醒内容不能为空，时间需在未来');
      return manager.save(ReminderEntity, manager.create(ReminderEntity, { userId, deviceId: device.id, title: dto.title.trim(), scheduledAt: new Date(dto.scheduledAt), repeat: dto.repeat || 'none', kind: 'reminder', enabled: true }));
    });
  }
  async editCloudReminder(userId: string, reminderId: string, dto?: { title?: string; scheduledAt?: string; repeat?: 'none' | 'daily'; enabled?: boolean; kind?: string }) {
    const existing = await this.dataSource.getRepository(ReminderEntity).findOneBy({ id: reminderId, userId });
    if (!existing) throw new NotFoundException('提醒不存在');
    let stop: string | undefined;
    const result = await this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: existing.deviceId }, lock: { mode: 'pessimistic_write' } });
      const r = await manager.findOne(ReminderEntity, { where: { id: reminderId, userId }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw new NotFoundException('提醒不存在');
      if (!device || device.ownerUserId !== userId) { if (!dto) { await manager.remove(r); return { deleted: true }; } throw new NotFoundException('提醒设备不属于当前账号'); }
      if (dto?.kind && dto.kind !== 'reminder') throw new BadRequestException('本阶段仅支持云端提醒');
      if (dto?.title !== undefined && !dto.title.trim()) throw new BadRequestException('提醒内容不能为空');
      if (dto?.scheduledAt !== undefined && (!Number.isFinite(new Date(dto.scheduledAt).getTime()) || new Date(dto.scheduledAt).getTime() <= Date.now())) throw new BadRequestException('提醒时间需在未来');
      if (dto?.enabled === true && !dto.scheduledAt && r.scheduledAt.getTime() <= Date.now()) throw new BadRequestException('请先编辑提醒，设置未来时间后启用');
      if (r.lastCommandId && (!dto || dto.enabled === false || dto.title !== undefined || dto.scheduledAt !== undefined || dto.repeat !== undefined)) {
        const c = await manager.findOne(DeviceCommandEntity, { where: { id: r.lastCommandId, deviceId: device.id }, lock: { mode: 'pessimistic_write' } });
        if (c && MQTT_ACTIVE_STATUSES.includes(c.status as 'pending' | 'dispatched')) {
          c.status = 'cancelled'; c.completedAt = new Date(); c.failureReason = dto ? '提醒已修改或暂停' : '提醒已删除'; c.result = { phase: 'cancelled' }; await manager.save(c); stop = c.id;
        }
      }
      if (!dto) { await manager.remove(r); return { deleted: true }; }
      if (dto.title !== undefined) r.title = dto.title.trim();
      if (dto.scheduledAt !== undefined) r.scheduledAt = new Date(dto.scheduledAt);
      if (dto.repeat !== undefined) r.repeat = dto.repeat;
      if (dto.enabled !== undefined) r.enabled = dto.enabled;
      return manager.save(r);
    });
    if (stop) this.r1m.stopPlayback(existing.deviceId, stop);
    return result;
  }
  async triggerCloudReminder(reminderId: string, deviceId: string, now = new Date()) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      const r = await manager.findOne(ReminderEntity, { where: { id: reminderId, deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!r?.enabled || r.scheduledAt.getTime() > now.getTime() || device?.protocolProfile !== R1M_PROFILE) return;
      const occurrence = r.scheduledAt;
      r.lastOccurrenceAt = occurrence; r.lastTriggeredAt = now; r.lastCommandId = null; r.lastRunReason = null;
      if (r.repeat === 'daily') r.scheduledAt = new Date(occurrence.getTime() + (Math.floor((now.getTime() - occurrence.getTime()) / 86400000) + 1) * 86400000);
      else r.enabled = false;
      const active = await manager.exists(DeviceCommandEntity, { where: { deviceId, type: 'speak_text', status: In([...MQTT_ACTIVE_STATUSES]) } });
      let reason = '';
      if (device.ownerUserId !== r.userId) { reason = '设备归属已变化'; r.enabled = false; }
      else if (r.kind !== 'reminder') reason = '尚未支持离线闹钟';
      else if (now.getTime() - occurrence.getTime() > 30000) reason = '提醒已过期，未补播';
      else if (!this.r1m.ready(deviceId)) reason = '设备未连接控制通道';
      else if (!device.characterId) reason = '设备尚未选择角色';
      else if (active) reason = '已有播报任务，未叠加播放';
      if (reason) { r.lastRunStatus = 'skipped'; r.lastRunReason = reason; }
      else {
        const command = await manager.save(DeviceCommandEntity, manager.create(DeviceCommandEntity, {
          deviceId, type: 'speak_text', requestedByUserId: r.userId, revision: null, status: 'pending', result: { phase: 'waiting' },
          payload: { text: `提醒一下，${r.title}`, characterId: device.characterId, reminderId: r.id, occurrenceAt: occurrence.toISOString(), startBefore: occurrence.getTime() + 30000 },
          expiresAt: new Date(now.getTime() + 120000),
        }));
        r.lastCommandId = command.id; r.lastRunStatus = 'queued';
      }
      await manager.save(r); return r;
    });
  }
  async cloudReminderExecution(r: ReminderEntity) {
    if (!r.lastOccurrenceAt) return null;
    const c = r.lastCommandId ? await this.commands.findOneBy({ id: r.lastCommandId, deviceId: r.deviceId }) : null;
    return { occurrenceAt: r.lastOccurrenceAt.toISOString(), commandId: r.lastCommandId, status: c?.status || r.lastRunStatus, phase: c?.result?.phase || null, message: c?.failureReason || r.lastRunReason, completedAt: c?.completedAt?.toISOString() || null };
  }

  async requestSpeech(userId: string, deviceId: string, text: string) {
    text = text.trim();
    if (!text || text.length > 500) throw new BadRequestException('播报内容需为 1 至 500 字');
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.ownerUserId !== userId) throw new NotFoundException('设备不存在或不属于当前账号');
      this.assertSupported(device, 'speak_text');
      if (!device.characterId) throw new BadRequestException('请先选择角色');
      const active = await manager.findOne(DeviceCommandEntity, { where: { deviceId, type: 'speak_text', status: In([...MQTT_ACTIVE_STATUSES]) }, order: { createdAt: 'DESC' } });
      if (active?.expiresAt && active.expiresAt.getTime() > Date.now()) {
        if (active.payload.text === text) return active;
        throw new ConflictException('已有播报等待或播放中，请先停止');
      }
      return manager.save(DeviceCommandEntity, manager.create(DeviceCommandEntity, {
        deviceId, type: 'speak_text', payload: { text, characterId: device.characterId }, requestedByUserId: userId,
        revision: null, status: 'pending', result: { phase: 'waiting' }, expiresAt: new Date(Date.now() + 120000),
      }));
    });
  }
  async speechPhase(deviceId: string, id: string, phase: string, failure?: string, details: Record<string, unknown> = {}) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      const c = await manager.findOne(DeviceCommandEntity, { where: { id, deviceId, type: 'speak_text' }, lock: { mode: 'pessimistic_write' } });
      if (!device || !c || !MQTT_ACTIVE_STATUSES.includes(c.status as 'pending' | 'dispatched')) return false;
      if (c.requestedByUserId !== device.ownerUserId || c.payload.characterId !== device.characterId || !c.expiresAt || c.expiresAt.getTime() <= Date.now()) return false;
      c.result = { ...c.result, ...details, phase };
      if (phase === 'failed' || phase === 'cancelled') { c.status = phase; c.completedAt = new Date(); c.failureReason = failure || '播报已停止'; }
      await manager.save(c); return true;
    });
  }
  async speechCurrent(deviceId: string, id: string) {
    const c = await this.commands.findOneBy({ id, deviceId, type: 'speak_text' });
    return !!c && MQTT_ACTIVE_STATUSES.includes(c.status as 'pending' | 'dispatched') && !!c.expiresAt && c.expiresAt.getTime() > Date.now();
  }
  async stopSpeech(userId: string, deviceId: string) {
    await this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.ownerUserId !== userId) throw new NotFoundException('设备不存在或不属于当前账号');
      if (device.protocolProfile !== R1M_PROFILE) throw new BadRequestException('此接口仅支持 R1M 播报');
      await manager.update(DeviceCommandEntity, { deviceId, type: 'speak_text', status: In([...MQTT_ACTIVE_STATUSES]) }, { status: 'cancelled', completedAt: new Date(), failureReason: '用户停止播放', result: { phase: 'cancelled' } });
    });
    this.r1m.stopPlayback(deviceId); return { stopped: true };
  }
  async latestSpeechCommand(deviceId: string) {
    const c = await this.commands.findOne({ where: { deviceId, type: 'speak_text' }, order: { createdAt: 'DESC' } });
    return c ? { id: c.id, text: c.payload.text as string, status: c.status, phase: String(c.result?.phase || 'waiting'), errorMessage: c.failureReason, completedAt: c.completedAt?.toISOString() ?? null } : null;
  }

  async requestIdentify(userId: string, deviceId: string) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.ownerUserId !== userId) throw new NotFoundException('设备不存在或不属于当前账号');
      if (device.protocolProfile !== R1M_PROFILE) throw new BadRequestException('此版本仅支持 R1M 联调底座定位');
      this.assertSupported(device, 'identify_device');
      const pending = await manager.findOne(DeviceCommandEntity, { where: { deviceId, type: 'identify_device', status: In([...MQTT_ACTIVE_STATUSES]) }, order: { createdAt: 'DESC' } });
      if (pending?.expiresAt && pending.expiresAt.getTime() > Date.now()) return pending;
      return manager.save(DeviceCommandEntity, manager.create(DeviceCommandEntity, {
        deviceId, type: 'identify_device', payload: { pattern: 'blink', count: 3, intervalMs: 300 },
        requestedByUserId: userId, revision: null, status: 'pending',
        expiresAt: new Date(Date.now() + positiveSetting('PARTNER_MQTT_COMMAND_TIMEOUT_MS', 15000)),
      }));
    });
  }

  async latestIdentifyCommand(deviceId: string) {
    const c = await this.commands.findOne({ where: { deviceId, type: 'identify_device' }, order: { createdAt: 'DESC' } });
    return c ? { id: c.id, status: c.status, errorMessage: c.failureReason, completedAt: c.completedAt?.toISOString() ?? null } : null;
  }

  async claim(userId: string, deviceId: string, externalDeviceId: string, name?: string) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.externalDeviceId !== externalDeviceId) throw new NotFoundException('设备身份不匹配');
      if (device.ownerUserId && device.ownerUserId !== userId) throw new ConflictException('设备已被其他账号认领');
      device.ownerUserId = userId;
      if (name) device.name = name;
      await manager.save(device);
    });
  }

  async unbind(userId: string, deviceId: string) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.ownerUserId !== userId) throw new NotFoundException('设备不属于当前账号');
      this.invalidateContext(deviceId);
      await manager.update(DeviceCommandEntity, { deviceId, status: In([...MQTT_ACTIVE_STATUSES]) }, { status: 'cancelled', completedAt: new Date(), failureReason: '设备已解绑' });
      device.ownerUserId = null; device.characterId = null;
      await manager.save(device);
      return { unbound: true, deviceId };
    });
  }

  async latestVolumeCommand(deviceId: string) {
    const command = await this.commands.findOne({ where: { deviceId, type: 'set_volume' }, order: { revision: 'DESC', createdAt: 'DESC' } });
    if (!command) return null;
    return {
      id: command.id, status: command.acknowledgedAt ? 'succeeded' as const : command.status,
      requestedVolume: Number(command.payload.volume), revision: command.revision,
      errorMessage: command.failureReason, expiresAt: command.expiresAt?.toISOString() ?? null,
      completedAt: command.completedAt?.toISOString() ?? null,
    };
  }

  async acknowledgeLegacy(deviceId: string, commandId: string) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!device || device.protocolProfile !== 'legacy') throw new BadRequestException('设备应通过对应接入协议回执');
      const command = await manager.findOne(DeviceCommandEntity, { where: { id: commandId, deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!command) throw new NotFoundException('设备指令不存在');
      if (command.acknowledgedAt) return { acknowledged: true };
      if (!MQTT_ACTIVE_STATUSES.includes(command.status as 'pending' | 'dispatched')) return { acknowledged: false, status: command.status };
      command.status = 'succeeded'; command.acknowledgedAt = new Date(); command.completedAt = new Date();
      if (command.type === 'set_volume' && (command.revision === null || command.revision === device.controlRevision)) {
        device.volume = Number(command.payload.volume);
        if (command.revision !== null) device.reportedRevision = command.revision;
        await manager.save(device);
      }
      await manager.save(command);
      return { acknowledged: true };
    });
  }

  async acknowledgeR1m(deviceId: string, payload: Record<string, unknown>) {
    if (typeof payload.id !== 'string' || !['ok', 'error'].includes(String(payload.status))) throw new BadRequestException('执行回执无效');
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId, protocolProfile: R1M_PROFILE }, lock: { mode: 'pessimistic_write' } });
      if (!device) throw new NotFoundException('R1M 设备不存在');
      const command = await manager.findOne(DeviceCommandEntity, { where: { id: payload.id as string, deviceId }, lock: { mode: 'pessimistic_write' } });
      if (!command) throw new NotFoundException('指令不属于此设备');
      if (command.acknowledgedAt) return { acknowledged: true };
      const stoppedResult = payload.result as Record<string, unknown> | undefined;
      if (command.type === 'speak_text' && (command.status === 'cancelled' || MQTT_ACTIVE_STATUSES.includes(command.status as 'pending' | 'dispatched')) && command.requestedByUserId === device.ownerUserId && payload.status === 'ok' && stoppedResult?.phase === 'stopped') {
        command.status = 'cancelled'; command.completedAt ||= new Date(); command.failureReason ||= '设备停止播放';
        command.result = { phase: 'stopped' }; await manager.save(command); return { acknowledged: false, status: 'cancelled', stopped: true };
      }
      if (!MQTT_ACTIVE_STATUSES.includes(command.status as 'pending' | 'dispatched') || command.requestedByUserId !== device.ownerUserId || (command.type === 'set_volume' && command.revision !== device.controlRevision) || !command.expiresAt || command.expiresAt.getTime() <= Date.now()) return { acknowledged: false, status: command.status };
      // A receipt confirms execution; only an explicit matching report updates measured device volume.
      const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result) ? payload.result as Record<string, unknown> : {};
      if (command.type === 'speak_text' && payload.status === 'ok' && result.phase === 'playing') {
        if (!command.result?.expectedFrames) throw new BadRequestException('播放尚未开始');
        if (command.result.phase !== 'awaiting_completion') command.result = { ...command.result, phase: 'playing' };
        await manager.save(command); return { acknowledged: false, status: command.status };
      }
      if (payload.status === 'ok') {
        if (command.type === 'speak_text' && (command.result?.phase !== 'awaiting_completion' || result.phase !== 'finished' || !Number.isInteger(result.frames) || Number(result.frames) < 1 || result.frames !== command.result?.expectedFrames)) throw new BadRequestException('播放完成回执无效');
        if (command.type === 'identify_device' && (result.pattern !== 'blink' || result.count !== 3 || result.executed !== true)) throw new BadRequestException('定位执行结果无效');
        command.status = 'succeeded'; command.acknowledgedAt = new Date();
        if (command.type === 'set_volume' && result.volume === command.payload.volume && result.revision === command.revision) {
          device.volume = Number(result.volume); device.reportedRevision = command.revision!; await manager.save(device);
        }
      } else { command.status = 'failed'; command.failureReason = typeof payload.error === 'string' ? payload.error.slice(0, 500) : '设备拒绝执行'; }
      command.result = result; command.completedAt = new Date(); await manager.save(command);
      return { acknowledged: command.status === 'succeeded', status: command.status };
    });
  }

  async pollR1m(deviceId: string) {
    return this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, { where: { id: deviceId, protocolProfile: R1M_PROFILE }, lock: { mode: 'pessimistic_write' } });
      if (!device) throw new NotFoundException('R1M 设备不存在');
      const commands = await manager.find(DeviceCommandEntity, { where: { deviceId, status: In([...MQTT_ACTIVE_STATUSES]) }, order: { createdAt: 'ASC' }, take: 20 });
      const result: Array<Record<string, unknown>> = [];
      for (const command of commands) {
        if (command.type === 'speak_text') continue; // Audio must use the negotiated session transport, never HTTP command execution.
        if (!command.expiresAt || command.expiresAt.getTime() <= Date.now()) { command.status = 'expired'; command.completedAt = new Date(); }
        else if (command.requestedByUserId !== device.ownerUserId || (command.type === 'set_volume' && command.revision !== device.controlRevision)) { command.status = 'cancelled'; command.completedAt = new Date(); }
        else {
          command.status = 'dispatched'; command.attempts++; command.lastDispatchedAt = new Date();
          result.push({ id: command.id, type: command.type, args: r1mCommandArgs(command), ts: command.createdAt.getTime(), expiresAt: command.expiresAt.getTime() });
        }
        await manager.save(command);
      }
      return { commands: result }; // since is advisory: unacknowledged commands are always redelivered by id.
    });
  }

  private async receive(event: PartnerInbound) {
    if (this.stopping) return;
    const p = event.payload;
    if (!['status', 'presence', 'cmd_ack'].includes(String(p.type))) return;
    if (event.retained && !(p.type === 'presence' && p.state === 'offline')) return;
    if (typeof p.connectionId !== 'string' || p.connectionId.length > 64 ||
        typeof p.eventId !== 'string' || p.eventId.length > 80 || !p.eventId) return;
    await this.dataSource.transaction(async manager => {
      const device = await manager.findOne(DeviceEntity, {
        where: { externalDeviceId: event.externalDeviceId, protocolProfile: PARTNER_SIM_PROFILE },
        lock: { mode: 'pessimistic_write' },
      });
      if (!device) return;
      if (await manager.exists(DeviceEventEntity, { where: { deviceId: device.id, externalEventId: p.eventId as string } })) return;
      if (p.type === 'presence' && p.state === 'offline') {
        if (device.mqttConnectionId !== p.connectionId || !device.mqttOnline) return;
        device.mqttOnline = false;
      } else {
        if (!Number.isSafeInteger(p.sequence) || Number(p.sequence) < 1 ||
            typeof p.ts !== 'number' || Math.abs(Date.now() - p.ts) > 30_000) return;
        if (p.type === 'status') {
          if (!Number.isInteger(p.volume) || Number(p.volume) < 0 || Number(p.volume) > 100 ||
              !Number.isSafeInteger(p.revision) || Number(p.revision) < 0) return;
          if (device.mqttConnectionId !== p.connectionId) {
            // Reject old status packets from a previous process/connection.
            if (device.lastSeenAt && p.ts < device.lastSeenAt.getTime()) return;
            device.mqttConnectionId = p.connectionId as string;
            device.mqttSequence = 0;
          }
          if (Number(p.sequence) <= device.mqttSequence) return;
          if (Number(p.revision) >= device.reportedRevision) {
            device.volume = Number(p.volume);
            device.reportedRevision = Number(p.revision);
            device.controlRevision = Math.max(device.controlRevision, device.reportedRevision);
          }
        } else if (p.type === 'cmd_ack') {
          if (device.mqttConnectionId !== p.connectionId || Number(p.sequence) <= device.mqttSequence ||
              typeof p.commandId !== 'string' || !['ok', 'error'].includes(String(p.status))) return;
          const command = await manager.findOne(DeviceCommandEntity, {
            where: { id: p.commandId, deviceId: device.id }, lock: { mode: 'pessimistic_write' },
          });
          if (!command || !MQTT_ACTIVE_STATUSES.includes(command.status as 'pending' | 'dispatched')) return;
          if (command.requestedByUserId !== device.ownerUserId) return;
          if (!command.expiresAt || command.expiresAt.getTime() <= Date.now()) return;
          const result = p.result;
          if (!result || typeof result !== 'object' || Array.isArray(result)) return;
          const data = result as Record<string, unknown>;
          if (p.status === 'ok') {
            if (data.volume !== command.payload.volume || data.revision !== command.revision) return;
            device.volume = Number(data.volume);
            device.reportedRevision = command.revision!;
            command.status = 'succeeded';
            command.acknowledgedAt = new Date();
          } else {
            command.status = 'failed';
            command.failureReason = typeof p.error === 'string' ? p.error.slice(0, 500) : '设备拒绝执行';
          }
          command.result = data;
          command.completedAt = new Date();
          await manager.save(command);
        } else return;
        device.mqttSequence = Number(p.sequence);
        device.lastSeenAt = new Date();
        device.mqttOnline = true;
      }
      await manager.save(device);
      await manager.save(DeviceEventEntity, manager.create(DeviceEventEntity, {
        deviceId: device.id, externalEventId: p.eventId as string,
        type: `mqtt_${p.type}`, payload: p,
      }));
    });
  }

  private async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const devices = await this.devices.findBy({ protocolProfile: PARTNER_SIM_PROFILE });
      const now = Date.now();
      const lease = positiveSetting('PARTNER_MQTT_PRESENCE_TIMEOUT_MS', 30000);
      for (const device of devices) {
        if (device.mqttOnline && (!this.adapter.ready || !device.lastSeenAt || now - device.lastSeenAt.getTime() > lease)) {
          // Conditional update: a concurrent fresh status must not be overwritten.
          await this.devices.update({ id: device.id, mqttOnline: true, lastSeenAt: device.lastSeenAt || IsNull() }, { mqttOnline: false });
        }
      }
      const r1mDevices = await this.devices.findBy({ protocolProfile: R1M_PROFILE });
      const dispatchDevices = [...devices, ...r1mDevices];
      if (!dispatchDevices.length) return;
      const pending = await this.commands.find({
        where: { deviceId: In(dispatchDevices.map(d => d.id)), status: In([...MQTT_ACTIVE_STATUSES]) },
        order: { createdAt: 'ASC' }, take: 100,
      });
      for (const candidate of pending) {
        const dispatch = await this.dataSource.transaction(async manager => {
          const device = await manager.findOne(DeviceEntity, { where: { id: candidate.deviceId }, lock: { mode: 'pessimistic_write' } });
          const command = await manager.findOne(DeviceCommandEntity, { where: { id: candidate.id }, lock: { mode: 'pessimistic_write' } });
          if (!device || !command || !MQTT_ACTIVE_STATUSES.includes(command.status as 'pending' | 'dispatched')) return null;
          const current = Date.now();
          if (command.requestedByUserId !== device.ownerUserId || (command.type === 'speak_text' && command.payload.characterId !== device.characterId) || !(device.protocolProfile === R1M_PROFILE ? ['set_volume', 'identify_device', 'speak_text'].includes(command.type) : this.adapter.supports(command.type))) {
            command.status = 'cancelled'; command.failureReason = '设备归属或能力已变化';
          } else if ((!command.expiresAt || command.expiresAt.getTime() <= current) || (command.status === 'pending' && typeof command.payload.startBefore === 'number' && command.payload.startBefore < current)) {
            command.status = 'expired'; command.failureReason = '等待设备执行回执超时';
          } else if (!(device.protocolProfile === R1M_PROFILE ? this.r1m.ready(device.id) : this.adapter.ready && device.mqttOnline) ||
            (command.lastDispatchedAt && current - command.lastDispatchedAt.getTime() < positiveSetting('PARTNER_MQTT_RETRY_MS', 2000))) return null;
          else {
            command.status = 'dispatched'; command.attempts += 1; command.lastDispatchedAt = new Date();
            await manager.save(command); return { device, command };
          }
          command.completedAt = new Date(); await manager.save(command); return null;
        });
        if (dispatch) {
          try { await (dispatch.device.protocolProfile === R1M_PROFILE ? this.r1m : this.adapter).send(dispatch.device, dispatch.command); }
          catch { this.logger.warn(`Command ${dispatch.command.id} awaits transport retry`); }
        }
      }
      if (this.adapter.ready && now - this.lastProbe > positiveSetting('PARTNER_MQTT_RETRY_MS', 2000)) {
        this.lastProbe = now;
        for (const device of devices) if (!device.mqttOnline) await this.adapter.requestStatus(device);
      }
    } catch (error) {
      this.logger.warn(`Device integration tick: ${error instanceof Error ? error.message : 'failed'}`);
    } finally { this.running = false; }
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
