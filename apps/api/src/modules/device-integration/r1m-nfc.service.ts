import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CharacterEntity, DeviceCommandEntity, DeviceEntity, DeviceEventEntity, NfcBindingEntity, UserEntity } from '../figure-companion/entities';
import { DeviceIntegrationService } from './device-integration.service';
import { R1mControlService, R1M_PROFILE } from './r1m-control.service';
import { R1mAccessService } from './r1m-access.service';
import { MQTT_ACTIVE_STATUSES } from './partner-profile';

const normalize = (value: unknown) => {
  if (typeof value !== 'string') throw new BadRequestException('NFC UID 无效');
  const uid = value.replace(/[\s:-]/g, '').toUpperCase();
  if (!/^(?:[0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/.test(uid)) throw new BadRequestException('NFC UID 必须是 4、7 或 10 字节十六进制');
  return uid;
};
@Injectable()
export class R1mNfcService implements OnModuleInit {
  constructor(private readonly db: DataSource, private readonly control: R1mControlService, private readonly integration: DeviceIntegrationService, private readonly access: R1mAccessService) {}
  onModuleInit() { this.control.onDeviceEvent((id, event, session) => this.receive(id, event, session)); }
  private async owned(userId: string, id: string) {
    const d = await this.db.getRepository(DeviceEntity).findOneBy({ id, ownerUserId: userId, protocolProfile: R1M_PROFILE });
    if (!d || process.env.R1M_DEV_ENABLED !== 'true') throw new NotFoundException('R1M 设备不存在或不属于当前账号');
    return d;
  }
  async list(userId: string, id: string) { await this.owned(userId, id); return this.db.getRepository(NfcBindingEntity).find({ where: { userId }, order: { createdAt: 'ASC' } }); }
  async bind(userId: string, id: string, rawUid: unknown, characterId?: string) {
    const uid = normalize(rawUid); await this.owned(userId, id); let changed = false;
    const result = await this.db.transaction(async m => {
      if (!await m.findOne(UserEntity, { where: { id: userId }, lock: { mode: 'pessimistic_write' } })) throw new NotFoundException('账号不存在');
      const d = await m.findOne(DeviceEntity, { where: { id, ownerUserId: userId }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw new NotFoundException('设备归属已变化');
      const row = await m.findOneBy(NfcBindingEntity, { userId, uid });
      if (characterId) {
        if (!await m.exists(CharacterEntity, { where: { id: characterId } })) throw new NotFoundException('角色不存在');
        if (row && row.characterId !== characterId) throw new ConflictException('标签已绑定其他角色，请先解除绑定');
        if (!row) await m.save(NfcBindingEntity, m.create(NfcBindingEntity, { userId, uid, characterId }));
      } else if (row) await m.remove(row);
      if (d.lastNfcTagUid === uid) {
        changed = characterId ? d.characterId !== characterId : !!d.lastNfcMatchedCharacterId;
        d.lastNfcMatchedCharacterId = characterId || null;
        if (characterId) d.characterId = characterId;
        await m.save(d);
        if (changed) await m.update(DeviceCommandEntity, { deviceId: id, type: 'speak_text', status: In([...MQTT_ACTIVE_STATUSES]) }, { status: 'cancelled', completedAt: new Date(), failureReason: 'NFC 绑定已变化', result: { phase: 'cancelled' } });
      }
      return { uid, characterId: characterId || null, bound: !!characterId };
    });
    if (changed) this.integration.invalidateContext(id);
    return result;
  }
  async simulate(userId: string, id: string, present: boolean, rawUid?: unknown) {
    await this.owned(userId, id);
    const fixture = this.access.isSimulator(id);
    const c = this.control.connection(id);
    if (!fixture || !/_mqtt_(dev|test)$/.test(process.env.DB_DATABASE || '')) throw new BadRequestException('此操作仅支持本地 R1M 模拟器');
    if (!c) throw new ConflictException('请等待模拟设备建立控制会话');
    const uid = present ? normalize(rawUid) : null;
    c.send({ type: 'custom', payload: { cmd: 'simulate_nfc', id: randomUUID(), args: { present, uid }, expiresAt: Date.now() + 5000 } });
    return { requested: true };
  }
  async receive(id: string, event: Record<string, unknown>, session: string) {
    const c = this.control.connection(id), p = event.payload as Record<string, unknown> | undefined;
    if (!c || c.sessionId !== session || !p || !['nfc_tag_present', 'nfc_tag_removed', 'nfc_state'].includes(String(event.type))) throw new BadRequestException('NFC 会话或事件无效');
    if (typeof event.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.eventId) || !Number.isSafeInteger(p.sequence) || Number(p.sequence) < 1 || Number(p.sequence) > 0xffffffff || !Number.isSafeInteger(p.ts) || Math.abs(Date.now() - Number(p.ts)) > 30000) throw new BadRequestException('NFC 事件 ID、序号或时间无效');
    const present = event.type === 'nfc_tag_present' || (event.type === 'nfc_state' && p.present === true);
    if (event.type === 'nfc_state' && typeof p.present !== 'boolean') throw new BadRequestException('NFC 状态需要 present');
    const uid = present || event.type === 'nfc_tag_removed' ? normalize(p.uid) : null;
    let changed = false;
    const result = await this.db.transaction(async m => {
      const d = await m.findOne(DeviceEntity, { where: { id, protocolProfile: R1M_PROFILE }, lock: { mode: 'pessimistic_write' } });
      if (!d || !this.control.current(id, c)) throw new BadRequestException('设备会话已替换');
      if (!d.ownerUserId) return { applied: false, ignored: true, reason: 'unclaimed' };
      const previous = await m.findOneBy(DeviceEventEntity, { deviceId: id, externalEventId: event.eventId as string });
      if (previous) return { duplicate: true, applied: false, present: !!d.lastNfcTagUid, uid: d.lastNfcTagUid, matched: !!d.lastNfcMatchedCharacterId, characterId: d.characterId, switched: false };
      if (d.lastNfcConnectionId === c.id && Number(p.sequence) <= d.lastNfcSequence) throw new BadRequestException('NFC 序号已过期');
      d.lastNfcConnectionId = c.id; d.lastNfcSequence = Number(p.sequence);
      let applied = true, switched = false;
      if (!present && event.type === 'nfc_tag_removed' && d.lastNfcTagUid !== uid) applied = false;
      if (applied) {
        const binding = present ? await m.findOneBy(NfcBindingEntity, { userId: d.ownerUserId, uid: uid! }) : null;
        const character = binding ? await m.findOneBy(CharacterEntity, { id: binding.characterId }) : null;
        switched = !!character && d.characterId !== character.id;
        changed = switched || (!present && !!d.lastNfcTagUid);
        d.lastNfcTagUid = present ? uid : null; d.lastNfcAt = new Date(); d.lastNfcMatchedCharacterId = character?.id || null;
        if (character) d.characterId = character.id;
        if (changed) await m.update(DeviceCommandEntity, { deviceId: id, type: 'speak_text', status: In([...MQTT_ACTIVE_STATUSES]) }, { status: 'cancelled', completedAt: new Date(), failureReason: 'NFC 手办状态已变化', result: { phase: 'cancelled' } });
      }
      await m.save(d);
      const answer = { duplicate: false, applied, present: !!d.lastNfcTagUid, uid: d.lastNfcTagUid, matched: !!d.lastNfcMatchedCharacterId, characterId: d.characterId, switched };
      await m.save(DeviceEventEntity, m.create(DeviceEventEntity, { deviceId: id, type: String(event.type), externalEventId: event.eventId as string, payload: { ...p, reportedUid: uid, session, connectionId: c.id, ...answer } }));
      return answer;
    });
    if (this.control.current(id, c)) {
      c.send({ type: 'custom', payload: { type: 'nfc_ack', eventId: event.eventId, payload: result } });
      if (changed) this.integration.invalidateContext(id);
    }
    return result;
  }
}
