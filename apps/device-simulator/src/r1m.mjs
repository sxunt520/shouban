import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import opus from '@discordjs/opus';
const { OpusEncoder } = opus;
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(done => setTimeout(done, ms));
export function wavPcm(pcm, rate) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function inputPcm(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected PCM16 WAV');
  let pcm, valid = false;
  for (let i = 12; i + 8 <= wav.length;) {
    const n = wav.readUInt32LE(i + 4), start = i + 8;
    if (start + n > wav.length) throw new Error('Truncated WAV');
    const kind = wav.toString('ascii', i, i + 4);
    if (kind === 'fmt ' && n >= 16) valid = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
    if (kind === 'data') pcm = wav.subarray(start, start + n);
    i = start + n + (n % 2);
  }
  if (!valid || !pcm || pcm.length < 3200 || pcm.length > 320000 || pcm.length % 2) throw new Error('Expected 16kHz mono PCM16, 0.1–10s');
  return pcm;
}

/** Independent stock-wire simulator: no reference.* messages and no server codec imports. */
export class R1mSimulator {
  constructor(fixture, { base = 'http://127.0.0.1:3000', directory = '.data/r1m-simulator', ack = 'event', log = console.log } = {}) {
    this.fixture = fixture; this.base = base; this.directory = resolve(directory); this.ack = ack; this.log = log;
    this.volume = 60; this.revision = 0; this.identifyCount = 0; this.messages = []; this.results = []; this.frames = []; this.seen = new Set();
  }
  headers(bootstrap = false) { return { 'Device-Id': this.fixture.mac, 'Client-Id': this.fixture.clientUuid, 'Content-Type': 'application/json', Authorization: `Bearer ${bootstrap ? this.fixture.bootstrapSecret : this.token}` }; }
  async request(path, body, bootstrap = false) {
    const r = await fetch(`${this.base}${path}`, { method: 'POST', headers: this.headers(bootstrap), body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.message || `HTTP ${r.status}`); return data;
  }
  async configure() {
    const config = await this.request('/v1/partner/r1m/ota', { version: 2, mac_address: this.fixture.mac, uuid: this.fixture.clientUuid,
      board: { type: 'r1m', network: '4g' }, application: { version: 'r1m-ws-simulator-1.0.0' } }, true);
    if (config.websocket?.version !== 1 || config.mqtt) throw new Error('Expected exactly WebSocket v1 OTA policy');
    this.token = config.websocket.token; this.config = config; return config;
  }
  async start() {
    this.error = undefined; this.sessionId = undefined;
    await mkdir(this.directory, { recursive: true });
    this.statePath = resolve(this.directory, `${this.fixture.id}-state.json`);
    try { const s = JSON.parse(await readFile(this.statePath)); this.physicalUid = s.physicalUid; this.volume = s.volume; this.revision = s.revision; this.identifyCount = s.identifyCount || 0; this.seen = new Set(s.seen || []); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const config = await this.configure();
    const socket = this.socket = new WebSocket(config.websocket.url, { headers: { ...this.headers(), 'Protocol-Version': '1' } });
    socket.on('error', e => this.log(`[r1m] socket error: ${e.message}`));
    this.chain = Promise.resolve();
    socket.on('message', (data, binary) => { this.chain = this.chain.then(() => this.receive(data, binary)).catch(e => { this.error = e.message; this.log(`[r1m] receive failed: ${e.message}`); }); });
    await new Promise((done, reject) => { socket.once('open', done); socket.once('error', reject); });
    this.send({ type: 'hello', version: 1, transport: 'websocket', features: { mcp: false }, audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } });
    await this.until(() => !!this.sessionId); this.log('[r1m] WebSocket v1 control ready');
  }
  send(message) { this.socket.send(JSON.stringify({ ...message, ...(this.sessionId ? { session_id: this.sessionId } : {}) })); }
  async receive(bytes, binary) {
    if (binary) {
      if (!this.decoder || bytes.length > 1275) throw new Error('Unexpected bare Opus');
      const pcm = this.decoder.decode(bytes); if (pcm.length !== 2880) throw new Error('Expected 24kHz/60ms reply');
      this.frames.push(Buffer.from(pcm)); return;
    }
    const p = JSON.parse(bytes.toString()); this.messages.push(p);
    if (p.type === 'hello') { this.sessionId = p.session_id; this.decoder = new OpusEncoder(24000, 1); this.nfcSequence = 0; if (this.physicalUid !== undefined) this.reportNfc('nfc_state'); }
    if (p.session_id !== this.sessionId) return;
    if (p.type === 'custom' && p.payload?.type === 'nfc_ack') { this.nfcAcks ||= []; this.nfcAcks.push(p.payload); return; }
    if (p.type === 'custom') await this.execute({ id: p.payload.id, type: p.payload.cmd, args: p.payload.args, expiresAt: p.payload.expiresAt });
    if (p.command_id && this.seen.has(p.command_id)) return;
    if (p.command_id && p.type === 'tts' && p.state === 'start') { if (this.startedPlayback === p.command_id) return; this.startedPlayback = p.command_id; }
    if (p.type === 'tts' && p.state === 'stop' && p.cancelled) { this.frames = []; this.playbackCommand = undefined; return; }
    if (p.type === 'tts' && p.state === 'start') { if (p.command_id && p.command_id === this.playbackCommand) await this.playbackReceipt(p.command_id, 'playing'); this.frames = []; this.decoder = new OpusEncoder(24000, 1); }
    if (p.type === 'tts' && p.state === 'sentence_start') this.replyText = p.text;
    if (p.type === 'tts' && p.state === 'stop' && this.frames.length) {
      const audio = wavPcm(Buffer.concat(this.frames), 24000), path = resolve(this.directory, `${this.fixture.id}-${this.sessionId}-${this.results.length}.wav`);
      await writeFile(path, audio, { mode: 0o600 }); this.results.push({ sessionId: this.sessionId, text: this.replyText, frames: this.frames.length, path }); this.frames = [];
      this.log(`[r1m] decoded reply: ${this.results.at(-1).frames} Opus frames`);
      if (p.command_id) await this.completePlayback(p.command_id, this.results.at(-1).frames);
    }
    if (p.type === 'alert') { this.error = p.message; this.log(`[r1m] alert: ${p.message}`); }
  }
  reportNfc(type = 'nfc_tag_present', eventId = randomUUID(), overrides = {}) {
    const payload = { uid: this.physicalUid, present: !!this.physicalUid, sequence: (this.nfcSequence || 0) + 1, ts: Date.now(), ...overrides };
    this.nfcSequence = payload.sequence;
    const event = { eventId, type, payload }; this.send({ type: 'custom', payload: event }); return event;
  }
  async placeNfc(uid) {
    const old = this.physicalUid; this.physicalUid = uid; await this.persistState();
    return this.reportNfc(uid ? 'nfc_tag_present' : old ? 'nfc_tag_removed' : 'nfc_state', randomUUID(), { uid: uid || old || null });
  }
  async playbackReceipt(id, phase, frames, error) {
    if (this.ack === 'none') return;
    const result = { phase, ...(frames === undefined ? {} : { frames }), ...(error ? { error } : {}) };
    const event = { eventId: id, type: 'cmd_ack', payload: { result: error ? 'error' : 'ok', ...result } };
    if (this.ack === 'event') return this.request('/api/zckj/deviceEventReport', { deviceId: this.fixture.mac, ...event });
    this.send({ type: 'custom', payload: event });
  }
  async preparePlayback(c) {
    if (c.type === 'stop_playback') { if (this.playbackCommand === c.id) { this.playbackCommand = undefined; this.frames = []; this.received?.clear(); await this.playbackReceipt(c.id, 'stopped'); } return true; }
    if (c.type !== 'play_audio') return false;
    if (!c.expiresAt || c.expiresAt <= Date.now() || !Number.isInteger(c.args?.frames) || c.args.frames < 1) { await this.playbackReceipt(c.id, 'failed', undefined, '无效或过期的播放指令'); return true; }
    if (this.seen.has(c.id)) { await this.playbackReceipt(c.id, 'finished', c.args.frames); return true; }
    this.playbackCommand = c.id; this.expectedPlaybackFrames = c.args.frames; return true;
  }
  async completePlayback(id, frames) {
    if (id !== this.playbackCommand || this.seen.has(id)) return;
    if (frames !== this.expectedPlaybackFrames) { await this.playbackReceipt(id, 'failed', frames, '音频帧数不完整'); return; }
    this.seen.add(id); await this.persistState(); this.playbackCommand = undefined;
    await this.playbackReceipt(id, 'finished', frames);
  }
  async execute(c, http = false) {
    if (c.type === 'simulate_nfc') { if (!this.seen.has(c.id) && c.expiresAt > Date.now()) { this.seen.add(c.id); await this.placeNfc(c.args.present ? c.args.uid : null); } return; }
    if (await this.preparePlayback(c)) return;
    let status = 'ok', result;
    const unexpired = Number.isFinite(c.expiresAt) && c.expiresAt > Date.now();
    if (c.type === 'identify_device') {
      if (!unexpired || c.args?.pattern !== 'blink' || c.args.count !== 3 || c.args.intervalMs !== 300) status = 'error';
      else if (!this.seen.has(c.id)) {
        this.identifyCount++; this.seen.add(c.id);
        this.log('[r1m] identify: blink 3 times (simulated)');
        await this.persistState();
      }
      result = { pattern: 'blink', count: 3, executed: status === 'ok' };
    } else {
      if (c.type !== 'set_volume' || !Number.isInteger(c.args?.value) || c.args.value < 0 || c.args.value > 100 || !Number.isInteger(c.args?.revision) || c.args.revision < 0 || (c.expiresAt && c.expiresAt <= Date.now())) status = 'error';
      else if (!this.seen.has(c.id)) {
        if (c.args.revision >= this.revision) { this.volume = c.args.value; this.revision = c.args.revision; }
        this.seen.add(c.id); await this.persistState();
      }
      result = { volume: this.volume, revision: this.revision };
    }
    if (http) return this.request('/api/zckj/deviceCommands/ack', { deviceId: this.fixture.mac, id: c.id, status, result });
    if (this.ack === 'none') return;
    const event = { eventId: c.id, type: 'cmd_ack', payload: { result: status, ...result } };
    if (this.ack === 'event') return this.request('/api/zckj/deviceEventReport', { deviceId: this.fixture.mac, ...event });
    this.send({ type: 'custom', payload: event });
  }
  async persistState() {
    await writeFile(this.statePath, JSON.stringify({ volume: this.volume, revision: this.revision, identifyCount: this.identifyCount, physicalUid: this.physicalUid, seen: [...this.seen].slice(-100) }), { mode: 0o600 });
  }
  async pollOnce() { const data = await this.request('/api/zckj/deviceCommands', { deviceId: this.fixture.mac, since: 0 }); for (const c of data.commands) await this.execute(c, true); return data; }
  async detect(text) { this.error = undefined; this.send({ type: 'listen', state: 'detect', text }); }
  async speakWav(wav, mode = 'manual') {
    this.error = undefined; const pcm = inputPcm(wav), codec = new OpusEncoder(16000, 1);
    this.send({ type: 'listen', state: 'start', mode });
    for (let i = 0; i < pcm.length; i += 1920) { const frame = Buffer.alloc(1920); pcm.copy(frame, 0, i, i + 1920); this.socket.send(codec.encode(frame, 960)); await sleep(60); }
    if (mode === 'manual') this.send({ type: 'listen', state: 'stop' });
  }
  async until(check, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; if (this.error) throw new Error(this.error); await sleep(20); } throw new Error('R1M simulator timed out'); }
  async stop() {
    const s = this.socket; if (!s || s.readyState === WebSocket.CLOSED) return;
    await new Promise(done => { s.once('close', done); s.close(); });
    this.sessionId = undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).filter(s => s.startsWith('--')).map(s => s.slice(2).split('=')));
  const fixtures = JSON.parse(await readFile(process.env.R1M_FIXTURES_PATH || '.data/r1m-devices.json'));
  const fixture = fixtures.find(f => !args.device || f.id === args.device || f.hardwareId === args.device);
  if (!fixture) throw new Error('R1M fixture not found');
  const sim = new R1mSimulator(fixture, { base: process.env.R1M_API_BASE || 'http://127.0.0.1:3000' });
  const oneShot = !!(args.text || args.wav), lockPath = resolve(sim.directory, `${fixture.id}-voice.lock`);
  function voiceLocked() {
    if (!existsSync(lockPath)) return false;
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid simulator voice lock');
    try { process.kill(pid, 0); return true; } catch (e) { if (e.code !== 'ESRCH') throw e; unlinkSync(lockPath); return false; }
  }
  await mkdir(sim.directory, { recursive: true });
  voiceLocked();
  if (oneShot) await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  else while (voiceLocked()) await sleep(1000);
  try { await sim.start(); } catch (e) { if (oneShot) await unlink(lockPath); throw e; }
  if (oneShot) {
    try {
    if (args.wav) await sim.speakWav(await readFile(args.wav)); else await sim.detect(args.text);
    await sim.until(() => sim.results.length > 0, 60000); console.log(sim.results.at(-1));
    } finally { await sim.stop(); await unlink(lockPath); }
  } else {
    let closing = false, reconnecting = false;
    const timer = setInterval(() => { if (!closing && !reconnecting && !voiceLocked() && sim.socket.readyState === WebSocket.CLOSED) { reconnecting = true; void sim.start().catch(e => console.error(e.message)).finally(() => { reconnecting = false; }); } }, 5000);
    const stop = async () => { if (closing) return; closing = true; clearInterval(timer); await sim.stop(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }
}
