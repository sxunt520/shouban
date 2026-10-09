import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createLocalBroker } from '../src/broker.mjs';
import { DeviceSimulator } from '../src/device.mjs';
import { fixtures, topics } from '../src/profile.mjs';
import { localEnvironment, projectRoot } from '../../../scripts/local-environment.mjs';

const require = createRequire(import.meta.url);
const { databaseEntities, DeviceEntity, DeviceCommandEntity } = require(resolve(projectRoot, 'apps/api/dist/modules/figure-companion/entities.js'));
const { DeviceIntegration1791417600000 } = require(resolve(projectRoot, 'apps/api/dist/migrations/DeviceIntegration1791417600000.js'));

async function until(get, predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await get(); if (predicate(last)) return last; } catch (error) { last = error.message; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 80));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = server.address().port;
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise(resolvePromise => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  await exit; clearTimeout(timer);
}

test('MQTT phase-one end-to-end contract', { timeout: 90000 }, async t => {
  const env = localEnvironment();
  const database = `shouban_${randomUUID().replaceAll('-', '').slice(0, 10)}_mqtt_test`;
  const directory = await mkdtemp(resolve(tmpdir(), 'shouban-mqtt-'));
  const admin = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD });
  let broker, source, api;
  const simulators = [];
  let logs = '';
  t.after(async () => {
    if (process.env.MQTT_TEST_DEBUG === 'true') console.log(logs);
    await stopChild(api);
    await Promise.all(simulators.map(s => s.stop().catch(() => {})));
    if (broker) await broker.close();
    if (source?.isInitialized) await source.destroy();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end(); await rm(directory, { recursive: true, force: true });
  });
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  source = new DataSource({ type: 'mysql', host: env.DB_HOST, port: Number(env.DB_PORT), username: env.DB_USERNAME, password: env.DB_PASSWORD,
    database, entities: databaseEntities, synchronize: true, charset: 'utf8mb4', timezone: '+08:00' });
  await source.initialize();

  await t.test('additive migration preserves legacy rows and is repeatable', async () => {
    const id = randomUUID();
    await source.getRepository(DeviceEntity).save({ id, hardwareId: 'MIGRATION-LEGACY', deviceSecretHash: createHash('sha256').update('test-only').digest('hex'), pairingCode: 'MIGRATION-0001', name: 'Migration fixture', volume: 61 });
    const acknowledgedAt = new Date();
    const command = await source.getRepository(DeviceCommandEntity).save({ deviceId: id, type: 'set_volume', payload: { volume: 61 }, acknowledgedAt });
    const runner = source.createQueryRunner();
    try {
      for (const [table, names] of Object.entries({
        figure_devices: ['protocolProfile', 'externalDeviceId', 'clientUuid', 'capabilities', 'desiredVolume', 'controlRevision', 'reportedRevision', 'mqttOnline', 'mqttConnectionId', 'mqttSequence'],
        figure_device_commands: ['status', 'requestedByUserId', 'revision', 'expiresAt', 'lastDispatchedAt', 'completedAt', 'attempts', 'failureReason', 'result'],
        figure_device_events: ['externalEventId'],
      })) {
        // The legacy schema had no indexes involving these new columns.
        // Removing a column alone can leave a narrower, unintended unique index.
        const schema = await runner.getTable(table);
        for (const index of schema.indices) {
          if (index.columnNames.some((name) => names.includes(name))) await runner.dropIndex(table, index);
        }
        for (const name of names) await runner.dropColumn(table, name);
      }
      const migration = new DeviceIntegration1791417600000();
      await migration.up(runner); await migration.up(runner);
      const device = await source.getRepository(DeviceEntity).findOneByOrFail({ id });
      const restored = await source.getRepository(DeviceCommandEntity).findOneByOrFail({ id: command.id });
      assert.equal(device.volume, 61); assert.equal(device.protocolProfile, 'legacy');
      assert.equal(restored.status, 'succeeded'); assert.ok(restored.completedAt);
    } finally { await runner.release(); }
  });

  broker = await createLocalBroker({ env, port: 0, log: process.env.MQTT_TEST_DEBUG === 'true' ? console.log : () => {} });
  const port = await freePort();
  const testEnv = { ...env, PORT: String(port), DB_DATABASE: database, DB_SYNCHRONIZE: 'false',
    FIGURE_ENV_FILE: resolve(directory, 'no-secrets.env'), PARTNER_MQTT_FIXTURES_PATH: resolve(projectRoot, 'config/mqtt-devices.json'),
    PARTNER_MQTT_URL: `mqtt://127.0.0.1:${broker.port}`, PARTNER_MQTT_COMMAND_TIMEOUT_MS: '3000', PARTNER_MQTT_RETRY_MS: '300',
    PARTNER_MQTT_PRESENCE_TIMEOUT_MS: '15000' };
  const base = `http://127.0.0.1:${port}/v1`;
  let token;
  async function request(path, method = 'GET', body, auth = token) {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(2500),
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(`${response.status}: ${JSON.stringify(data)}`); error.status = response.status; throw error; }
    return data;
  }
  async function startApi() {
    api = spawn(process.execPath, [resolve(projectRoot, 'apps/api/dist/main.js')], { cwd: directory, env: testEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [api.stdout, api.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-16000); });
    try { await until(() => request('/health'), d => d.ok, 'API startup', 10000); }
    catch (error) { console.error(logs); throw error; }
  }
  await startApi();
  token = (await request('/auth/demo', 'POST', {})).accessToken;
  const [fixtureA, fixtureB] = fixtures(testEnv);
  const a = new DeviceSimulator(fixtureA, { env: testEnv, stateDirectory: directory, delayMs: 60, log: process.env.MQTT_TEST_DEBUG === 'true' ? console.log : () => {} });
  const b = new DeviceSimulator(fixtureB, { env: testEnv, stateDirectory: directory, delayMs: 60, log: process.env.MQTT_TEST_DEBUG === 'true' ? console.log : () => {} });
  simulators.push(a, b); await a.start(); await b.start();
  const device = key => request(`/devices/${key === 'a' ? fixtureA.id : fixtureB.id}`);
  const volume = (key, value) => request(`/devices/${key === 'a' ? fixtureA.id : fixtureB.id}/volume`, 'PATCH', { volume: value });
  const finished = (key, status) => until(() => device(key), d => d.volumeCommand?.status === status, `${key} ${status}`);
  await until(() => device('a'), d => d.status === 'online', 'A online');
  await until(() => device('b'), d => d.status === 'online', 'B online');

  await t.test('two devices stay isolated; accepted is not executed', async () => {
    const accepted = await volume('a', 70);
    assert.equal(accepted.volume, 60); assert.equal(accepted.desiredVolume, 70); assert.equal(accepted.volumeCommand.status, 'pending');
    const result = await finished('a', 'succeeded');
    assert.equal(result.volume, 70); assert.equal((await device('b')).volume, 40); assert.equal(a.state.executionCount, 1);
  });
  assert.equal(a.state.executionCount, 1, 'Stop dependent scenarios after failed initial execution');
  await t.test('rejection preserves the reported volume', async () => {
    a.mode = 'reject'; await volume('a', 80);
    const result = await finished('a', 'failed');
    assert.equal(result.volume, 70); assert.match(result.volumeCommand.errorMessage, /拒绝/); assert.equal(a.state.executionCount, 1);
  });
  await t.test('no response expires; retries do not invent success', async () => {
    a.mode = 'timeout'; const accepted = await volume('a', 90);
    const result = await finished('a', 'expired'); assert.equal(result.volume, 70);
    const command = await source.getRepository(DeviceCommandEntity).findOneByOrFail({ id: accepted.volumeCommand.id });
    assert.ok(command.attempts > 1); assert.equal(a.state.executionCount, 1);
  });
  await t.test('lost and duplicate receipts execute exactly once', async () => {
    a.mode = 'success'; a.dropAcks = 2; a.duplicateAcks = true;
    const accepted = await volume('a', 75); await finished('a', 'succeeded');
    assert.equal(a.state.executionCount, 2);
    const command = await source.getRepository(DeviceCommandEntity).findOneByOrFail({ id: accepted.volumeCommand.id });
    assert.ok(command.attempts >= 3);
    const events = await source.query("SELECT payload FROM figure_device_events WHERE deviceId=? AND type='mqtt_cmd_ack'", [fixtureA.id]);
    assert.equal(events.filter(row => JSON.parse(row.payload).commandId === command.id).length, 1);
    a.duplicateAcks = false;
  });
  await t.test('offline request is recovered after reconnect', async () => {
    await a.stop(); await until(() => device('a'), d => d.status === 'offline', 'A offline');
    await volume('a', 62); assert.equal((await device('a')).volumeCommand.status, 'pending');
    await a.start(); const result = await finished('a', 'succeeded'); assert.equal(result.volume, 62);
  });
  await t.test('expired offline commands are not replayed', async () => {
    await a.stop(); await until(() => device('a'), d => d.status === 'offline', 'A offline');
    const executions = a.state.executionCount; await volume('a', 63); await finished('a', 'expired');
    await a.start(); await until(() => device('a'), d => d.status === 'online', 'A online');
    assert.equal((await device('a')).volume, 62); assert.equal(a.state.executionCount, executions);
  });
  await t.test('API restart recovers a durable command and lost ACK', async () => {
    a.dropAcks = 999; const executions = a.state.executionCount;
    const accepted = await volume('a', 66);
    await until(async () => a.state.volume, value => value === 66, 'physical execution');
    await stopChild(api); a.dropAcks = 0; await startApi();
    const result = await finished('a', 'succeeded');
    assert.equal(result.volumeCommand.id, accepted.volumeCommand.id); assert.equal(a.state.executionCount, executions + 1);
  });
  await t.test('newer intention cancels previous commands; late ACK cannot overwrite', async () => {
    a.delayMs = 400; const first = await volume('a', 71);
    await until(() => device('a'), d => d.volumeCommand?.status === 'dispatched', 'first dispatch');
    const second = await volume('a', 72); await finished('a', 'succeeded');
    const original = await source.getRepository(DeviceCommandEntity).findOneByOrFail({ id: first.volumeCommand.id });
    assert.equal(original.status, 'cancelled');
    await a.publish(a.message('cmd_ack', { commandId: first.volumeCommand.id, status: 'ok', result: { volume: 71, revision: first.volumeCommand.revision } }));
    await a.publish(a.message('status', { volume: 71, revision: first.volumeCommand.revision }));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 350));
    const current = await device('a'); assert.equal(current.volume, 72); assert.equal(current.volumeCommand.id, second.volumeCommand.id);
    a.delayMs = 60;
  });
  await t.test('unexpected connection loss marks offline through the will', async () => {
    await a.stop({ abrupt: true }); await until(() => device('a'), d => d.status === 'offline', 'will offline'); await a.start();
    await until(() => device('a'), d => d.status === 'online', 'A reconnect');
  });
  await t.test('broker denies cross-device subscriptions; forged device ID cannot ACK B', async () => {
    await assert.rejects(a.client.subscribeAsync(topics(fixtureB, testEnv).down, { qos: 1 }), /Subscribe error/);
    b.mode = 'timeout'; const pending = await volume('b', 50);
    await a.publish(a.message('cmd_ack', { deviceId: fixtureB.id, commandId: pending.volumeCommand.id, status: 'ok', result: { volume: 50, revision: pending.volumeCommand.revision } }));
    const result = await finished('b', 'expired'); assert.equal(result.volume, 40); b.mode = 'success';
  });
  await t.test('HTTP authorization, validation, and unsupported capabilities', async () => {
    await assert.rejects(request(`/devices/${fixtureA.id}/volume`, 'PATCH', { volume: 20 }, null), e => e.status === 401);
    await assert.rejects(volume('a', 101), e => e.status === 400);
    await assert.rejects(request(`/devices/${fixtureA.id}/speak`, 'POST', { text: 'test' }), e => e.status === 400 && /尚未支持/.test(e.message));
    await assert.rejects(request(`/devices/${fixtureA.id}/listen`, 'POST', {}), e => e.status === 400);
  });
  await t.test('bootstrap authenticates identity and returns per-device MQTT routes', async () => {
    const bootstrap = async (authorization, bodyMac = fixtureA.mac, client = fixtureA.clientId) => fetch(`${base}/partner/ota/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Device-Id': fixtureA.mac, 'Client-Id': client, Authorization: authorization },
      body: JSON.stringify({ version: 2, mac_address: bodyMac, uuid: client, application: { version: '0.2.0' } }),
    });
    assert.equal((await bootstrap('Bearer wrong')).status, 401);
    assert.equal((await bootstrap(`Bearer ${fixtureA.password}`, fixtureB.mac)).status, 400);
    assert.equal((await bootstrap(`Bearer ${fixtureA.password}`, fixtureA.mac, 'wrong-client')).status, 401);
    const response = await bootstrap(`Bearer ${fixtureA.password}`); assert.equal(response.status, 200);
    const config = await response.json(); assert.equal(config.mqtt.publish_topic, topics(fixtureA, testEnv).up);
    assert.equal(config.mqtt.subscribe_topic, topics(fixtureA, testEnv).down); assert.ok(Math.abs(config.server_time.timestamp - Date.now()) < 2000);
  });
  await t.test('claim proof matches device; unlink cancels old work; reconnect can rebind', async () => {
    await assert.rejects(request('/devices/bind', 'POST', { pairingCode: fixtureA.pairingCode, externalDeviceId: fixtureB.externalDeviceId }), e => e.status === 400);
    a.mode = 'timeout'; const pending = await volume('a', 50);
    await request(`/devices/${fixtureA.id}/binding`, 'DELETE');
    const original = await source.getRepository(DeviceCommandEntity).findOneByOrFail({ id: pending.volumeCommand.id });
    assert.equal(original.status, 'cancelled');
    await assert.rejects(volume('a', 20), e => e.status === 404);
    const body = { pairingCode: fixtureA.pairingCode, externalDeviceId: fixtureA.externalDeviceId };
    assert.equal((await request('/devices/claim-status', 'POST', body)).claimedByMe, false);
    await source.getRepository(DeviceEntity).update(fixtureA.id, { ownerUserId: 'other-user' });
    await assert.rejects(request('/devices/bind', 'POST', body), e => e.status === 409);
    await source.getRepository(DeviceEntity).update(fixtureA.id, { ownerUserId: null });
    await request('/devices/bind', 'POST', body); a.mode = 'success';
    await volume('a', 74); assert.equal((await finished('a', 'succeeded')).volume, 74);
  });
  await t.test('legacy HTTP device still pulls and acknowledges volume', async () => {
    const bound = await request('/devices/bind', 'POST', { pairingCode: 'FIGURE-0001' });
    const accepted = await request(`/devices/${bound.id}/volume`, 'PATCH', { volume: 64 }); assert.equal(accepted.volume, 60);
    const session = await request('/device/session', 'POST', { hardwareId: 'ESP32S3-DEMO-001', deviceSecret: 'figure-dev-secret-001' });
    const pending = await request('/device/commands', 'GET', undefined, session.accessToken);
    assert.equal(pending[0].type, 'set_volume'); assert.equal(pending[0].payload.volume, 64);
    await request(`/device/commands/${pending[0].id}/ack`, 'POST', {}, session.accessToken);
    const reported = await request(`/devices/${bound.id}`); assert.equal(reported.volume, 64); assert.equal(reported.volumeCommand.status, 'succeeded');
  });
});
