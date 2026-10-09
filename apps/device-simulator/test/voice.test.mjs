import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createLocalBroker } from '../src/broker.mjs';
import { DeviceSimulator } from '../src/device.mjs';
import { VoiceSimulator } from '../src/voice.mjs';
import { fixtures } from '../src/profile.mjs';
const require = createRequire(import.meta.url);
const { PartnerVoiceService } = require('../../api/dist/modules/figure-companion/partner-voice.service.js');
const { PartnerMqttAdapter } = require('../../api/dist/modules/device-integration/partner-mqtt.adapter.js');
const { packAudio, unpackAudio, encodePcm, readPcmWav, opusCodec } = require('../../api/dist/modules/device-integration/reference-audio.js');
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function until(get, predicate, label) { const end = Date.now() + 6000; while (Date.now() < end) { const v = await get(); if (predicate(v)) return v; await sleep(25); } throw new Error(`${label} timeout`); }
function wav(rate, duration = .18) {
  const pcm = Buffer.alloc(Math.round(rate * duration) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / rate)), i * 2);
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]);
}

test('reference audio codec and packet boundaries', () => {
  const input = readPcmWav(wav(16000)); const frames = encodePcm(input.pcm, input.rate);
  assert.equal(frames.length, 3); assert.equal(opusCodec(16000).decode(frames[0]).length, 1920);
  const key = Buffer.alloc(16, 7), nonce = Buffer.alloc(16, 9), packet = packAudio(frames[0], key, nonce, 1, 0);
  assert.equal(packet.readUInt16BE(2), frames[0].length); assert.equal(packet.readUInt32BE(12), 1);
  assert.deepEqual(unpackAudio(packet, key, nonce).payload, frames[0]);
  assert.notDeepEqual(packet.subarray(16), frames[0]);
  const bad = Buffer.from(packet); bad[2] ^= 1; assert.throws(() => unpackAudio(bad, key, nonce));
  assert.throws(() => unpackAudio(packet, key, Buffer.alloc(16, 8)));
  assert.throws(() => readPcmWav(Buffer.alloc(44))); assert.throws(() => readPcmWav(wav(16000).subarray(0, 50)));
});

