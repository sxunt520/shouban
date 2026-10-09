import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { R1mMqttSimulator, devicePacket, deviceDecode, udpProfile } from '../src/r1m-mqtt.mjs';
import { wavPcm } from '../src/r1m.mjs';
import { createLocalBroker } from '../src/broker.mjs';
import { localEnvironment, projectRoot } from '../../../scripts/local-environment.mjs';
const require = createRequire(import.meta.url), sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(get, predicate, label) { for (let i = 0; i < 180; i++) { const value = await get(); if (predicate(value)) return value; await sleep(30); } throw new Error(`${label} timeout`); }
function wave(rate, duration = .18) { const pcm = Buffer.alloc(rate * duration * 2); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / rate)), i * 2); return wavPcm(pcm, rate); }

test('proposal codec has interoperable vectors, authenticated header, distinct directions and packet IVs', () => {
  const { encodeProposalAudio, decodeProposalAudio } = require('../../api/dist/modules/device-integration/r1m-proposal-codec.js');
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), nonce = Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex'), data = Buffer.alloc(1000, 7);
  const vectors = require('../../../config/r1m-proposal-vectors.json');
  for (const v of vectors.audio) {
    const k = Buffer.from(vectors.key, 'hex'), n = Buffer.from(vectors.nonce, 'hex'), payload = Buffer.from(v.payload, 'hex');
    assert.equal(devicePacket(payload, k, n, v.direction, v.sequence, v.timestamp).toString('hex'), v.packet);
    assert.deepEqual(decodeProposalAudio(Buffer.from(v.packet, 'hex'), k, n, v.direction).payload, payload);
  }
  assert.equal(createHmac('sha256', Buffer.from(vectors.activation.key, 'hex')).update(vectors.activation.challenge, 'utf8').digest('hex'), vectors.activation.hmac);
  const packet = encodeProposalAudio(data, key, nonce, 'up', 1, 0);
  assert.deepEqual(packet, devicePacket(data, key, nonce, 'up', 1, 0)); assert.deepEqual(deviceDecode(packet, key, nonce, 'up').payload, data);
  assert.deepEqual(decodeProposalAudio(devicePacket(data, key, nonce, 'down', 1, 0), key, nonce, 'down').payload, data);
  assert.throws(() => deviceDecode(packet, key, nonce, 'down'));
  for (const offset of [4, 8, 12, 16, packet.length - 1]) { const bad = Buffer.from(packet); bad[offset] ^= 1; assert.throws(() => decodeProposalAudio(bad, key, nonce, 'up')); }
  const next = encodeProposalAudio(data, key, nonce, 'up', 2, 0); assert.notDeepEqual(packet.subarray(32, 48), next.subarray(16, 32), 'Adjacent packets must not overlap AES counters');
  assert.throws(() => encodeProposalAudio(data, key, nonce, 'up', 0, 0));
});

