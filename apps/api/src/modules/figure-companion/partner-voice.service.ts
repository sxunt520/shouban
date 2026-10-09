import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket, RemoteInfo, Socket } from 'node:dgram';
import { Repository } from 'typeorm';
import { PartnerInbound, PartnerMqttAdapter } from '../device-integration/partner-mqtt.adapter';
import { DeviceIntegrationService } from '../device-integration/device-integration.service';
import { PARTNER_SIM_PROFILE } from '../device-integration/partner-profile';
import { encodePcm, FRAME_MS, opusCodec, packAudio, readPcmWav, REFERENCE_VOICE_PROFILE, unpackAudio } from '../device-integration/reference-audio';
import { DeviceEntity } from './entities';
import { AsrService } from './asr.service';
import { StoreService } from './store.service';

type VoiceState = 'ready' | 'listening' | 'processing' | 'speaking' | 'completed' | 'aborted' | 'error';
interface Session {
  id: string; testId: string; device: DeviceEntity; owner: string; character: string | null; state: VoiceState;
  key: Buffer; nonce: Buffer; downKey: Buffer; downNonce: Buffer; frames: Map<number, Buffer>;
  peer?: { address: string; port: number }; timer?: NodeJS.Timeout; expectedFrames?: number; received: number; sent: number;
  transcript?: string; reply?: string; error?: string; audio?: Buffer; hello: Record<string, unknown>;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

@Injectable()
export class PartnerVoiceService implements OnModuleInit, OnModuleDestroy {
  private socket?: Socket;
  private sessions = new Map<string, Session>();
  private routes = new Map<number, Session>();
  private enabled = false;
  private submissions = new Map<string, string>();
  constructor(@InjectRepository(DeviceEntity) private readonly devices: Repository<DeviceEntity>, private readonly mqtt: PartnerMqttAdapter,
    private readonly store: StoreService, private readonly asr: AsrService, private readonly integration: DeviceIntegrationService) {}

