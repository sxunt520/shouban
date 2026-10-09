import { createSocket } from 'node:dgram';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { packAudio, unpackAudio, opusCodec, REFERENCE_VOICE_PROFILE } = require('../../api/dist/modules/device-integration/reference-audio.js');
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
function wav(pcm, rate) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
// Reference fixture transport, independent of the API process and database.
export class VoiceSimulator {
  constructor(device, { directory = resolve('.data/voice-simulator') } = {}) { this.device = device; this.directory = directory; this.inputs = new Map(); this.output = new Map(); this.lastResult = null; }
  async start() {
    this.socket = createSocket('udp4');
    await new Promise(resolvePromise => this.socket.bind(0, '127.0.0.1', resolvePromise));
    this.socket.on('error', error => this.device.log(`[${this.device.fixture.key}] UDP error: ${error.message}`));
    this.socket.on('message', (packet, peer) => {
      const s = this.session;
      if (!s || peer.port !== s.udp.port || peer.address !== s.udp.server) return;
      try {
        const f = unpackAudio(packet, Buffer.from(s.udp.reference_down_key, 'hex'), Buffer.from(s.udp.reference_down_nonce, 'hex'));
        if (f.sequence > 1000 || this.output.has(f.sequence) || f.timestamp !== (f.sequence - 1) * 60) return;
        this.output.set(f.sequence, f.payload);
      } catch { /* Ignore foreign, malformed and stale datagrams. */ }
    });
  }
  async handle(p) {
    if (p.type === 'reference.voice.begin') {
      if (typeof p.test_id !== 'string' || !Number.isInteger(p.count) || p.count < 0 || p.count > 167 || typeof p.text !== 'string' || p.text.length > 500) return true;
      this.generation = (this.generation || 0) + 1;
      this.session = null; this.output.clear(); this.inputs.clear();
      this.input = { id: p.test_id, count: p.count, text: p.text }; return true;
    }
    if (p.type === 'reference.voice.frame') {
      if (p.test_id === this.input?.id && Number.isInteger(p.index) && p.index >= 0 && p.index < this.input.count && typeof p.opus === 'string' && p.opus.length <= 1700) this.inputs.set(p.index, Buffer.from(p.opus, 'base64'));
      return true;
    }
    if (p.type === 'reference.voice.commit') {
      if (p.test_id !== this.input?.id || this.inputs.size !== this.input.count) return true;
      await this.device.publish({ type: 'hello', version: 3, transport: 'udp', reference_voice_profile: REFERENCE_VOICE_PROFILE, reference_test_id: this.input.id,
        audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }); return true;
    }
    if (p.type === 'hello' && p.reference_voice_profile === REFERENCE_VOICE_PROFILE) {
      if (!this.input || this.session?.session_id === p.session_id) return true;
      if (!p.udp || !/^[a-f0-9]{32}$/.test(p.udp.key) || !/^[a-f0-9]{32}$/.test(p.udp.nonce) || !/^[a-f0-9]{32}$/.test(p.udp.reference_down_key) || !/^[a-f0-9]{32}$/.test(p.udp.reference_down_nonce)) return true;
      this.session = p; this.output.clear();
      const input = this.input, frames = [...this.inputs.entries()].sort(([a], [b]) => a - b).map(([, frame]) => frame), generation = this.generation;
      void this.sendInput(p, input, frames, generation).catch(error => this.device.log(`[${this.device.fixture.key}] voice failed: ${error.message}`)); return true;
    }
    if (p.type === 'reference.listen.ready' && p.session_id === this.session?.session_id) { this.ready?.(); return true; }
    if (['abort', 'goodbye'].includes(p.type)) {
      if (p.session_id && p.session_id !== this.session?.session_id) return true;
      this.generation++; this.session = null; this.output.clear(); this.ready?.(); this.input = null; return true;
    }
    if (p.type === 'tts' && p.state === 'stop' && p.session_id === this.session?.session_id) {
      const s = this.session, generation = this.generation;
      void (async () => {
        await sleep(200); if (this.session !== s || generation !== this.generation) return;
        if (!this.output.size) { this.lastResult = { sessionId: s.session_id, error: 'No UDP reply audio' }; return; }
        let expected = 1; const codec = opusCodec(24000), chunks = [];
        for (const [index, frame] of [...this.output.entries()].sort(([a], [b]) => a - b)) {
          if (index !== expected++) throw new Error('Reply UDP packet gap');
          chunks.push(codec.decode(frame));
        }
        await mkdir(this.directory, { recursive: true });
        const path = resolve(this.directory, `${this.device.fixture.key}-${s.session_id}.wav`);
        await writeFile(path, wav(Buffer.concat(chunks), 24000));
        this.lastResult = { sessionId: s.session_id, frames: this.output.size, path };
        this.device.log(`[${this.device.fixture.key}] UDP reply decoded: ${this.output.size} frames → ${path}`);
      })().catch(error => { this.lastResult = { error: error.message }; }); return true;
    }
    if (['stt', 'tts', 'alert'].includes(p.type)) return true;
    return false;
  }
  async sendInput(s, input, frames, generation) {
    let timer;
    const ready = new Promise((resolvePromise, reject) => { this.ready = resolvePromise; timer = setTimeout(() => reject(new Error('Listener readiness timeout')), 3000); });
    const handled = ready.then(() => null, error => error);
    await this.device.publish({ type: 'listen', session_id: s.session_id, state: 'start', mode: 'manual' });
    const error = await handled; clearTimeout(timer); this.ready = null; if (error) throw error;
    // A silent Opus probe establishes the UDP return endpoint for text-only fixture tests.
    if (!frames.length) frames = [opusCodec(16000).encode(Buffer.alloc(1920), 960)];
    for (let i = 0; i < frames.length; i++) {
      if (this.session !== s || generation !== this.generation) return;
      const packet = packAudio(frames[i], Buffer.from(s.udp.key, 'hex'), Buffer.from(s.udp.nonce, 'hex'), i + 1, i * 60);
      await new Promise((resolvePromise, reject) => this.socket.send(packet, s.udp.port, s.udp.server, error => error ? reject(error) : resolvePromise()));
      await sleep(60);
    }
    if (this.session !== s || generation !== this.generation) return;
    await this.device.publish({ type: 'listen', session_id: s.session_id, state: input.text ? 'detect' : 'stop', mode: 'manual', reference_frame_count: frames.length, ...(input.text ? { text: input.text } : {}) });
  }
  async stop() { this.generation++; this.session = null; this.input = null; this.inputs.clear(); this.output.clear(); this.ready?.(); if (this.socket) await new Promise(resolvePromise => this.socket.close(resolvePromise)); }
}
