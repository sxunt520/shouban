import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { EventEmitter } from 'node:events';
import { RawData, WebSocket } from 'ws';
import { positiveSetting } from '../device-integration/partner-profile';
import { DeviceIntegrationService } from '../device-integration/device-integration.service';
import { R1mControlService, R1mConnection } from '../device-integration/r1m-control.service';
import { encodePcm, FRAME_MS, MAX_PACKET, opusCodec, readPcmWav } from '../device-integration/reference-audio';
import { DeviceEntity, DeviceCommandEntity } from './entities';
import { AsrService, RealtimeAsrSession } from './asr.service';
import { StoreService } from './store.service';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const buffer = (data: RawData) => Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

export interface R1mVoiceSocket extends EventEmitter {
  readyState: number; bufferedAmount: number;
  send(data: string | Buffer, options?: { binary?: boolean }, callback?: (error?: Error) => void): void;
  close(code?: number): void; terminate(): void; ping(): void;
}

@Injectable()
export class R1mVoiceService implements OnModuleInit, OnModuleDestroy {
  private sockets = new Set<R1mVoiceSocket>();
  constructor(@InjectRepository(DeviceEntity) private readonly devices: Repository<DeviceEntity>, private readonly control: R1mControlService,
    private readonly store: StoreService, private readonly asr: AsrService, private readonly integration: DeviceIntegrationService) {}
  onModuleInit() {
    if (process.env.R1M_DEV_ENABLED === 'true') { opusCodec(16000); opusCodec(24000); }
    // Context observers compose with the reference UDP adapter rather than replacing it.
    this.integration.onContextChanged(id => this.control.revoke(id));
  }
  connect(socket: R1mVoiceSocket, device: DeviceEntity) {
    this.sockets.add(socket);
    const sessionId = randomUUID(), idleMs = positiveSetting('R1M_WS_IDLE_MS', 120000);
    let connection: R1mConnection | undefined, serial = 0, state = 'hello';
    let activeSpeech: string | undefined; const deliveredSpeech = new Set<string>();
    let owner: string | null = null, character: string | null = null;
    let mode = 'manual', recognition: RealtimeAsrSession | undefined;
    let chunks: Buffer[] = [], pcmBytes = 0, decoder = opusCodec(16000), alive = true;
    let pending = 0, queuedBytes = 0, chain = Promise.resolve();
    let idle: NodeJS.Timeout;
    const current = (turn: number) => serial === turn && socket.readyState === WebSocket.OPEN && !!connection && this.control.current(device.id, connection);
    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...message, session_id: sessionId }));
    };
    const cancel = () => {
      if (activeSpeech) { const id = activeSpeech; activeSpeech = undefined; send({ type: 'custom', payload: { cmd: 'stop_playback', id } }); send({ type: 'tts', state: 'stop', command_id: id, cancelled: true }); void this.integration.speechPhase(device.id, id, 'cancelled', '会话结束或被新的语音打断').catch(() => {}); }
      recognition?.abort(); recognition = undefined; serial++; chunks = []; pcmBytes = 0; if (connection) connection.voiceActive = false; state = connection ? 'ready' : 'hello'; };
    const close = (code = 1000) => { cancel(); send({ type: 'goodbye' }); if (connection) this.control.detach(device.id, connection); socket.close(code); };
    const error = (message: string, code = 1008) => { send({ type: 'alert', status: 'error', message, emotion: 'sad' }); close(code); };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => close(), connection ? idleMs : 10000);
    };
    const valid = async (turn: number) => {
      if (!current(turn)) return false;
      const row = await this.devices.findOneBy({ id: device.id });
      if (!current(turn)) return false;
      if (activeSpeech && !await this.integration.speechCurrent(device.id, activeSpeech)) { cancel(); return false; }
      if (!row || row.ownerUserId !== owner || row.characterId !== character) { close(); return false; }
      return true;
    };
    const play = async (command: DeviceCommandEntity) => {
      if (deliveredSpeech.has(command.id) || !connection) return;
      deliveredSpeech.add(command.id);
      if (activeSpeech && await this.integration.speechCurrent(device.id, activeSpeech)) { deliveredSpeech.delete(command.id); return; }
      const row = await this.devices.findOneBy({ id: device.id });
      if (!row || row.ownerUserId !== command.requestedByUserId || row.characterId !== command.payload.characterId || !await this.integration.speechCurrent(device.id, command.id)) return;
      if (state === 'speaking') send({ type: 'tts', state: 'stop', cancelled: true });
      cancel(); activeSpeech = command.id; owner = row.ownerUserId; character = row.characterId;
      const turn = serial; state = 'processing'; connection.voiceActive = true; resetIdle();
      try {
        if (typeof command.payload.startBefore === 'number' && command.payload.startBefore < Date.now()) throw new Error('提醒已超过开始播报窗口');
        if (!await this.integration.speechPhase(device.id, command.id, 'synthesizing')) { cancel(); return; }
        const text = String(command.payload.text);
        const audio = await this.store.synthesizeR1mSpeech(device.id, text, () => current(turn));
        if (!await valid(turn)) return;
        if (typeof command.payload.startBefore === 'number' && command.payload.startBefore < Date.now()) throw new Error('提醒语音生成超时，未补播');
        const wav = readPcmWav(audio);
        if (wav.rate !== 24000 || !wav.pcm.length || wav.pcm.length > 24000 * 2 * 60) throw new Error('播报需为 24kHz 单声道 PCM16，最长 60 秒');
        const frames = encodePcm(wav.pcm, wav.rate);
        await this.integration.speechPhase(device.id, command.id, 'streaming', undefined, { expectedFrames: frames.length });
        state = 'speaking';
        send({ type: 'custom', payload: { cmd: 'play_audio', id: command.id, args: { text, frames: frames.length }, expiresAt: command.expiresAt?.getTime() } });
        send({ type: 'tts', state: 'start', command_id: command.id });
        send({ type: 'tts', state: 'sentence_start', text, command_id: command.id });
        for (const frame of frames) {
          if (!await valid(turn)) return;
          if (socket.bufferedAmount > 65536) throw new Error('设备接收音频过慢');
          await new Promise<void>((resolve, reject) => socket.send(frame, { binary: true }, e => e ? reject(e) : resolve()));
          resetIdle(); await sleep(FRAME_MS);
        }
        if (!await valid(turn)) return;
        await this.integration.speechPhase(device.id, command.id, 'awaiting_completion');
        send({ type: 'tts', state: 'stop', command_id: command.id });
        state = 'ready'; connection.voiceActive = false; resetIdle();
      } catch (e) {
        if (current(turn)) {
          await this.integration.speechPhase(device.id, command.id, 'failed', e instanceof Error ? e.message : '播报失败');
          cancel(); resetIdle();
        }
      }
    };
    const finish = async (turn: number, pcm?: Buffer, text?: string) => {
      try {
        if (!await valid(turn)) return;
        if (!text && pcm) text = (await this.asr.recognizePcm16(pcm)).text.trim();
        if (!text) throw new Error('未识别到语音');
        if (!await valid(turn)) return;
        send({ type: 'stt', text });
        const reply = await this.store.replyToPartnerVoice(device.id, text, () => current(turn));
        if (!await valid(turn)) return;
        const wav = readPcmWav(reply.audio);
        if (wav.rate !== 24000 || wav.pcm.length > 24000 * 2 * 60) throw new Error('TTS 需为 24kHz 单声道 PCM16，最长 60 秒');
        const frames = encodePcm(wav.pcm, wav.rate);
        state = 'speaking'; send({ type: 'tts', state: 'start' }); send({ type: 'tts', state: 'sentence_start', text: reply.text });
        for (const frame of frames) {
          if (!await valid(turn)) return;
          if (socket.bufferedAmount > 65536) throw new Error('设备接收音频过慢');
          await new Promise<void>((resolve, reject) => socket.send(frame, { binary: true }, e => e ? reject(e) : resolve()));
          resetIdle(); await sleep(FRAME_MS);
        }
        if (!await valid(turn)) return;
        state = 'ready'; connection!.voiceActive = false; resetIdle();
        // Prepare automatic capture before stop lets firmware resume sending audio.
        if (mode === 'manual' || await start(mode)) send({ type: 'tts', state: 'stop' });
      } catch (e) {
        if (current(turn)) error(e instanceof Error ? e.message : '语音处理失败', 1011);
      }
    };
    const start = async (nextMode = 'manual') => {
      const row = await this.devices.findOneBy({ id: device.id });
      if (!connection || !this.control.current(device.id, connection) || socket.readyState !== WebSocket.OPEN) return false;
      if (!row?.ownerUserId || !row.characterId) { send({ type: 'alert', status: 'error', message: '请先认领底座并选择角色', emotion: 'neutral' }); return false; }
      if (state === 'speaking' && !activeSpeech) send({ type: 'tts', state: 'stop' });
      cancel(); owner = row.ownerUserId; character = row.characterId; decoder = opusCodec(16000);
      state = 'listening'; connection.voiceActive = true; mode = nextMode;
      if (mode !== 'manual') {
        const turn = serial;
        // Automatic endpointing uses provider SentenceEnd rather than an invented audio energy threshold.
        void this.asr.startRealtimeRecognition(progress => {
          if (!current(turn) || state !== 'listening' || !progress.final || !progress.text.trim()) return;
          recognition?.abort(); recognition = undefined; chunks = []; pcmBytes = 0; state = 'processing';
          void finish(turn, undefined, progress.text.trim());
        }).then(session => {
          if (!current(turn) || state !== 'listening') { session.abort(); return; }
          recognition = session;
          for (const pcm of chunks) { if (state !== 'listening') break; session.write(pcm); }
        }).catch(() => { if (current(turn) && state === 'listening') error('自动监听的实时识别服务不可用', 1011); });
      }
      return true;
    };
    const message = async (bytes: Buffer, binary: boolean) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (connection && !this.control.current(device.id, connection)) return;
      resetIdle();
      if (binary) {
        if (activeSpeech && state !== 'listening') return;
        if (mode !== 'manual' && ['processing', 'speaking'].includes(state)) return;
        if (state !== 'listening' || !bytes.length || bytes.length > MAX_PACKET) throw new Error('裸 Opus 帧只能在 listen.start 后发送');
        const pcm = decoder.decode(bytes);
        if (pcm.length !== 1920) throw new Error('Opus 帧需为 16kHz 单声道 60ms');
        if (pcmBytes + pcm.length > 320000) throw new Error('单轮录音超过 10 秒');
        chunks.push(Buffer.from(pcm)); pcmBytes += pcm.length; recognition?.write(pcm); return;
      }
      const p: unknown = JSON.parse(bytes.toString('utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('控制消息无效');
      const payload = p as Record<string, unknown>;
      if (!connection) {
        const audio = payload.audio_params as Record<string, unknown> | undefined;
        if (payload.type !== 'hello' || payload.transport !== 'websocket' || (payload.version !== undefined && payload.version !== 1) ||
          audio?.format !== 'opus' || audio.sample_rate !== 16000 || audio.channels !== 1 || audio.frame_duration !== FRAME_MS) throw new Error('需要 R1M WebSocket v1 hello 和 16kHz/60ms Opus');
        connection = this.control.attach(device.id, send, () => close(), sessionId);
        connection.play = command => { void play(command).catch(() => close(1011)); }; connection.stopPlayback = id => { if (id && activeSpeech !== id) return; cancel(); resetIdle(); };
        state = 'ready'; send({ type: 'hello', transport: 'websocket', version: 1,
          audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: FRAME_MS } }); resetIdle(); return;
      }
      // A stale session cannot stop a newer connection or turn. Session id may be omitted by stock firmware.
      if (payload.session_id !== undefined && payload.session_id !== sessionId) return;
      this.control.observe(device.id);
      if (payload.type === 'abort') { if (state === 'speaking' && !activeSpeech) send({ type: 'tts', state: 'stop' }); cancel(); return; }
      if (payload.type === 'goodbye') { close(); return; }
      if (payload.type === 'custom') {
        const event = payload.payload as Record<string, unknown> | undefined;
        if (event && ['nfc_tag_present', 'nfc_tag_removed', 'nfc_state'].includes(String(event.type))) {
          if (payload.session_id !== sessionId) throw new Error('NFC 事件需要当前 session_id');
          await this.control.receiveDeviceEvent(device.id, event, sessionId); return;
        }
        if (event?.type !== 'cmd_ack') return;
        const result = event.payload as Record<string, unknown> | undefined;
        if (!result) throw new Error('custom 回执无效');
        await this.control.acknowledge(device.id, { id: event.eventId, status: result.result, result, error: result.error });
        if (activeSpeech && event.eventId === activeSpeech && !await this.integration.speechCurrent(device.id, activeSpeech)) { activeSpeech = undefined; }
        return;
      }
      if (payload.type === 'mcp') return; // Tools are not assumed available merely because features.mcp=true.
      if (payload.type !== 'listen') throw new Error('未知 R1M 控制消息');
      if (payload.state === 'start') {
        if (!['auto', 'manual', 'realtime'].includes(String(payload.mode))) throw new Error('listen.mode 无效');
        await start(String(payload.mode)); return;
      }
      if (payload.state === 'detect') {
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 500) throw new Error('唤醒文本无效');
        if (!await start()) return;
        state = 'processing'; void finish(serial, undefined, payload.text.trim()); return;
      }
      if (payload.state === 'stop' && state === 'listening') {
        if (pcmBytes < 3200) throw new Error('录音过短，至少需要 0.1 秒');
        const pcm = Buffer.concat(chunks, pcmBytes); recognition?.abort(); recognition = undefined; chunks = []; pcmBytes = 0;
        state = 'processing'; void finish(serial, pcm); return;
      }
      // Repeated stop is harmless; no second provider request is made.
      if (payload.state !== 'stop') throw new Error('listen.state 无效');
    };
    resetIdle();
    const heartbeat = setInterval(() => {
      if (!alive) { cancel(); if (connection) this.control.detach(device.id, connection); socket.terminate(); return; }
      alive = false; if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30000);
    socket.on('pong', () => { alive = true; if (connection) this.control.observe(device.id); });
    socket.on('message', (data, binary) => {
      const bytes = buffer(data); pending++; queuedBytes += bytes.length;
      if (pending > 200 || queuedBytes > 400000) { error('设备发送速度超过接收限制'); return; }
      chain = chain.then(() => message(bytes, binary)).catch(() => error('设备协议或音频帧无效')).finally(() => { pending--; queuedBytes -= bytes.length; });
    });
    socket.on('error', () => close(1011));
    socket.once('close', () => { cancel(); clearTimeout(idle); clearInterval(heartbeat); if (connection) this.control.detach(device.id, connection); this.sockets.delete(socket); });
  }
  onModuleDestroy() { for (const socket of this.sockets) socket.terminate(); this.sockets.clear(); }
}