  async onModuleInit() {
    if (process.env.PARTNER_VOICE_ENABLED !== 'true') return;
    if (process.env.PARTNER_MQTT_ENABLED !== 'true' || process.env.MQTT_SIMULATOR_FIXTURES !== 'true' || !/_mqtt_(dev|test)$/.test(process.env.DB_DATABASE || '')) throw new Error('Reference voice requires isolated MQTT fixtures');
    const host = process.env.PARTNER_VOICE_HOST || '127.0.0.1';
    if (!/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(host)) throw new Error('Reference UDP requires a private IPv4 address');
    const port = Number(process.env.PARTNER_VOICE_PORT || 18900);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid UDP port');
    opusCodec(16000); opusCodec(24000); // Fail startup clearly if native Opus is unavailable.
    this.socket = createSocket('udp4');
    this.socket.on('message', (packet, peer) => this.audio(packet, peer));
    this.socket.on('error', () => { for (const s of this.sessions.values()) this.cancel(s, 'error', 'UDP 通道异常'); });
    await new Promise<void>((resolve, reject) => { this.socket!.once('error', reject); this.socket!.bind(port, host, () => { this.socket!.removeListener('error', reject); resolve(); }); });
    this.enabled = true;
    this.integration.onContextChanged(id => { this.submissions.delete(id); const s = this.sessions.get(id); if (s) this.cancel(s, 'aborted'); });
    this.mqtt.receiveVoiceWith(event => this.control(event), () => { this.submissions.clear(); for (const s of this.sessions.values()) this.cancel(s, 'aborted'); });
  }
  private supported(d: DeviceEntity) { return this.enabled && d.protocolProfile === PARTNER_SIM_PROFILE && /^MQTT-SIM-[AB]$/.test(d.hardwareId); }
  private async owned(user: string, id: string) {
    const d = await this.devices.findOneBy({ id, ownerUserId: user });
    if (!d) throw new NotFoundException('设备不属于当前账号');
    if (!this.supported(d)) throw new BadRequestException('当前底座尚未启用参考语音能力');
    return d;
  }
  async status(user: string, id: string) {
    await this.owned(user, id);
    const s = this.sessions.get(id);
    if (!s || s.owner !== user) return { profile: REFERENCE_VOICE_PROFILE, state: 'idle' };
    return { profile: REFERENCE_VOICE_PROFILE, sessionId: s.id, testId: s.testId, state: s.state, receivedFrames: s.received, sentFrames: s.sent,
      transcript: s.transcript, reply: s.reply, error: s.error, audioReady: !!s.audio };
  }
  async cachedAudio(user: string, id: string, sessionId: string) {
    await this.owned(user, id); const s = this.sessions.get(id);
    if (!s || s.id !== sessionId || s.owner !== user || !s.audio) throw new NotFoundException('此轮音频已失效');
    return s.audio;
  }
  async abort(user: string, id: string) {
    const d = await this.owned(user, id), s = this.sessions.get(id);
    this.submissions.delete(id);
    if (s) this.cancel(s, 'aborted');
    await this.mqtt.sendControl(d, { type: 'abort', session_id: s?.id, reason: 'app_interrupt' });
    return { state: 'aborted' };
  }
  async testInput(user: string, id: string, input: { text?: unknown; wav?: Buffer }) {
    const d = await this.owned(user, id);
    if (!d.mqttOnline) throw new BadRequestException('模拟底座未在线，请先启动语音模拟器');
    if (!d.characterId) throw new BadRequestException('请先为模拟底座选择角色');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!input.wav && (!text || text.length > 500)) throw new BadRequestException('请输入 1–500 字的调试文本');
    let frames: Buffer[] = [];
    if (input.wav) {
      try {
        const wav = readPcmWav(input.wav);
        if (wav.rate !== 16000 || wav.pcm.length < 3200 || wav.pcm.length > 320000) throw new Error('录音需为 16kHz 单声道 PCM16 WAV，最长 10 秒');
        frames = encodePcm(wav.pcm, wav.rate);
      } catch (e) { throw new BadRequestException(e instanceof Error ? e.message : '录音格式错误'); }
    }
    const old = this.sessions.get(id); if (old) this.cancel(old, 'aborted');
    const testId = randomUUID();
    this.submissions.set(id, testId);
    // Explicit reference-only fixture input. The simulator sends these frames back through UDP.
    await this.mqtt.sendControl(d, { type: 'reference.voice.begin', test_id: testId, count: frames.length, text });
    for (let index = 0; index < frames.length; index++) {
      if (this.submissions.get(id) !== testId) throw new BadRequestException('录音提交已取消或替换');
      await this.mqtt.sendControl(d, { type: 'reference.voice.frame', test_id: testId, index, opus: frames[index].toString('base64') });
    }
    if (this.submissions.get(id) !== testId) throw new BadRequestException('录音提交已取消或替换');
    await this.mqtt.sendControl(d, { type: 'reference.voice.commit', test_id: testId });
    return { submitted: true, testId }; // Delivery never means recognition/playback succeeded.
  }
  private current(s: Session) { return this.sessions.get(s.device.id) === s && !['aborted', 'error'].includes(s.state); }
  private async valid(s: Session) {
    const d = await this.devices.findOneBy({ id: s.device.id });
    if (!this.current(s) || !d?.mqttOnline || d.ownerUserId !== s.owner || d.characterId !== s.character) {
      if (this.current(s)) this.cancel(s, 'aborted'); return false;
    }
    return true;
  }
  private cancel(s: Session, state: VoiceState, error?: string) {
    if (s.timer) clearTimeout(s.timer);
    s.state = state; s.error = error; s.frames.clear(); s.audio = undefined;
    if (this.routes.get(s.nonce.readUInt32BE(4)) === s) this.routes.delete(s.nonce.readUInt32BE(4));
    s.key.fill(0); s.downKey.fill(0); s.nonce.fill(0); s.downNonce.fill(0); s.hello = {};
    void this.mqtt.sendControl(s.device, { type: 'goodbye', session_id: s.id }).catch(() => {});
  }
  private async control(event: PartnerInbound) {
    if (event.payload.type === 'presence' && event.payload.state === 'offline') {
      const s = [...this.sessions.values()].find(value => value.device.externalDeviceId === event.externalDeviceId);
      const d = await this.devices.findOneBy({ externalDeviceId: event.externalDeviceId });
      if (s && !d?.mqttOnline) this.cancel(s, 'aborted');
      return;
    }
    if (event.retained) return;
    const d = await this.devices.findOneBy({ externalDeviceId: event.externalDeviceId, protocolProfile: PARTNER_SIM_PROFILE });
    if (!d || !this.supported(d) || !d.ownerUserId || !d.mqttOnline) return;
    const p = event.payload;
    if (p.type === 'hello') {
      const params = p.audio_params as Record<string, unknown> | undefined;
      if (p.transport !== 'udp' || p.reference_voice_profile !== REFERENCE_VOICE_PROFILE || params?.format !== 'opus' || params.sample_rate !== 16000 || params.channels !== 1 || params.frame_duration !== FRAME_MS) return;
      const old = this.sessions.get(d.id);
      if (typeof p.reference_test_id !== 'string' || this.submissions.get(d.id) !== p.reference_test_id) return;
      if (old && old.testId === p.reference_test_id && this.current(old)) { await this.mqtt.sendControl(d, old.hello); return; }
      if (old) this.cancel(old, 'aborted');
      const nonce = randomBytes(16), downNonce = randomBytes(16);
      while (this.routes.has(nonce.readUInt32BE(4))) randomBytes(4).copy(nonce, 4);
      const key = randomBytes(16), downKey = randomBytes(16), id = randomUUID();
      const address = this.socket!.address(); if (typeof address === 'string') return;
      const hello = { type: 'hello', transport: 'udp', session_id: id, reference_voice_profile: REFERENCE_VOICE_PROFILE,
        audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: FRAME_MS },
        udp: { server: address.address, port: address.port, key: key.toString('hex'), nonce: nonce.toString('hex'), reference_down_key: downKey.toString('hex'), reference_down_nonce: downNonce.toString('hex') } };
      const s: Session = { id, testId: typeof p.reference_test_id === 'string' ? p.reference_test_id : randomUUID(), device: d, owner: d.ownerUserId, character: d.characterId,
        state: 'ready', key, nonce, downKey, downNonce, frames: new Map(), received: 0, sent: 0, hello };
      this.sessions.set(d.id, s); this.routes.set(nonce.readUInt32BE(4), s);
      s.timer = setTimeout(() => this.cancel(s, s.state === 'completed' ? 'aborted' : 'error', s.state === 'completed' ? undefined : '语音会话超时'), 120000);
      await this.mqtt.sendControl(d, hello); return;
    }
    const s = this.sessions.get(d.id);
    if (!s || p.session_id !== s.id || !await this.valid(s)) return;
    if (p.type === 'abort' || p.type === 'goodbye') { this.cancel(s, 'aborted'); await this.mqtt.sendControl(d, { type: 'goodbye', session_id: s.id }); return; }
    if (p.type !== 'listen') return;
    if (p.state === 'start' && ['ready', 'listening'].includes(s.state)) { s.state = 'listening'; await this.mqtt.sendControl(d, { type: 'reference.listen.ready', session_id: s.id }); return; }
    if (p.state === 'detect' && ['ready', 'listening'].includes(s.state) && typeof p.text === 'string' && p.text.trim() && p.text.length <= 500) {
      s.state = 'processing'; void this.complete(s, p.text.trim()); return;
    }
    if (p.state === 'stop' && s.state === 'listening') {
      if (!Number.isInteger(p.reference_frame_count) || Number(p.reference_frame_count) < 1 || Number(p.reference_frame_count) > 167) return;
      s.expectedFrames = Number(p.reference_frame_count);
      // MQTT stop can overtake the last UDP datagram. Close capture after a short drain window.
      void (async () => { await sleep(200); if (!this.current(s) || s.state !== 'listening') return; s.state = 'processing'; await this.complete(s); })();
    }
  }
  private audio(packet: Buffer, peer: RemoteInfo) {
    if (packet.length < 16) return;
    const s = this.routes.get(packet.readUInt32BE(4));
    if (!s || s.state !== 'listening' || s.frames.size >= 167) return;
    if (s.peer && (s.peer.address !== peer.address || s.peer.port !== peer.port)) return;
    try {
      const frame = unpackAudio(packet, s.key, s.nonce);
      if (frame.sequence > 167 || s.frames.has(frame.sequence) || frame.timestamp !== (frame.sequence - 1) * FRAME_MS) return;
      if (!s.peer) s.peer = { address: peer.address, port: peer.port };
      s.frames.set(frame.sequence, frame.payload); s.received++;
    } catch { /* Invalid packets never reach Opus or ASR. */ }
  }
  private async complete(s: Session, text?: string) {
    try {
      if (!await this.valid(s)) return;
      if (!text) {
        if (!s.frames.size) throw new Error('没有收到 UDP 录音帧');
        if (s.expectedFrames !== s.frames.size) throw new Error('录音 UDP 丢包，请重新录制');
        const codec = opusCodec(16000), chunks: Buffer[] = [];
        let expected = 1;
        for (const [sequence, frame] of [...s.frames.entries()].sort(([a], [b]) => a - b)) {
          if (sequence !== expected++) throw new Error('录音 UDP 丢包，请重新录制');
          const pcm = codec.decode(frame);
          if (pcm.length !== 1920) throw new Error('Opus 帧时长与协商值不一致');
          chunks.push(pcm);
        }
        text = (await this.asr.recognizePcm16(Buffer.concat(chunks))).text.trim();
      }
      s.frames.clear();
      if (!text) throw new Error('未识别到语音');
      if (!await this.valid(s)) return;
      s.transcript = text; await this.mqtt.sendControl(s.device, { type: 'stt', session_id: s.id, text });
      const reply = await this.store.replyToPartnerVoice(s.device.id, text, () => this.current(s));
      if (!await this.valid(s)) return;
      const wav = readPcmWav(reply.audio);
      if (wav.rate !== 24000 || wav.pcm.length > 24000 * 2 * 60) throw new Error('TTS 需输出 24kHz、单声道 PCM16，最长 60 秒');
      const frames = encodePcm(wav.pcm, wav.rate);
      s.reply = reply.text; s.audio = reply.audio; s.state = 'speaking';
      await this.mqtt.sendControl(s.device, { type: 'tts', state: 'start', session_id: s.id });
      await this.mqtt.sendControl(s.device, { type: 'tts', state: 'sentence_start', session_id: s.id, text: reply.text });
      if (s.peer) for (let i = 0; i < frames.length; i++) {
        if (!await this.valid(s)) return;
        const packet = packAudio(frames[i], s.downKey, s.downNonce, i + 1, i * FRAME_MS);
        await new Promise<void>((resolve, reject) => this.socket!.send(packet, s.peer!.port, s.peer!.address, error => error ? reject(error) : resolve()));
        s.sent++; await sleep(FRAME_MS);
      }
      if (!await this.valid(s)) return;
      await this.mqtt.sendControl(s.device, { type: 'tts', state: 'stop', session_id: s.id });
      s.state = 'completed';
    } catch (error) {
      if (!this.current(s)) return;
      const message = error instanceof Error ? error.message : '语音处理失败';
      this.cancel(s, 'error', message);
      await this.mqtt.sendControl(s.device, { type: 'alert', session_id: s.id, status: 'error', message, emotion: 'sad' }).catch(() => {});
    }
  }
  async onModuleDestroy() {
    this.enabled = false;
    this.submissions.clear();
    for (const s of this.sessions.values()) this.cancel(s, 'aborted');
    if (this.socket) await new Promise<void>(resolve => this.socket!.close(() => resolve()));
  }
}
