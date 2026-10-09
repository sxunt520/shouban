import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { connect, MqttClient } from 'mqtt';
import { createSocket, Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { R1mAccessService } from '../device-integration/r1m-access.service';
import { R1mControlService } from '../device-integration/r1m-control.service';
import { decodeProposalAudio, encodeProposalAudio, R1M_UDP_PROPOSAL } from '../device-integration/r1m-proposal-codec';
import { R1mVoiceService, R1mVoiceSocket } from './r1m-voice.service';

const base = 'shouban/r1m/v1';
interface Session {
  mac: string; deviceId: string; brokerConnection: string; socket: BridgeSocket; key: Buffer; nonce: Buffer;
  hello?: Record<string, unknown>; peer?: { address: string; port: number }; down: number; highest: number;
  capture: number; start: number; frames: Map<number, Buffer>; capturing: boolean;
}
class BridgeSocket extends EventEmitter implements R1mVoiceSocket {
  readyState = 1; bufferedAmount = 0;
  constructor(private output: (data: string | Buffer, binary: boolean, callback?: (e?: Error) => void) => void, private connected: () => boolean) { super(); }
  send(data: string | Buffer, options?: { binary?: boolean }, callback?: (e?: Error) => void) { this.output(data, options?.binary === true, callback); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() { if (this.connected()) this.emit('pong'); else this.close(); }
}

/** Company proposal adapter. Uses the same voice state machine as WS, but keeps MQTT/UDP wire details here. */
@Injectable()
export class R1mMqttVoiceService implements OnModuleInit, OnModuleDestroy {
  private client?: MqttClient; private udp?: Socket; private subscribed = false;
  private sessions = new Map<string, Session>(); private routes = new Map<number, Session>();
  private presence = new Map<string, { connectionId: string; id: string }>(); private chain = Promise.resolve();
  constructor(private access: R1mAccessService, private control: R1mControlService, private voice: R1mVoiceService) {}
  async onModuleInit() {
    if (process.env.R1M_MQTT_PROPOSAL_ENABLED !== 'true') return;
    if (process.env.R1M_DEV_ENABLED !== 'true' || !/_mqtt_(dev|test)$/.test(process.env.DB_DATABASE || '')) throw new Error('Company MQTT proposal requires isolated R1M development mode');
    this.udp = createSocket('udp4');
    this.udp.on('message', (packet, peer) => {
      if (packet.length < 33) return;
      const s = this.routes.get(packet.readUInt32BE(4)); if (!s || s.socket.readyState !== 1) return;
      try {
        const frame = decodeProposalAudio(packet, s.key, s.nonce, 'up');
        if (s.peer && (s.peer.address !== peer.address || s.peer.port !== peer.port)) return;
        if (!s.peer) s.peer = { address: peer.address, port: peer.port };
        if (frame.sequence > s.highest && frame.sequence <= s.highest + 167 && !s.frames.has(frame.sequence)) s.frames.set(frame.sequence, frame.payload);
      } catch { /* Authenticated envelopes are checked before peer pinning and Opus decoding. */ }
    });
    this.udp.on('error', () => this.reset());
    await new Promise<void>((resolve, reject) => { this.udp!.once('error', reject); this.udp!.bind(Number(process.env.R1M_UDP_PORT || 18901), process.env.R1M_UDP_HOST || '127.0.0.1', () => { this.udp!.removeListener('error', reject); resolve(); }); });
    this.client = connect(process.env.PARTNER_MQTT_URL!, { clientId: `figure-cloud-r1m-${randomBytes(8).toString('hex')}`, username: process.env.PARTNER_MQTT_USERNAME, password: process.env.PARTNER_MQTT_PASSWORD, reconnectPeriod: 1000, queueQoSZero: false, resubscribe: false });
    this.client.on('connect', () => this.client!.subscribe([`${base}/devices/+/up`, `${base}/broker/devices/+/presence`], { qos: 1 }, (error, grants) => { this.subscribed = !error && !!grants && grants.every(g => Number(g.qos) !== 128); }));
    this.client.on('close', () => { this.subscribed = false; this.reset(); });
    this.client.on('error', () => {});
    this.client.on('message', (topic, bytes, packet) => {
      if (bytes.length > 8192) return;
      this.chain = this.chain.then(async () => {
        const p = JSON.parse(bytes.toString()) as Record<string, unknown>;
        const presence = topic.match(/^shouban\/r1m\/v1\/broker\/devices\/([a-f0-9]{12})\/presence$/);
        if (presence) {
          const mac = presence[1], d = await this.access.mqttDevice(mac);
          if (!d || typeof p.connectionId !== 'string' || !['online', 'offline'].includes(String(p.state))) return;
          const old = this.presence.get(mac);
          if (p.state === 'offline' && old?.connectionId !== p.connectionId) return;
          if (p.state === 'online') this.presence.set(mac, { connectionId: p.connectionId, id: d.id }); else this.presence.delete(mac);
          this.control.brokerPresence(d.id, p.connectionId, p.state === 'online'); return;
        }
        const up = topic.match(/^shouban\/r1m\/v1\/devices\/([a-f0-9]{12})\/up$/);
        if (!up || packet.retain) return;
        await this.receive(up[1], p);
      }).catch(() => {});
    });
  }
  private reset() { for (const s of this.sessions.values()) s.socket.close(); this.sessions.clear(); this.routes.clear(); this.presence.clear(); this.control.resetBroker(); }
  private publish(mac: string, p: Record<string, unknown>, callback?: (e?: Error) => void) {
    if (!this.client?.connected || !this.subscribed) { callback?.(new Error('MQTT unavailable')); return; }
    this.client.publish(`${base}/devices/${mac}/down`, JSON.stringify(p), { qos: 1, retain: false }, error => callback?.(error || undefined));
  }
  private async receive(mac: string, p: Record<string, unknown>) {
    const connected = this.presence.get(mac); if (!connected) return;
    let s = this.sessions.get(mac);
    if (p.type === 'hello') {
      if (p.version !== 3 || p.transport !== 'udp' || p.udp_profile !== R1M_UDP_PROPOSAL) return;
      if (s?.socket.readyState === 1 && s.brokerConnection === connected.connectionId) { if (s.hello) this.publish(mac, s.hello); return; }
      const d = await this.access.mqttDevice(mac); if (!d) return;
      const nonce = randomBytes(16), key = randomBytes(16);
      while (this.routes.has(nonce.readUInt32BE(4))) randomBytes(4).copy(nonce, 4);
      const socket = new BridgeSocket((data, binary, cb) => {
        if (!s || s.socket.readyState !== 1) { cb?.(new Error('Session expired')); return; }
        if (binary) {
          if (!s.peer || s.down === 0xffffffff) { cb?.(new Error('UDP peer missing or sequence exhausted')); return; }
          const sequence = ++s.down, packet = encodeProposalAudio(data as Buffer, s.key, s.nonce, 'down', sequence, (sequence - 1) * 60);
          this.udp!.send(packet, s.peer.port, s.peer.address, error => cb?.(error || undefined)); return;
        }
        const payload = JSON.parse(data as string) as Record<string, unknown>;
        if (payload.type === 'hello') {
          const address = this.udp!.address(); if (typeof address === 'string') return;
          payload.transport = 'udp'; payload.version = 3; payload.udp_profile = R1M_UDP_PROPOSAL;
          payload.udp = { server: process.env.R1M_UDP_PUBLIC_HOST || address.address, port: address.port, key: s.key.toString('hex'), nonce: s.nonce.toString('hex') }; s.hello = payload;
        }
        if (payload.type === 'custom' && (payload.payload as Record<string, unknown> | undefined)?.cmd === 'play_audio') { s.capture++; s.capturing = false; s.frames.clear(); }
        if (payload.type === 'tts') payload.audio_sequence = payload.state === 'start' ? s.down + 1 : s.down;
        this.publish(mac, payload, cb);
      }, () => this.client?.connected === true && this.presence.get(mac)?.connectionId === connected.connectionId);
      s = { mac, deviceId: d.id, brokerConnection: connected.connectionId, socket, key, nonce, down: 0, highest: 0, capture: 0, start: 1, frames: new Map(), capturing: false };
      this.sessions.set(mac, s); this.routes.set(nonce.readUInt32BE(4), s);
      const session = s;
      socket.once('close', () => { session.capture++; session.key.fill(0); session.nonce.fill(0); session.hello = undefined; session.frames.clear(); if (this.sessions.get(mac) === session) this.sessions.delete(mac); for (const [route, value] of this.routes) if (value === session) this.routes.delete(route); });
      this.voice.connect(socket, d);
      socket.emit('message', Buffer.from(JSON.stringify({ ...p, transport: 'websocket', version: 1 })), false); return;
    }
    if (!s || s.brokerConnection !== connected.connectionId || p.session_id !== s.hello?.session_id) return;
    if (p.type === 'listen' && p.state === 'start') {
      if (p.mode !== 'manual' || !Number.isInteger(p.audio_sequence) || Number(p.audio_sequence) <= s.highest) { this.publish(mac, { type: 'alert', session_id: s.hello?.session_id, status: 'error', message: '提案 UDP 需 manual 及递增 audio_sequence', emotion: 'sad' }); return; }
      s.capture++; s.start = Number(p.audio_sequence); for (const n of s.frames.keys()) if (n < s.start) s.frames.delete(n); s.capturing = true;
    }
    if (p.type === 'abort' || p.type === 'goodbye') { s.capture++; s.capturing = false; s.frames.clear(); }
    if (p.type === 'listen' && p.state === 'stop') {
      const end = Number(p.audio_sequence), capture = s.capture, session = s;
      if (!Number.isInteger(end) || end < s.start || end - s.start >= 167 || !s.capturing) return;
      // Do not block MQTT processing: abort/new start can invalidate this drain window.
      setTimeout(() => {
        if (session.socket.readyState !== 1 || session.capture !== capture || !session.capturing) return;
        session.capturing = false; session.highest = end;
        for (let n = session.start; n <= end; n++) if (!session.frames.has(n)) {
          this.publish(mac, { type: 'alert', session_id: session.hello?.session_id, status: 'error', message: 'UDP 录音丢包，请重录', emotion: 'sad' }); session.socket.emit('message', Buffer.from(JSON.stringify({ type: 'abort', session_id: session.hello?.session_id })), false); session.frames.clear(); return;
        }
        for (let n = session.start; n <= end; n++) session.socket.emit('message', session.frames.get(n), true);
        session.frames.clear(); session.socket.emit('message', Buffer.from(JSON.stringify(p)), false);
      }, 200); return;
    }
    s.socket.emit('message', Buffer.from(JSON.stringify(p)), false);
  }
  async onModuleDestroy() {
    this.reset(); if (this.client) await new Promise<void>(resolve => this.client!.end(true, {}, () => resolve()));
    if (this.udp) await new Promise<void>(resolve => this.udp!.close(() => resolve()));
  }
}
