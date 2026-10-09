import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { WebSocket } from 'ws';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { R1mSimulator, wavPcm } from '../src/r1m.mjs';
import { localEnvironment, projectRoot } from '../../../scripts/local-environment.mjs';
const require = createRequire(import.meta.url);
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(get, predicate, label, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await get(); if (predicate(value)) return value; await sleep(30); } throw new Error(`${label} timeout`); }
function wave(rate) { const pcm = Buffer.alloc(rate * .18 * 2); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / rate)), i * 2); return wavPcm(pcm, rate); }

test('R1M OTA + stock WebSocket v1 + shared command ledger (provider stubs, real MySQL)', { timeout: 45000 }, async t => {
  const env = localEnvironment(), directory = await mkdtemp(resolve(tmpdir(), 'shouban-r1m-'));
  const database = `shouban_${randomUUID().replaceAll('-', '').slice(0, 10)}_mqtt_test`;
  const admin = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD });
  let app; const sims = [];
  t.after(async () => { await Promise.all(sims.map(s => s.stop().catch(() => {}))); if (app) await app.close(); await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end(); await rm(directory, { recursive: true, force: true }); });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const fixtures = [3, 4].map(n => ({ id: randomUUID(), hardwareId: `R1M-TEST-${n}`, mac: `02:00:00:00:00:0${n}`, clientUuid: randomUUID(), name: `R1M test ${n}`, bootstrapSecret: randomBytes(32).toString('base64url'), pairingCode: `R1M-${randomBytes(10).toString('hex').toUpperCase()}`, transport: 'websocket', httpPolling: true }));
  const path = resolve(directory, 'fixtures.json'); await writeFile(path, JSON.stringify(fixtures), { mode: 0o600 });
  Object.assign(process.env, env, { DB_DATABASE: database, DB_SYNCHRONIZE: 'true', FIGURE_ENV_FILE: resolve(directory, 'missing.env'), R1M_DEV_ENABLED: 'true', R1M_FIXTURES_PATH: path, PARTNER_MQTT_ENABLED: 'false', MQTT_SIMULATOR_FIXTURES: 'false', PARTNER_VOICE_ENABLED: 'false', PARTNER_MQTT_COMMAND_TIMEOUT_MS: '6000', PARTNER_MQTT_RETRY_MS: '300' });
  const { AppModule } = require('../../api/dist/app.module.js');
  const { registerR1mVoiceWebSocket } = require('../../api/dist/modules/figure-companion/r1m-voice-websocket.js');
  const { AsrService } = require('../../api/dist/modules/figure-companion/asr.service.js');
  const { AiChatService } = require('../../api/dist/modules/figure-companion/ai-chat.service.js');
  const { TtsService } = require('../../api/dist/modules/figure-companion/tts.service.js');
  const { R1mAccessService } = require('../../api/dist/modules/device-integration/r1m-access.service.js');
  const { DeviceIntegrationService } = require('../../api/dist/modules/device-integration/device-integration.service.js');
  const { DeviceEntity, DeviceCommandEntity, ConversationMessageEntity, CharacterEntity } = require('../../api/dist/modules/figure-companion/entities.js');
  const { DataSource } = await import('typeorm');
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('v1', { exclude: ['api/zckj/deviceCommands', 'api/zckj/deviceCommands/ack', 'api/zckj/deviceEventReport'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  registerR1mVoiceWebSocket(app); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.R1M_WS_PUBLIC_URL = base.replace('http:', 'ws:') + '/v1/partner/r1m/voice';
  const source = app.get(DataSource), devices = source.getRepository(DeviceEntity), commands = source.getRepository(DeviceCommandEntity);
  const characters = source.getRepository(CharacterEntity);
  await characters.save({ id: 'r1m-role-1', name: 'Test role', description: 'test', accentColor: '#123456', voiceId: 'test-only', ttsModel: 'test-only', greeting: 'hello', prompt: 'test' });
  await characters.save({ id: 'r1m-role-2', name: 'Test role 2', description: 'test', accentColor: '#123456', voiceId: 'test-only', ttsModel: 'test-only', greeting: 'hello', prompt: 'test' });
  let asrCalls = 0, aiCalls = 0;
  app.get(AsrService).recognizePcm16 = async pcm => { asrCalls++; assert.equal(pcm.length, 5760); return { text: 'recorded R1M' }; };
  let realtimeAborts = 0;
  app.get(AsrService).startRealtimeRecognition = async progress => {
    let bytes = 0, stopped = false;
    return { write: pcm => { bytes += pcm.length; if (bytes >= 5760 && !stopped) queueMicrotask(() => { if (!stopped) progress({ final: true, text: 'auto R1M' }); }); },
      abort: () => { stopped = true; realtimeAborts++; }, finish: async () => ({ text: 'auto R1M' }) };
  };
  app.get(AiChatService).complete = async (_prompt, history) => { aiCalls++; const text = history.at(-1).content; if (text === 'slow') await sleep(400); return { content: `reply:${text}` }; };
  app.get(TtsService).synthesize = async () => ({ audio: wave(24000) });
  let token;
  const req = async (path, method = 'GET', body, auth = token) => {
    const r = await fetch(`${base}/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(data)}`); return data;
  };
  token = (await req('/auth/demo', 'POST', {})).accessToken;
  const [a, b] = fixtures;
  const sim = new R1mSimulator(a, { base, directory, log: () => {} }); sims.push(sim);
  const device = () => req(`/devices/${a.id}`);
  const volume = n => req(`/devices/${a.id}/volume`, 'PATCH', { volume: n });
  const bind = f => req('/devices/bind', 'POST', { pairingCode: f.pairingCode, externalDeviceId: f.mac.replaceAll(':', '') });

  await t.test('MAC alone is insufficient, activation fails closed, MQTT policy is gated', async () => {
    await assert.rejects(req('/partner/r1m/ota', 'POST', { mac_address: a.mac, uuid: a.clientUuid }), /401/);
    await assert.rejects(req('/partner/r1m/ota/activate', 'POST', { serial_number: 'fake', hmac: 'fake' }), /503/);
    const access = app.get(R1mAccessService), f = access.fixtures.find(f => f.id === b.id); f.transport = 'mqtt';
    const other = new R1mSimulator(b, { base, directory, log: () => {} }); await assert.rejects(other.configure(), /尚待验证/); f.transport = 'websocket';
  });
  await t.test('4G cloud claim without BLE and OTA does not invent online', async () => {
    await sim.configure();
    const claim = { pairingCode: a.pairingCode, externalDeviceId: a.mac.replaceAll(':', '') };
    assert.equal((await req('/devices/claim-status', 'POST', claim)).online, false);
    await sim.start(); assert.equal((await req('/devices/claim-status', 'POST', claim)).online, true);
    await bind(a); assert.equal((await device()).connectivity.controlReachable, true);
    await req(`/devices/${a.id}/character`, 'PATCH', { characterId: 'r1m-role-1' }); await sim.stop(); sim.sessionId = undefined; await sim.start();
  });
  await t.test('header token, UUID, protocol version and hello params are enforced', async () => {
    const rejected = (headers) => new Promise((done, reject) => { const socket = new WebSocket(process.env.R1M_WS_PUBLIC_URL, { headers }); socket.once('unexpected-response', (_r, response) => { assert.equal(response.statusCode, 401); response.resume(); socket.terminate(); done(); }); socket.once('open', () => { socket.terminate(); reject(new Error('Unauthorized socket accepted')); }); socket.on('error', () => {}); });
    await rejected({ ...sim.headers(), 'Protocol-Version': '1', 'Client-Id': b.clientUuid });
    await rejected({ ...sim.headers(), 'Protocol-Version': '2' });
    await rejected({ ...sim.headers(), 'Protocol-Version': '1', Authorization: 'Bearer incorrect' });
    await new Promise((done, reject) => {
      const wrong = new WebSocket(process.env.R1M_WS_PUBLIC_URL, { headers: { ...sim.headers(), 'Protocol-Version': '1' } });
      wrong.once('open', () => wrong.send(JSON.stringify({ type: 'hello', transport: 'websocket', version: 1, audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 20 } })));
      wrong.once('close', code => { try { assert.equal(code, 1008); done(); } catch (e) { reject(e); } }); wrong.on('error', reject);
    });
    assert.equal((await device()).connectivity.controlReachable, true, 'Invalid hello must not replace an authenticated device connection');
  });
  await t.test('bare Opus input reaches ASR; bare Opus reply decodes independently', async () => {
    await sim.speakWav(wave(16000)); await sim.until(() => sim.results.length === 1);
    assert.equal(asrCalls, 1); assert.equal(sim.results[0].frames, 3); assert.equal(sim.results[0].text, 'reply:recorded R1M');
    const audio = await readFile(sim.results[0].path); assert.equal(audio.readUInt32LE(24), 24000); assert.equal(audio.length, 44 + 3 * 2880);
    const history = await source.getRepository(ConversationMessageEntity).findBy({ deviceId: a.id }); assert.equal(history.length, 2); assert.equal(history[0].userId, 'user-demo');
  });
  await t.test('custom dispatch and HTTP event ACK update the same ledger', async () => {
    const pending = await volume(72); assert.equal(pending.volumeCommand.status, 'pending');
    const result = await until(device, d => d.volumeCommand.status === 'succeeded' && d.volume === 72, 'custom ACK'); assert.equal(result.volume, 72);
    const wire = sim.messages.find(p => p.type === 'custom' && p.payload.id === pending.volumeCommand.id); assert.equal(wire.payload.args.value, 72); assert.equal(wire.session_id, sim.sessionId);
    await sim.request('/api/zckj/deviceEventReport', { deviceId: a.mac, eventId: pending.volumeCommand.id, type: 'cmd_ack', payload: { result: 'ok', volume: 72, revision: wire.payload.args.revision } });
    assert.equal((await device()).volume, 72);
    sim.ack = 'custom'; await volume(73); await until(device, d => d.volumeCommand.status === 'succeeded' && d.volume === 73, 'WS custom ACK');
  });
  await t.test('identify uses WS custom ACK and cannot overwrite volume', async () => {
    const before = (await device()).volume;
    sim.ack = 'custom'; await req(`/devices/${a.id}/identify`, 'POST');
    await until(device, d => d.identifyCommand?.status === 'succeeded', 'WS identify ACK');
    assert.equal(sim.identifyCount, 1); assert.equal((await device()).volume, before);
    sim.ack = 'event';
  });
  await t.test('APP text playback shares WS binary v1 and waits for custom completion', async () => {
    const before = sim.results.length, calls = asrCalls; sim.ack = 'custom';
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'WS APP speech' });
    await until(device, d => d.speechCommand?.status === 'succeeded', 'WS speech complete');
    assert.equal(sim.results.length, before + 1); assert.equal(sim.results.at(-1).text, 'WS APP speech'); assert.equal(asrCalls, calls);
    sim.ack = 'event';
  });
  await t.test('WS custom NFC reports bind and removal keeps role while releasing voice', async () => {
    const uid = '04050607'; await req(`/devices/${a.id}/nfc-bindings`, 'PUT', { uid, characterId: 'r1m-role-1' });
    await sim.placeNfc(uid); await until(device, d => d.nfcState?.matched && d.nfcState.uid === uid, 'WS NFC match');
    await sim.placeNfc(null); await until(device, d => d.nfcState?.present === false, 'WS NFC removal');
    assert.equal((await device()).characterId, 'r1m-role-1');
    await until(() => sim.socket.readyState, x => x === WebSocket.CLOSED, 'NFC closes voice'); await sim.start();
  });
  await t.test('closed voice leaves unknown network; HTTP polling redelivers by id', async () => {
    await sim.stop(); const view = await until(device, d => !d.connectivity.controlReachable, 'closed control'); assert.equal(view.connectivity.network, 'unknown');
    const pending = await volume(68);
    const first = await sim.request('/api/zckj/deviceCommands', { deviceId: a.mac, since: 0 });
    const again = await sim.request('/api/zckj/deviceCommands', { deviceId: a.mac, since: Date.now() + 10000 });
    assert.equal(first.commands[0].id, pending.volumeCommand.id); assert.equal(again.commands[0].id, first.commands[0].id);
    await sim.execute(first.commands[0], true); const result = await device(); assert.equal(result.volume, 68); assert.equal(result.volumeCommand.status, 'succeeded');
    await assert.rejects(sim.request('/api/zckj/deviceCommands/ack', { deviceId: b.mac, id: first.commands[0].id, status: 'ok' }), /身份不一致/);
    sim.sessionId = undefined; await sim.start();
  });
  await t.test('new intentions supersede old receipts and cross-device ACKs fail', async () => {
    sim.ack = 'none'; const old = await volume(66); await until(device, d => d.volumeCommand.status === 'dispatched', 'dispatched');
    const next = await volume(65);
    const receipt = await sim.request('/api/zckj/deviceCommands/ack', { deviceId: a.mac, id: old.volumeCommand.id, status: 'ok', result: { volume: 66, revision: old.volumeCommand.revision } }); assert.equal(receipt.acknowledged, false);
    assert.equal((await commands.findOneBy({ id: old.volumeCommand.id })).status, 'cancelled');
    await sim.request('/api/zckj/deviceCommands/ack', { deviceId: a.mac, id: next.volumeCommand.id, status: 'ok', result: { volume: 65, revision: next.volumeCommand.revision } });
    await bind(b);
    const other = new R1mSimulator(b, { base, directory, log: () => {} }); await other.configure();
    await assert.rejects(other.request('/api/zckj/deviceCommands/ack', { deviceId: b.mac, id: next.volumeCommand.id, status: 'ok' }), /指令不属于此设备/);
  });
  await t.test('expired polling work is suppressed; ACK without measurements preserves reported volume', async () => {
    await sim.stop(); const before = (await device()).volume;
    const expired = await volume(64); await commands.update(expired.volumeCommand.id, { expiresAt: new Date(Date.now() - 1000) });
    const polled = await sim.request('/api/zckj/deviceCommands', { deviceId: a.mac, since: 0 }); assert.equal(polled.commands.length, 0);
    assert.equal((await commands.findOneBy({ id: expired.volumeCommand.id })).status, 'expired');
    const acknowledged = await volume(63);
    await sim.request('/api/zckj/deviceEventReport', { deviceId: a.mac, eventId: acknowledged.volumeCommand.id, type: 'cmd_ack', payload: { result: 'ok' } });
    const view = await device(); assert.equal(view.volumeCommand.status, 'succeeded'); assert.equal(view.volume, before);
    await sim.start();
  });
  await t.test('abort and new listen suppress delayed provider results', async () => {
    const count = sim.results.length; await sim.detect('slow'); await until(() => aiCalls, n => n >= 2, 'slow provider'); sim.send({ type: 'abort' }); await sleep(650); assert.equal(sim.results.length, count);
    const calls = aiCalls; await sim.detect('slow'); await until(() => aiCalls, n => n > calls, 'slow next'); await sim.detect('new-turn'); await sim.until(() => sim.results.length === count + 1);
    await sleep(500); assert.equal(sim.results.length, count + 1); assert.equal(sim.results.at(-1).text, 'reply:new-turn');
  });
  await t.test('OTA rotation and replacement socket isolate old sessions', async () => {
    const oldToken = sim.token, oldSession = sim.sessionId;
    const replacement = new R1mSimulator(a, { base, directory, log: () => {} }); sims.push(replacement); await replacement.start();
    assert.notEqual(replacement.token, oldToken); assert.notEqual(replacement.sessionId, oldSession);
    await until(() => sim.socket.readyState, n => n === WebSocket.CLOSED, 'old socket closed');
    replacement.send({ type: 'abort', session_id: oldSession }); await sleep(50); assert.equal((await device()).connectivity.controlReachable, true);
    await replacement.detect('replacement'); await replacement.until(() => replacement.results.length === 1);
    assert.equal(replacement.results[0].text, 'reply:replacement');
  });
  await t.test('automatic listen uses provider sentence-end without a device stop', async () => {
    const active = sims.at(-1), before = active.results.length, calls = asrCalls;
    await active.speakWav(wave(16000), 'auto'); await active.until(() => active.results.length === before + 1);
    assert.equal(active.results.at(-1).text, 'reply:auto R1M'); assert.equal(asrCalls, calls);
    assert.ok(realtimeAborts > 0);
    // Stock auto firmware resumes audio after TTS stop without another listen.start.
    const { OpusEncoder } = require('@discordjs/opus'), codec = new OpusEncoder(16000, 1), pcm = wave(16000).subarray(44);
    for (let i = 0; i < pcm.length; i += 1920) { active.socket.send(codec.encode(pcm.subarray(i, i + 1920), 960)); await sleep(60); }
    await active.until(() => active.results.length === before + 2); assert.equal(active.results.at(-1).text, 'reply:auto R1M');
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'interrupt automatic capture' });
    await until(device, d => d.speechCommand?.status === 'succeeded', 'APP interrupts automatic listening');
    assert.equal(active.results.at(-1).text, 'interrupt automatic capture');
    active.send({ type: 'abort' }); await sleep(50);
  });
  await t.test('role changes and unbind revoke pending voice and user data', async () => {
    const active = sims.at(-1), calls = aiCalls, outputsBefore = active.results.length; await active.detect('slow'); await until(() => aiCalls, n => n > calls, 'slow role');
    const before = await source.getRepository(ConversationMessageEntity).countBy({ deviceId: a.id });
    await req(`/devices/${a.id}/character`, 'PATCH', { characterId: 'r1m-role-2' }); await sleep(650);
    assert.equal(active.results.length, outputsBefore); assert.equal(await source.getRepository(ConversationMessageEntity).countBy({ deviceId: a.id }), before);
    active.sessionId = undefined; await active.start(); const calls2 = aiCalls; await active.detect('slow'); await until(() => aiCalls, n => n > calls2, 'slow unbind');
    await app.get(DeviceIntegrationService).unbind('user-demo', a.id); await sleep(650);
    const row = await devices.findOneBy({ id: a.id }); assert.equal(row.ownerUserId, null); assert.equal(row.characterId, null); assert.equal(active.socket.readyState, WebSocket.CLOSED);
  });
  await t.test('idle close releases voice/control without declaring the device network offline', async () => {
    process.env.R1M_WS_IDLE_MS = '250';
    const idleSim = new R1mSimulator(b, { base, directory, log: () => {} }); sims.push(idleSim); await idleSim.start();
    await until(() => idleSim.socket.readyState, n => n === WebSocket.CLOSED, 'idle close');
    const view = await req(`/devices/${b.id}`); assert.equal(view.connectivity.network, 'unknown'); assert.equal(view.connectivity.controlReachable, false); assert.equal(view.connectivity.voiceActive, false);
    delete process.env.R1M_WS_IDLE_MS;
  });
});
