import { connect } from 'mqtt';
import { createSocket } from 'node:dgram';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import opus from '@discordjs/opus';
import { R1mSimulator, wavPcm } from './r1m.mjs';
const { OpusEncoder } = opus;
export const udpProfile = 'company-udp-ctr-hmac-v1';
const pause = ms => new Promise(done => setTimeout(done, ms));
// Deliberately independent implementation of the published proposal, no API codec imports.
function material(key, nonce, direction) {
  const bytes = Buffer.from(hkdfSync('sha256', key, nonce, Buffer.from(`${udpProfile}/${direction}`), 48));
  return [bytes.subarray(0, 16), bytes.subarray(16)];
}
export function devicePacket(payload, key, nonce, direction, sequence, timestamp) {
  const h = Buffer.alloc(16); h[0] = 1; h[1] = 1; h.writeUInt16BE(payload.length, 2); nonce.copy(h, 4, 4, 8); h.writeUInt32BE(timestamp, 8); h.writeUInt32BE(sequence, 12);
  const counter = Buffer.alloc(16); nonce.copy(counter, 0, 0, 8); counter.writeUInt32BE(sequence, 8);
  const [aes, mac] = material(key, nonce, direction), cipher = createCipheriv('aes-128-ctr', aes, counter);
  const data = Buffer.concat([h, cipher.update(payload), cipher.final()]);
  return Buffer.concat([data, createHmac('sha256', mac).update(data).digest().subarray(0, 16)]);
}
export function deviceDecode(packet, key, nonce, direction) {
  if (packet.length < 33 || packet.length > 1307 || packet[0] !== 1 || packet[1] !== 1 || packet.readUInt16BE(2) !== packet.length - 32 || !packet.subarray(4, 8).equals(nonce.subarray(4, 8))) throw new Error('Invalid UDP envelope');
  const [aes, mac] = material(key, nonce, direction), data = packet.subarray(0, -16);
  if (!timingSafeEqual(packet.subarray(-16), createHmac('sha256', mac).update(data).digest().subarray(0, 16))) throw new Error('UDP authentication failed');
  const sequence = packet.readUInt32BE(12); if (!sequence) throw new Error('UDP sequence zero');
  const counter = Buffer.alloc(16); nonce.copy(counter, 0, 0, 8); counter.writeUInt32BE(sequence, 8);
  const cipher = createDecipheriv('aes-128-ctr', aes, counter);
  return { sequence, payload: Buffer.concat([cipher.update(data.subarray(16)), cipher.final()]) };
}
export class R1mMqttSimulator extends R1mSimulator {
  constructor(fixture, options = {}) { super(fixture, options); this.sequence = 0; this.received = new Map(); }
  headers(bootstrap = false) { return { ...super.headers(bootstrap), ...(this.fixture.serialNumber ? { 'Serial-Number': this.fixture.serialNumber, 'Activation-Version': '2' } : {}) }; }
  async configure() {
    const body = { version: 2, mac_address: this.fixture.mac, uuid: this.fixture.clientUuid, board: { type: 'r1m', network: '4g' }, application: { version: 'company-mqtt-simulator-1' } };
    let config = await this.request('/v1/partner/r1m/ota', body, true);
    if (config.activation) {
      const challenge = config.activation.challenge;
      const hmac = createHmac('sha256', Buffer.from(this.fixture.activationKeyHex, 'hex')).update(challenge, 'utf8').digest('hex');
      const activated = await this.request('/v1/partner/r1m/ota/activate', { algorithm: 'hmac-sha256', serial_number: this.fixture.serialNumber, challenge, hmac }, true);
      const r = await fetch(`${this.base}/v1/partner/r1m/ota`, { method: 'POST', headers: { ...this.headers(), Authorization: `Bearer ${activated.activation_token}` }, body: JSON.stringify(body) });
      config = await r.json(); if (!r.ok) throw new Error(config.message);
    }
    if (!config.mqtt || config.integration?.udp_profile !== udpProfile) throw new Error('Expected company MQTT/UDP proposal');
    this.config = config; this.token = config.mqtt.password; return config;
  }
  async start() {
    this.error = undefined; this.sessionId = undefined;
    await mkdir(this.directory, { recursive: true }); this.statePath = resolve(this.directory, `${this.fixture.id}-state.json`);
    try { const s = JSON.parse(await readFile(this.statePath)); this.physicalUid = s.physicalUid; this.volume = s.volume; this.revision = s.revision; this.identifyCount = s.identifyCount || 0; this.seen = new Set(s.seen || []); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const config = await this.configure();
    this.udp = createSocket('udp4'); this.udp.on('error', e => { this.error = e.message; });
    this.udp.on('message', packet => {
      if (!this.session) return;
      try { const frame = deviceDecode(packet, Buffer.from(this.session.udp.key, 'hex'), Buffer.from(this.session.udp.nonce, 'hex'), 'down'); if (frame.sequence >= (this.downStart || 1) && !this.received.has(frame.sequence)) this.received.set(frame.sequence, frame.payload); } catch {}
    });
    await new Promise(done => this.udp.bind(0, '127.0.0.1', done));
    const mqtt = config.mqtt, url = `${config.integration.mqtt_transport === 'tls' ? 'mqtts' : 'mqtt'}://${mqtt.endpoint}`;
    this.client = connect(url, { clientId: mqtt.client_id, username: mqtt.username, password: mqtt.password, keepalive: mqtt.keepalive, reconnectPeriod: 0 });
    this.chain = Promise.resolve();
    this.client.on('message', (_topic, bytes) => { this.chain = this.chain.then(() => this.receiveControl(JSON.parse(bytes))).catch(e => { this.error = e.message; }); });
    this.client.on('error', e => { this.error = e.message; });
    await new Promise((done, reject) => { this.client.once('connect', done); this.client.once('error', reject); });
    const down = mqtt.publish_topic.replace(/\/up$/, '/down');
    await new Promise((done, reject) => this.client.subscribe(down, { qos: 1 }, (e, grants) => e || grants.some(g => g.qos === 128) ? reject(e || new Error('Subscription denied')) : done()));
    this.hello(); await this.until(() => !!this.sessionId); this.log('[r1m-mqtt] activated and control ready');
  }
  hello() { this.send({ type: 'hello', version: 3, transport: 'udp', udp_profile: udpProfile, audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }); }
  send(p) { this.client.publish(this.config.mqtt.publish_topic, JSON.stringify({ ...p, ...(this.sessionId ? { session_id: this.sessionId } : {}) }), { qos: 1 }); }
  async receiveControl(p) {
    this.messages.push(p);
    if (p.type === 'hello') { if (this.sessionId === p.session_id) return; this.sessionId = p.session_id; this.session = p; this.nfcSequence = 0; this.sequence = 0; this.downStart = 1; this.received.clear();
      const probe = devicePacket(new OpusEncoder(16000, 1).encode(Buffer.alloc(1920), 960), Buffer.from(p.udp.key, 'hex'), Buffer.from(p.udp.nonce, 'hex'), 'up', ++this.sequence, 0);
      await new Promise((done, reject) => this.udp.send(probe, p.udp.port, p.udp.server, e => e ? reject(e) : done()));
      if (this.physicalUid !== undefined) this.reportNfc('nfc_state');
    }
    if (p.session_id !== this.sessionId) return;
    if (p.type === 'custom' && p.payload?.type === 'nfc_ack') { this.nfcAcks ||= []; this.nfcAcks.push(p.payload); return; }
    if (p.type === 'custom') await this.execute({ id: p.payload.id, type: p.payload.cmd, args: p.payload.args, expiresAt: p.payload.expiresAt });
    if (p.command_id && this.seen.has(p.command_id)) return;
    if (p.command_id && p.type === 'tts' && p.state === 'start') { if (this.startedPlayback === p.command_id) return; this.startedPlayback = p.command_id; }
    if (p.type === 'tts' && p.state === 'stop' && p.cancelled) { this.received.clear(); this.playbackCommand = undefined; return; }
    if (p.type === 'tts' && p.state === 'start') { this.downStart = p.audio_sequence; for (const n of this.received.keys()) if (n < this.downStart) this.received.delete(n); if (p.command_id && p.command_id === this.playbackCommand) await this.playbackReceipt(p.command_id, 'playing'); }
    if (p.type === 'tts' && p.state === 'sentence_start') this.replyText = p.text;
    if (p.type === 'tts' && p.state === 'stop') {
      await pause(200); if (p.session_id !== this.sessionId) return; const codec = new OpusEncoder(24000, 1), chunks = [];
      for (let n = this.downStart; n <= p.audio_sequence; n++) { const frame = this.received.get(n); if (!frame) { if (p.command_id) await this.playbackReceipt(p.command_id, 'failed', undefined, 'Downlink UDP loss'); throw new Error('Downlink UDP loss'); } chunks.push(codec.decode(frame)); }
      if (chunks.length) {
        const path = resolve(this.directory, `${this.fixture.id}-${this.sessionId}-${this.results.length}.wav`);
        await writeFile(path, wavPcm(Buffer.concat(chunks), 24000), { mode: 0o600 }); this.results.push({ sessionId: this.sessionId, text: this.replyText, frames: chunks.length, path }); this.log(`[r1m-mqtt] decoded ${chunks.length} authenticated Opus frames`);
        if (p.command_id) await this.completePlayback(p.command_id, chunks.length);
      }
    }
    if (p.type === 'alert') this.error = p.message;
    if (p.type === 'goodbye') { this.sessionId = undefined; this.session = undefined; }
  }
  async speakWav(wav, { dropSequence, duplicate = false } = {}) {
    if (wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16 || wav.length < 3244 || wav.length > 320044) throw new Error('Need 16kHz mono PCM16 WAV');
    this.error = undefined; const pcm = wav.subarray(44), codec = new OpusEncoder(16000, 1);
    this.send({ type: 'listen', state: 'start', mode: 'manual', audio_sequence: this.sequence + 1 });
    for (let i = 0; i < pcm.length; i += 1920) {
      const frame = Buffer.alloc(1920); pcm.copy(frame, 0, i, i + 1920);
      const sequence = ++this.sequence, packet = devicePacket(codec.encode(frame, 960), Buffer.from(this.session.udp.key, 'hex'), Buffer.from(this.session.udp.nonce, 'hex'), 'up', sequence, (sequence - 1) * 60);
      if (sequence !== dropSequence) { await new Promise((done, reject) => this.udp.send(packet, this.session.udp.port, this.session.udp.server, e => e ? reject(e) : done())); if (duplicate) this.udp.send(packet, this.session.udp.port, this.session.udp.server); }
      await pause(60);
    }
    this.send({ type: 'listen', state: 'stop', audio_sequence: this.sequence });
  }
  async stop() {
    if (this.client) await new Promise(done => this.client.end(!this.client.connected, {}, done)); this.client = undefined;
    if (this.udp) await new Promise(done => this.udp.close(done)); this.udp = undefined; this.sessionId = undefined;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
  const f = JSON.parse(await readFile(process.env.R1M_FIXTURES_PATH || '.data/r1m-devices.json')).find(f => f.transport === 'mqtt');
  if (!f) throw new Error('No MQTT fixture');
  const sim = new R1mMqttSimulator(f, { base: process.env.R1M_API_BASE || 'http://127.0.0.1:3000' });
  const lockPath = resolve(sim.directory, `${f.id}-voice.lock`), oneShot = !!args.wav;
  function locked() {
    if (!existsSync(lockPath)) return false;
    const pid = Number(readFileSync(lockPath, 'utf8')); if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid voice lease');
    try { process.kill(pid, 0); return true; } catch (e) { if (e.code !== 'ESRCH') throw e; unlinkSync(lockPath); return false; }
  }
  await mkdir(sim.directory, { recursive: true }); locked();
  if (oneShot) await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  else while (locked()) await pause(1000);
  try { await sim.start(); } catch (e) { if (oneShot) await unlink(lockPath); throw e; }
  if (oneShot) { try { await sim.speakWav(await readFile(args.wav)); await sim.until(() => sim.results.length, 60000); console.log(sim.results.at(-1)); } finally { await sim.stop(); await unlink(lockPath); } }
  else {
    let closing = false, reconnecting = false;
    const timer = setInterval(() => {
      if (closing || reconnecting || locked()) return;
      if (sim.client?.connected) { if (!sim.sessionId) sim.hello(); }
      else { reconnecting = true; void sim.stop().then(() => sim.start()).catch(e => console.error(e.message)).finally(() => { reconnecting = false; }); }
    }, 5000);
    const stop = async () => { closing = true; clearInterval(timer); await sim.stop(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }
}