test('reference voice over real MQTT and encrypted UDP (ASR/LLM/TTS test doubles)', { timeout: 25000 }, async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'shouban-voice-')); const config = resolve('config/mqtt-devices.json');
  Object.assign(process.env, { PARTNER_MQTT_ENABLED: 'true', PARTNER_VOICE_ENABLED: 'true', MQTT_SIMULATOR_FIXTURES: 'true', DB_DATABASE: 'voice_mqtt_test',
    PARTNER_VOICE_HOST: '127.0.0.1', PARTNER_VOICE_PORT: '0', PARTNER_MQTT_USERNAME: 'local-cloud', PARTNER_MQTT_PASSWORD: 'local-cloud-only', PARTNER_MQTT_FIXTURES_PATH: config });
  const broker = await createLocalBroker({ port: 0, log: () => {} }); process.env.PARTNER_MQTT_URL = `mqtt://127.0.0.1:${broker.port}`;
  const rows = fixtures().map(f => ({ ...f, ownerUserId: 'user-demo', characterId: 'role-1', protocolProfile: 'partner-mqtt-sim-v1', mqttOnline: true }));
  const repo = { findOneBy: async query => rows.find(d => Object.entries(query).every(([k, v]) => d[k] === v)) || null };
  let asrCount = 0, invalidate;
  const provider = { replyToPartnerVoice: async (_id, text, current) => { if (text === 'slow') await sleep(350); if (!current()) throw new Error('cancelled'); return { text: `reply:${text}`, audio: wav(24000) }; } };
  const asr = { recognizePcm16: async pcm => { asrCount++; assert.equal(pcm.length, 5760); return { text: 'recorded speech' }; } };
  const mqtt = new PartnerMqttAdapter(); mqtt.receiveWith(async e => {
    const d = rows.find(d => d.externalDeviceId === e.externalDeviceId);
    if (d && e.payload.type === 'presence' && e.payload.state === 'offline') d.mqttOnline = false;
  }, async () => {});
  const voice = new PartnerVoiceService(repo, mqtt, provider, asr, { onContextChanged: cb => { invalidate = cb; } });
  const sims = [];
  t.after(async () => { await Promise.all(sims.map(s => s.stop())); await voice.onModuleDestroy(); await mqtt.onModuleDestroy(); await broker.close(); await rm(dir, { recursive: true, force: true }); });
  await voice.onModuleInit(); mqtt.onModuleInit(); await until(() => mqtt.ready, Boolean, 'cloud ready');
  for (const fixture of fixtures()) {
    const sim = new DeviceSimulator(fixture, { stateDirectory: dir, log: () => {} });
    await sim.start(); sim.voice = new VoiceSimulator(sim, { directory: dir }); await sim.voice.start(); sims.push(sim);
  }
  const [a, b] = rows;
  await t.test('WAV fixture → UDP Opus → ASR → TTS UDP → device WAV', async () => {
    await voice.testInput('user-demo', a.id, { wav: wav(16000) });
    const state = await until(() => voice.status('user-demo', a.id), s => s.state === 'completed', 'WAV roundtrip');
    assert.equal(state.receivedFrames, 3); assert.equal(state.sentFrames, 3); assert.equal(state.transcript, 'recorded speech'); assert.equal(asrCount, 1);
    const result = await until(() => sims[0].voice.lastResult, Boolean, 'device decode');
    assert.equal(result.frames, 3); assert.equal(readPcmWav(await readFile(result.path)).rate, 24000);
    assert.equal((await voice.cachedAudio('user-demo', a.id, state.sessionId)).subarray(0, 4).toString(), 'RIFF');
  });
  await t.test('two devices have isolated sessions and text tests bypass ASR explicitly', async () => {
    const old = await voice.status('user-demo', a.id);
    await voice.testInput('user-demo', b.id, { text: 'B-only' });
    const s = await until(() => voice.status('user-demo', b.id), s => s.state === 'completed', 'B reply');
    assert.equal(s.reply, 'reply:B-only'); assert.notEqual(s.sessionId, old.sessionId); assert.equal(asrCount, 1);
    assert.deepEqual(await voice.status('user-demo', a.id), old);
  });
  await t.test('cross-owner access, physical reference and malformed WAV are rejected', async () => {
    await assert.rejects(voice.testInput('other-user', a.id, { text: 'x' }));
    await assert.rejects(voice.cachedAudio('other-user', a.id, (await voice.status('user-demo', a.id)).sessionId));
    rows.push({ ...a, id: 'physical', hardwareId: 'REF-test' });
    await assert.rejects(voice.status('user-demo', 'physical'));
    await assert.rejects(voice.testInput('user-demo', a.id, { wav: Buffer.alloc(100) }));
    await assert.rejects(voice.testInput('user-demo', a.id, { wav: wav(16000, 11) }));
  });
  await t.test('duplicate UDP frames are discarded; missing final frame fails before ASR', async () => {
    const socket = sims[0].voice.socket, original = socket.send.bind(socket);
    socket.send = (packet, port, host, callback) => {
      if (packet.readUInt32BE(12) === 1) original(packet, port, host, () => {});
      original(packet, port, host, callback);
    };
    try {
      await voice.testInput('user-demo', a.id, { wav: wav(16000) });
      const success = await until(() => voice.status('user-demo', a.id), s => s.state === 'completed', 'duplicate discard');
      assert.equal(success.receivedFrames, 3);
      const count = asrCount;
      socket.send = (packet, port, host, callback) => { if (packet.readUInt32BE(12) === 3) callback(null); else original(packet, port, host, callback); };
      await voice.testInput('user-demo', a.id, { wav: wav(16000) });
      const failed = await until(() => voice.status('user-demo', a.id), s => s.state === 'error', 'missing tail');
      assert.match(failed.error, /丢包/); assert.equal(asrCount, count); assert.equal(failed.sentFrames, 0);
    } finally { socket.send = original; }
  });
  await t.test('old session datagrams and goodbye cannot invalidate a new session', async () => {
    const old = sims[1].voice.session;
    await voice.testInput('user-demo', b.id, { text: 'slow' });
    await until(() => voice.status('user-demo', b.id), s => s.state === 'processing', 'new session');
    const active = await voice.status('user-demo', b.id);
    const packet = packAudio(opusCodec(16000).encode(Buffer.alloc(1920), 960), Buffer.from(old.udp.key, 'hex'), Buffer.from(old.udp.nonce, 'hex'), 1, 0);
    await new Promise((resolvePromise, reject) => sims[1].voice.socket.send(packet, old.udp.port, old.udp.server, error => error ? reject(error) : resolvePromise()));
    await mqtt.sendControl(b, { type: 'goodbye', session_id: old.session_id });
    const complete = await until(() => voice.status('user-demo', b.id), s => s.state === 'completed', 'new session survives');
    assert.equal(complete.sessionId, active.sessionId); assert.equal(complete.receivedFrames, 1); assert.equal(sims[1].voice.session.session_id, active.sessionId);
  });
  await t.test('abort suppresses a delayed reply and expires old preview', async () => {
    const old = await voice.status('user-demo', a.id);
    await voice.testInput('user-demo', a.id, { text: 'slow' });
    await until(() => voice.status('user-demo', a.id), s => s.state === 'processing', 'processing');
    await voice.abort('user-demo', a.id); await sleep(500);
    const s = await voice.status('user-demo', a.id); assert.equal(s.state, 'aborted'); assert.equal(s.sentFrames, 0); assert.equal(s.audioReady, false);
    await assert.rejects(voice.cachedAudio('user-demo', a.id, old.sessionId));
  });
  await t.test('context change and broker disconnect invalidate in-flight generations', async () => {
    await voice.testInput('user-demo', a.id, { text: 'slow' }); await until(() => voice.status('user-demo', a.id), s => s.state === 'processing', 'processing');
    invalidate(a.id); await sleep(500); assert.equal((await voice.status('user-demo', a.id)).state, 'aborted');
    await voice.testInput('user-demo', b.id, { text: 'slow' }); await until(() => voice.status('user-demo', b.id), s => s.state === 'processing', 'processing B');
    mqtt.client.stream.destroy(); await sleep(500); assert.equal((await voice.status('user-demo', b.id)).state, 'aborted');
  });
});