test('company R1M HMAC activation, real MQTT broker presence and authenticated UDP', { timeout: 45000 }, async t => {
  const env = localEnvironment(), dir = await mkdtemp(resolve(tmpdir(), 'r1m-mqtt-')), database = `shouban_${randomUUID().replaceAll('-', '').slice(0, 10)}_mqtt_test`;
  const admin = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD });
  let app, broker; const sims = [];
  t.after(async () => { await Promise.all(sims.map(s => s.stop().catch(() => {}))); if (app) await app.close(); if (broker) await broker.close(); await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end(); await rm(dir, { recursive: true, force: true }); });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const fixtures = [4, 5].map(n => ({ id: randomUUID(), hardwareId: `R1M-MQTT-${n}`, mac: `02:00:00:00:00:0${n}`, clientUuid: randomUUID(), name: `MQTT ${n}`, bootstrapSecret: randomBytes(32).toString('base64url'), pairingCode: `R1M-${randomBytes(10).toString('hex').toUpperCase()}`, transport: 'mqtt', httpPolling: true, serialNumber: `DEV-${n}`, activationKeyHex: randomBytes(32).toString('hex') }));
  const path = resolve(dir, 'fixtures.json'); await writeFile(path, JSON.stringify(fixtures), { mode: 0o600 });
  Object.assign(env, { DB_DATABASE: database, DB_SYNCHRONIZE: 'true', FIGURE_ENV_FILE: resolve(dir, 'missing.env'), R1M_DEV_ENABLED: 'true', R1M_FIXTURES_PATH: path, R1M_MQTT_PROPOSAL_ENABLED: 'true', R1M_BROKER_ADMIN_TOKEN: randomBytes(32).toString('hex'), PARTNER_MQTT_ENABLED: 'false', MQTT_SIMULATOR_FIXTURES: 'false', PARTNER_VOICE_ENABLED: 'false', PARTNER_MQTT_FIXTURES_PATH: resolve(projectRoot, 'config/mqtt-devices.json'), R1M_UDP_HOST: '127.0.0.1', R1M_UDP_PORT: '0', PARTNER_MQTT_COMMAND_TIMEOUT_MS: '6000', PARTNER_MQTT_RETRY_MS: '300' });
  broker = await createLocalBroker({ env, port: 0, log: () => {} }); env.PARTNER_MQTT_URL = `mqtt://127.0.0.1:${broker.port}`; env.R1M_MQTT_DEVICE_URL = env.PARTNER_MQTT_URL;
  Object.assign(process.env, env);
  const { AppModule } = require('../../api/dist/app.module.js');
  const { AsrService } = require('../../api/dist/modules/figure-companion/asr.service.js');
  const { AiChatService } = require('../../api/dist/modules/figure-companion/ai-chat.service.js');
  const { TtsService } = require('../../api/dist/modules/figure-companion/tts.service.js');
  const { R1mAccessService } = require('../../api/dist/modules/device-integration/r1m-access.service.js');
  const { DeviceIntegrationService } = require('../../api/dist/modules/device-integration/device-integration.service.js');
  const { R1mControlService } = require('../../api/dist/modules/device-integration/r1m-control.service.js');
  const { CharacterEntity, DeviceCommandEntity, ReminderEntity, NfcBindingEntity, DeviceEventEntity } = require('../../api/dist/modules/figure-companion/entities.js');
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('v1', { exclude: ['api/zckj/deviceCommands', 'api/zckj/deviceCommands/ack', 'api/zckj/deviceEventReport'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`; env.R1M_BROKER_API_BASE = base;
  const source = app.get(DataSource); await source.getRepository(CharacterEntity).save({ id: 'mqtt-role', name: 'Test role', description: 'test', accentColor: '#123456', voiceId: 'test', ttsModel: 'test', greeting: 'hi', prompt: 'test' });
  let asrCalls = 0;
  app.get(AsrService).recognizePcm16 = async pcm => { asrCalls++; assert.equal(pcm.length, 5760); return { text: 'UDP recorded' }; };
  app.get(AiChatService).complete = async () => ({ content: 'UDP reply' }); app.get(TtsService).synthesize = async () => ({ audio: wave(24000) });
  let token;
  const req = async (path, method = 'GET', body) => { const r = await fetch(`${base}/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(data)}`); return data; };
  token = (await req('/auth/demo', 'POST', {})).accessToken;
  const [a,b] = fixtures, sim = new R1mMqttSimulator(a, { base, directory: dir, log: () => {} }); sims.push(sim);
  await t.test('challenge HMAC, wrong proof, expiry, replay and one-use OTA ticket', async () => {
    const body = { mac_address: a.mac, uuid: a.clientUuid };
    const ota = () => sim.request('/v1/partner/r1m/ota', body, true);
    const challenge = (await ota()).activation.challenge;
    const proof = { algorithm: 'hmac-sha256', serial_number: a.serialNumber, challenge, hmac: createHmac('sha256', Buffer.from(a.activationKeyHex, 'hex')).update(challenge).digest('hex') };
    await assert.rejects(sim.request('/v1/partner/r1m/ota/activate', { ...proof, hmac: '00'.repeat(32) }, true), /证明无效/);
    const activation = await sim.request('/v1/partner/r1m/ota/activate', proof, true); assert.ok(activation.activation_token);
    await assert.rejects(sim.request('/v1/partner/r1m/ota/activate', proof, true));
    const follow = async () => { const r = await fetch(`${base}/v1/partner/r1m/ota`, { method: 'POST', headers: { ...sim.headers(), Authorization: `Bearer ${activation.activation_token}` }, body: JSON.stringify(body) }); return r.json(); };
    assert.equal((await follow()).integration.udp_profile, udpProfile); assert.ok((await follow()).activation, 'Ticket cannot issue credentials twice');
    const access = app.get(R1mAccessService), expiredChallenge = access.challenges.get(a.id); expiredChallenge.expires = Date.now() - 1;
    const expiredProof = { ...proof, challenge: expiredChallenge.value, hmac: createHmac('sha256', Buffer.from(a.activationKeyHex, 'hex')).update(expiredChallenge.value).digest('hex') };
    await assert.rejects(sim.request('/v1/partner/r1m/ota/activate', expiredProof, true));
    assert.ok((await ota()).activation); // Activation alone never makes identity-only OTA authorized.
  });
  await sim.start();
  await req('/devices/bind', 'POST', { pairingCode: a.pairingCode, externalDeviceId: a.mac.replaceAll(':', '') });
  await req(`/devices/${a.id}/character`, 'PATCH', { characterId: 'mqtt-role' }); await until(() => sim.sessionId, x => !x, 'role closes voice'); sim.hello(); await sim.until(() => !!sim.sessionId);
  const view = () => req(`/devices/${a.id}`);
  await t.test('Broker connected evidence survives voice close; ordinary DISCONNECT marks unknown without a will', async () => {
    sim.send({ type: 'goodbye' }); await until(view, d => !d.connectivity.controlReachable, 'voice closed'); assert.equal((await view()).connectivity.network, 'online');
    sim.hello(); await sim.until(() => !!sim.sessionId);
    await sim.stop(); const d = await until(view, d => d.connectivity.network === 'unknown', 'normal disconnect'); assert.equal(d.connectivity.controlReachable, false);
    await sim.start();
  });
  await t.test('real MQTT control and independent authenticated UDP Opus roundtrip', async () => {
    await sim.speakWav(wave(16000), { duplicate: true }); await sim.until(() => sim.results.length === 1);
    assert.equal(asrCalls, 1); assert.equal(sim.results[0].frames, 3); const wav = await readFile(sim.results[0].path); assert.equal(wav.length, 44 + 3 * 2880);
    assert.ok(!sim.messages.some(p => String(p.type).startsWith('reference.')));
  });
  await t.test('missing final datagram fails before ASR, next round recovers', async () => {
    await sim.speakWav(wave(16000), { dropSequence: sim.sequence + 3 }); await until(() => sim.error, x => !!x, 'loss detected'); assert.equal(asrCalls, 1); assert.match(sim.error, /丢包/);
    await sim.speakWav(wave(16000)); await sim.until(() => sim.results.length === 2); assert.equal(asrCalls, 2);
  });
  await t.test('custom and HTTP polling still share the command ledger', async () => {
    await req(`/devices/${a.id}/volume`, 'PATCH', { volume: 76 }); await until(view, d => d.volumeCommand?.status === 'succeeded', 'volume ACK'); assert.equal((await view()).volume, 76);
    sim.send({ type: 'goodbye' }); await until(view, d => !d.connectivity.controlReachable, 'closed voice');
    await req(`/devices/${a.id}/volume`, 'PATCH', { volume: 75 }); await sim.pollOnce(); assert.equal((await view()).volume, 75); sim.hello(); await sim.until(() => !!sim.sessionId);
  });
  await t.test('APP speech streams authenticated UDP and completes only on device receipt', async () => {
    const before = sim.results.length, calls = asrCalls;
    const command = await req(`/devices/${a.id}/speak`, 'POST', { text: 'APP direct speech' });
    assert.equal((await req(`/devices/${a.id}/speak`, 'POST', { text: 'APP direct speech' })).id, command.id);
    await assert.rejects(req(`/devices/${a.id}/speak`, 'POST', { text: 'different text' }), /409/);
    await until(view, d => d.speechCommand?.status === 'succeeded', 'speech completed').catch(async e => { throw new Error(`${e.message}: ${JSON.stringify({speech:(await view()).speechCommand,error:sim.error,outputs:sim.results.length,wire:sim.messages.filter(p=>p.type==='tts'||p.type==='custom').slice(-8)})}`); });
    assert.equal(asrCalls, calls); assert.equal(sim.results.length, before + 1); assert.equal(sim.results.at(-1).text, 'APP direct speech');
    assert.equal(sim.results.at(-1).frames, 3); assert.equal((await view()).speechCommand.phase, 'finished');
    const wire = sim.messages.find(p => p.type === 'custom' && p.payload.cmd === 'play_audio' && p.payload.id === command.id);
    assert.ok(wire); await sim.execute({ id: command.id, type: 'play_audio', args: wire.payload.args, expiresAt: wire.payload.expiresAt });
    assert.equal(sim.results.length, before + 1, 'Duplicate playback command cannot play again');
  });
  await t.test('stop during delayed TTS prevents audio; disconnect and missing receipts cannot succeed', async () => {
    const tts = app.get(TtsService), normal = tts.synthesize; let calls = 0;
    tts.synthesize = async () => { calls++; await sleep(300); return { audio: wave(24000) }; };
    const before = sim.results.length;
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'cancel slow TTS' }); await until(() => calls, n => n === 1, 'TTS started');
    await req(`/devices/${a.id}/playback/stop`, 'POST'); await sleep(450); assert.equal(sim.results.length, before); assert.equal((await view()).speechCommand.status, 'cancelled');
    tts.synthesize = normal; sim.ack = 'none';
    const command = await req(`/devices/${a.id}/speak`, 'POST', { text: 'receipt required' });
    await until(view, d => d.speechCommand?.phase === 'awaiting_completion', 'await completion');
    assert.equal((await view()).speechCommand.status, 'dispatched');
    await assert.rejects(sim.request('/api/zckj/deviceCommands/ack', { deviceId: a.mac, id: command.id, status: 'ok', result: { phase: 'finished', frames: 1 } }), /播放完成回执无效/);
    await sim.stop(); await until(view, d => d.speechCommand?.status === 'cancelled', 'disconnect cancels playback');
    sim.ack = 'event'; await sim.start();
  });
  await t.test('stop during audio streaming, TTS failure and offline expiry expose terminal states', async () => {
    const tts = app.get(TtsService), normal = tts.synthesize;
    tts.synthesize = async () => ({ audio: wave(24000, 1.2) });
    const before = sim.results.length;
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'stop audio stream' });
    await until(view, d => d.speechCommand?.phase === 'playing', 'playing receipt');
    await req(`/devices/${a.id}/playback/stop`, 'POST'); await sleep(400);
    assert.equal((await view()).speechCommand.status, 'cancelled'); await until(view, d => d.speechCommand?.phase === 'stopped', 'device stopped receipt'); assert.equal(sim.results.length, before);
    tts.synthesize = async () => { throw new Error('Explicit test TTS failure'); };
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'TTS fails' });
    await until(view, d => d.speechCommand?.status === 'failed', 'TTS failure');
    assert.match((await view()).speechCommand.errorMessage, /Explicit test/);
    tts.synthesize = normal; await sim.stop();
    const queued = await req(`/devices/${a.id}/speak`, 'POST', { text: 'offline expires' });
    assert.equal((await view()).speechCommand.phase, 'waiting');
    await source.getRepository(DeviceCommandEntity).update(queued.id, { expiresAt: new Date(Date.now() - 1) });
    await until(view, d => d.speechCommand?.status === 'expired', 'offline timeout');
    await sim.start();
  });
  await t.test('device listen.start interrupts APP playback without completing partial audio', async () => {
    const tts = app.get(TtsService), normal = tts.synthesize;
    tts.synthesize = async () => ({ audio: wave(24000, 1.2) });
    const before = sim.results.length;
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'interrupted by device' });
    await until(view, d => d.speechCommand?.phase === 'playing', 'APP playing');
    tts.synthesize = normal;
    await sim.speakWav(wave(16000)); await sim.until(() => sim.results.length === before + 1);
    assert.equal((await view()).speechCommand.status, 'cancelled'); assert.equal(sim.results.at(-1).text, 'UDP reply');
    assert.equal(sim.results.length, before + 1);
  });
  await t.test('identify custom is deduplicated, independent of volume revision and uses HTTP fallback', async () => {
    const c = await req(`/devices/${a.id}/identify`, 'POST');
    await until(view, d => d.identifyCommand?.status === 'succeeded', 'identify ACK');
    assert.equal(sim.identifyCount, 1);
    await sim.execute({ id: c.id, type: c.type, args: c.payload, expiresAt: new Date(c.expiresAt).getTime() });
    assert.equal(sim.identifyCount, 1, 'QoS retry must not blink twice');
    sim.send({ type: 'goodbye' }); await until(view, d => !d.connectivity.controlReachable, 'closed voice');
    const pending = await req(`/devices/${a.id}/identify`, 'POST');
    assert.equal((await req(`/devices/${a.id}/identify`, 'POST')).id, pending.id, 'Repeated taps reuse pending request');
    await req(`/devices/${a.id}/volume`, 'PATCH', { volume: 72 });
    await sim.pollOnce(); assert.equal(sim.identifyCount, 2); assert.equal((await view()).identifyCommand.status, 'succeeded');
    assert.equal((await view()).volume, 72, 'Volume revision cannot cancel identify');
    await assert.rejects(req(`/devices/${b.id}/identify`, 'POST'), /404/);
    await sim.execute({ id: randomUUID(), type: 'identify_device', args: { pattern: 'blink', count: 3, intervalMs: 300 }, expiresAt: Date.now() - 1 }, true).catch(() => {});
    assert.equal(sim.identifyCount, 2, 'Expired request cannot execute');
    sim.hello(); await sim.until(() => !!sim.sessionId);
  });
  await t.test('identify rejects incomplete success reports and exposes expired requests', async () => {
    sim.send({ type: 'goodbye' }); await until(view, d => !d.connectivity.controlReachable, 'closed control');
    const pending = await req(`/devices/${a.id}/identify`, 'POST');
    await assert.rejects(sim.request('/api/zckj/deviceCommands/ack', { deviceId: a.mac, id: pending.id, status: 'ok', result: {} }), /定位执行结果无效/);
    assert.equal((await view()).identifyCommand.status, 'pending');
    await source.getRepository(DeviceCommandEntity).update(pending.id, { expiresAt: new Date(Date.now() - 1) });
    await sim.pollOnce(); assert.equal((await view()).identifyCommand.status, 'expired');
    const retried = await req(`/devices/${a.id}/identify`, 'POST'); assert.notEqual(retried.id, pending.id);
    await sim.pollOnce(); assert.equal((await view()).identifyCommand.status, 'succeeded');
    sim.hello(); await sim.until(() => !!sim.sessionId);
  });
  const reminderRepo = source.getRepository(ReminderEntity), integration = app.get(DeviceIntegrationService);
  const reminder = (repeat = 'none') => req('/reminders', 'POST', { deviceId: a.id, title: 'water reminder', repeat, scheduledAt: new Date(Date.now() + 60000).toISOString() });
  const due = async (id, when = new Date(Date.now() - 50)) => { await reminderRepo.update(id, { scheduledAt: when }); await integration.triggerCloudReminder(id, a.id); };
  const reminderView = async id => (await req(`/reminders?deviceId=${a.id}`)).find(r => r.id === id);
  await t.test('cloud reminder schedules atomically once and reports device playback completion', async () => {
    const r = await reminder(); const at = new Date(Date.now() - 50); await reminderRepo.update(r.id, { scheduledAt: at });
    await Promise.all([integration.triggerCloudReminder(r.id, a.id), integration.triggerCloudReminder(r.id, a.id)]);
    await until(() => reminderView(r.id), r => r.execution?.status === 'succeeded', 'reminder complete');
    const row = await reminderView(r.id); assert.equal(row.enabled, false); assert.equal(row.execution.occurrenceAt, at.toISOString());
    const commands = await source.getRepository(DeviceCommandEntity).findBy({ deviceId: a.id, type: 'speak_text' });
    assert.equal(commands.filter(c => c.payload.reminderId === r.id).length, 1); assert.equal(sim.results.at(-1).text, '提醒一下，water reminder');
    await req(`/reminders/${r.id}`, 'DELETE');
  });
  await t.test('offline and stale daily reminders are consumed without replay and preserve daily wall time', async () => {
    await sim.stop(); const before = sim.results.length;
    const once = await reminder(); await due(once.id); assert.match((await reminderView(once.id)).execution.message, /未连接/);
    const daily = await reminder('daily'), old = new Date(Date.now() - 2 * 86400000 - 60000); await due(daily.id, old);
    const row = await reminderView(daily.id); assert.equal(row.enabled, true); assert.match(row.execution.message, /过期/);
    assert.ok(new Date(row.scheduledAt).getTime() > Date.now()); assert.equal((new Date(row.scheduledAt).getTime() - old.getTime()) % 86400000, 0);
    await sim.start(); await sleep(350); assert.equal(sim.results.length, before);
    await req(`/reminders/${once.id}`, 'DELETE'); await req(`/reminders/${daily.id}`, 'DELETE');
  });
  await t.test('editing, pausing and deleting cancel only linked reminder playback', async () => {
    const r = await reminder(); await req(`/reminders/${r.id}`, 'PATCH', { title: 'edited', repeat: 'daily', enabled: false });
    await due(r.id); assert.equal((await reminderView(r.id)).execution, null);
    await req(`/reminders/${r.id}`, 'PATCH', { enabled: true, scheduledAt: new Date(Date.now() + 60000).toISOString() });
    const tts = app.get(TtsService), normal = tts.synthesize; tts.synthesize = async () => ({ audio: wave(24000, 1.2) });
    await due(r.id); await until(() => reminderView(r.id), r => r.execution?.phase === 'playing', 'reminder playing');
    const commandId = (await reminderView(r.id)).execution.commandId;
    await req(`/reminders/${r.id}`, 'PATCH', { enabled: false }); await sleep(300);
    assert.equal((await source.getRepository(DeviceCommandEntity).findOneBy({ id: commandId })).status, 'cancelled');
    await req(`/reminders/${r.id}`, 'DELETE'); assert.equal(await reminderView(r.id), undefined);
    const deleted = await reminder(); await due(deleted.id); await until(() => reminderView(deleted.id), r => r.execution?.phase === 'playing', 'delete while playing');
    const deletedCommand = (await reminderView(deleted.id)).execution.commandId;
    await req(`/reminders/${deleted.id}`, 'DELETE'); await sleep(250);
    assert.equal((await source.getRepository(DeviceCommandEntity).findOneBy({ id: deletedCommand })).status, 'cancelled');
    tts.synthesize = normal;
    await assert.rejects(req('/reminders', 'POST', { deviceId: a.id, title: 'invalid', scheduledAt: new Date(Date.now() - 1000).toISOString() }), /400/);
    await assert.rejects(req('/reminders', 'POST', { deviceId: a.id, title: 'alarm', kind: 'alarm', scheduledAt: new Date(Date.now() + 60000).toISOString() }), /400/);
  });
  await t.test('busy reminder cannot reuse or stack an existing APP speech command', async () => {
    sim.ack = 'none'; await req(`/devices/${a.id}/speak`, 'POST', { text: 'busy speech' });
    await until(view, d => d.speechCommand?.phase === 'awaiting_completion', 'busy waiting receipt');
    const r = await reminder(); await due(r.id); assert.match((await reminderView(r.id)).execution.message, /已有播报/);
    await req(`/reminders/${r.id}`, 'DELETE'); assert.equal((await view()).speechCommand.status, 'dispatched', 'Deleting skipped reminder must not stop unrelated APP speech');
    await req(`/devices/${a.id}/playback/stop`, 'POST'); sim.ack = 'event';
  });
  await t.test('changed ownership disables daily reminder and cannot create a speech task', async () => {
    const r = await reminder('daily'); await reminderRepo.update(r.id, { userId: 'old-owner', scheduledAt: new Date(Date.now() - 50) });
    await integration.triggerCloudReminder(r.id, a.id); const row = await reminderRepo.findOneBy({ id: r.id });
    assert.equal(row.enabled, false); assert.equal(row.lastCommandId, null); assert.match(row.lastRunReason, /归属/);
    await reminderRepo.delete(r.id);
  });
  const uid = '04A1B2C3D4E5F6', secondUid = '01020304';
  await source.getRepository(CharacterEntity).save({ id: 'mqtt-nfc-role', name: 'NFC role', description: 'test', accentColor: '#123456', voiceId: 'nfc-test-voice', ttsModel: 'test', greeting: 'hi', prompt: 'test' });
  async function reconnectNfc() { await until(() => sim.sessionId, id => !id, 'NFC revokes old session'); sim.hello(); await sim.until(() => !!sim.sessionId); }
  await t.test('NFC unknown UID is normalized and account binding updates present tag', async () => {
    await sim.placeNfc(uid); await until(view, d => d.nfcState?.uid === uid, 'unknown NFC'); assert.equal((await view()).nfcState.matched, false);
    assert.equal((await view()).characterId, 'mqtt-role');
    await req(`/devices/${a.id}/nfc-bindings`, 'PUT', { uid: '04:a1:b2:c3:d4:e5:f6', characterId: 'mqtt-role' });
    assert.equal((await view()).nfcState.matched, true); assert.equal((await req(`/devices/${a.id}/nfc-bindings`))[0].uid, uid);
    await assert.rejects(req(`/devices/${a.id}/nfc-bindings`, 'PUT', { uid, characterId: 'mqtt-nfc-role' }), /409/);
  });
  await t.test('NFC switch cancels old speech and uses new voice after reconnect snapshot', async () => {
    await req(`/devices/${a.id}/nfc-bindings`, 'PUT', { uid: secondUid, characterId: 'mqtt-nfc-role' });
    const tts = app.get(TtsService), normal = tts.synthesize; tts.synthesize = async () => ({ audio: wave(24000, 1.2) });
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'old NFC voice' }); await until(view, d => d.speechCommand?.phase === 'playing', 'old speech playing');
    await sim.placeNfc(secondUid); await until(view, d => d.characterId === 'mqtt-nfc-role' && d.speechCommand?.status === 'cancelled', 'NFC changes role');
    await reconnectNfc(); await until(view, d => d.nfcState?.uid === secondUid && d.connectivity.controlReachable, 'snapshot restores state');
    let voice; tts.synthesize = async (_text, voiceId) => { voice = voiceId; return { audio: wave(24000) }; };
    await req(`/devices/${a.id}/speak`, 'POST', { text: 'new NFC voice' }); await until(view, d => d.speechCommand?.status === 'succeeded', 'new voice completes');
    assert.equal(voice, 'nfc-test-voice'); tts.synthesize = normal;
  });
  await t.test('NFC duplicate IDs, stale sequence/time/session and old tag removal cannot overwrite state', async () => {
    const event = sim.reportNfc(); await until(() => sim.nfcAcks || [], xs => xs.some(x => x.eventId === event.eventId), 'event ACK');
    sim.send({ type: 'custom', payload: event }); await until(() => sim.nfcAcks || [], xs => xs.some(x => x.eventId === event.eventId && x.payload.duplicate), 'duplicate ACK');
    assert.equal(await source.getRepository(DeviceEventEntity).countBy({ deviceId: a.id, externalEventId: event.eventId }), 1);
    const http = { deviceId: a.mac, session_id: sim.sessionId, eventId: randomUUID(), type: 'nfc_tag_present', payload: { uid, sequence: 1, ts: Date.now() } };
    await assert.rejects(sim.request('/api/zckj/deviceEventReport', http), /序号已过期/);
    await assert.rejects(sim.request('/api/zckj/deviceEventReport', { ...http, eventId: randomUUID(), payload: { ...http.payload, sequence: 99, ts: Date.now() - 60000 } }), /时间无效/);
    await assert.rejects(sim.request('/api/zckj/deviceEventReport', { ...http, session_id: 'old-session' }), /会话或事件无效/);
    sim.reportNfc('nfc_tag_removed', randomUUID(), { uid }); await sleep(80); assert.equal((await view()).nfcState.uid, secondUid);
    await sim.placeNfc(null); await until(view, d => d.nfcState?.present === false, 'tag removed'); await reconnectNfc();
    assert.equal((await view()).characterId, 'mqtt-nfc-role');
  });
  await t.test('another account mapping is invisible and simulator endpoints reject non-simulator devices', async () => {
    const repo = source.getRepository(NfcBindingEntity); const foreign = await repo.save({ userId: 'other-user', uid: 'AABBCCDD', characterId: 'mqtt-role' });
    await sim.placeNfc('AABBCCDD'); await until(view, d => d.nfcState?.uid === 'AABBCCDD', 'foreign UID');
    assert.equal((await view()).nfcState.matched, false); assert.equal((await view()).characterId, 'mqtt-nfc-role');
    assert.ok(!(await req(`/devices/${a.id}/nfc-bindings`)).some(b => b.uid === 'AABBCCDD'));
    await assert.rejects(req(`/devices/${b.id}/nfc-bindings`), /404/);
    await assert.rejects(req(`/devices/${a.id}/simulator/nfc`, 'POST', { present: true, uid }), /仅支持本地/);
    await repo.remove(foreign); await sim.placeNfc(null); await until(view, d => !d.nfcState?.present, 'foreign removed'); await reconnectNfc();
  });
  await t.test('Broker ACL denies another device topic and broker-presence forgery', async () => {
    await assert.rejects(sim.client.subscribeAsync(`shouban/r1m/v1/devices/${b.mac.replaceAll(':','')}/down`, { qos:1 }), /Subscribe error/);
    const result = await fetch(`${base}/v1/partner/r1m/broker/auth`, { method:'POST', headers:{'Content-Type':'application/json','X-Broker-Token':'wrong'}, body:JSON.stringify({}) }); assert.equal(result.status,401);
    const control = app.get(R1mControlService), connection = control.view(a.id); control.brokerPresence(a.id,'stale-generation',false); assert.equal(control.view(a.id).network,connection.network);
    sim.client.publish(`shouban/r1m/v1/broker/devices/${a.mac.replaceAll(':','')}/presence`,JSON.stringify({state:'online',connectionId:'forged'}),{qos:1});
    await until(view,d=>d.connectivity.network==='unknown','forged reserved publish disconnect');
  });
});
