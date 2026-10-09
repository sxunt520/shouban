import { connect } from 'mqtt';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { topics } from './profile.mjs';

export class DeviceSimulator {
  constructor(fixture, { env = process.env, stateDirectory = resolve('.data/mqtt-simulator'), mode = 'success', delayMs = 300, dropAcks = 0, duplicateAcks = false, log = console.log } = {}) {
    this.fixture = fixture; this.env = env; this.mode = mode; this.delayMs = delayMs;
    this.dropAcks = dropAcks; this.duplicateAcks = duplicateAcks; this.log = log;
    this.statePath = resolve(stateDirectory, `${fixture.key}.json`);
    this.stateDirectory = stateDirectory;
    this.state = { volume: fixture.initialVolume, revision: 0, executionCount: 0, receipts: {} };
    this.sequence = 0; this.chain = Promise.resolve();
    this.topic = topics(fixture, env);
  }

  async start() {
    if (this.client) throw new Error('Simulator is already running');
    await mkdir(this.stateDirectory, { recursive: true });
    try { this.state = JSON.parse(await readFile(this.statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.env.PARTNER_BOOTSTRAP_URL) {
      const response = await fetch(this.env.PARTNER_BOOTSTRAP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Device-Id': this.fixture.mac, 'Client-Id': this.fixture.clientUuid || this.fixture.clientId, Authorization: `Bearer ${this.fixture.bootstrapSecret || this.fixture.password}` }, body: JSON.stringify({ version: 2, mac_address: this.fixture.mac, uuid: this.fixture.clientUuid || this.fixture.clientId, application: { name: 'mqtt-simulator', version: '0.2.0' } }) });
      if (!response.ok) throw new Error(`Bootstrap rejected (${response.status})`);
      const config = await response.json();
      if (config.profile !== 'partner-mqtt-sim-v1' || !config.mqtt?.subscribe_topic) throw new Error('Unsupported bootstrap profile');
      this.env = { ...this.env, PARTNER_MQTT_URL: `${config.reference_transport === 'tls' ? 'mqtts' : 'mqtt'}://${config.mqtt.endpoint}` };
      this.fixture = { ...this.fixture, clientId: config.mqtt.client_id, username: config.mqtt.username, password: config.mqtt.password };
      this.topic = { up: config.mqtt.publish_topic, down: config.mqtt.subscribe_topic };
    }
    this.connectionId = randomUUID(); this.sequence = 0;
    this.client = connect(this.env.PARTNER_MQTT_URL || 'mqtt://127.0.0.1:18883', {
      clientId: this.fixture.clientId, username: this.fixture.username, password: this.fixture.password,
      protocolVersion: 4, clean: true, reconnectPeriod: 1000, connectTimeout: 5000, keepalive: 10,
      queueQoSZero: false, resubscribe: false,
      will: { topic: this.topic.up, payload: JSON.stringify({ type: 'presence', state: 'offline', connectionId: this.connectionId, eventId: `will-${this.connectionId}` }), qos: 1, retain: true },
    });
    this.client.on('error', error => this.log(`[${this.fixture.key}] connection error: ${error.message}`));
    this.client.on('message', (_topic, bytes) => {
      this.chain = this.chain.then(async () => {
        try { await this.handle(JSON.parse(bytes.toString())); }
        catch (error) { this.log(`[${this.fixture.key}] rejected message: ${error.message}`); }
      });
    });
    this.client.on('connect', () => {
      this.client.subscribe(this.topic.down, { qos: 1 }, async (error, grants) => {
        if (error || grants?.some(g => Number(g.qos) === 128)) return;
        try { await this.reportStatus(); this.log(`[${this.fixture.key}] online, volume=${this.state.volume}, revision=${this.state.revision}`); }
        catch (caught) { this.log(`[${this.fixture.key}] status failed: ${caught.message}`); }
      });
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('Simulator MQTT connect timeout')), 6000);
      this.client.once('connect', () => { clearTimeout(timer); resolvePromise(); });
      this.client.once('error', error => { clearTimeout(timer); reject(error); });
    });
    this.timer = setInterval(() => { if (this.client?.connected) void this.reportStatus().catch(() => {}); }, 5000);
    return this;
  }

  message(type, data = {}) {
    return { ...data, type, eventId: randomUUID(), connectionId: this.connectionId, sequence: ++this.sequence, ts: Date.now() };
  }
  async publish(message, retained = false) {
    if (!this.client?.connected) return;
    await this.client.publishAsync(this.topic.up, JSON.stringify(message), { qos: 1, retain: retained });
  }
  async reportStatus() {
    await this.publish(this.message('status', { volume: this.state.volume, revision: this.state.revision }));
  }
  async persist() {
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2));
    await rename(temp, this.statePath);
  }

  async receipt(id, value) {
    if (this.dropAcks > 0) { this.dropAcks -= 1; this.log(`[${this.fixture.key}] injected lost receipt ${id}`); return; }
    const message = this.message('cmd_ack', { commandId: id, ...value });
    await this.publish(message);
    if (this.duplicateAcks) await this.publish(message);
  }

  async handle(message) {
    if (this.voice && await this.voice.handle(message)) return;
    if (message.type === 'status.request') { await this.reportStatus(); return; }
    if (message.type !== 'custom') return;
    const command = message.payload;
    if (!command || typeof command.id !== 'string' || command.id.length > 80) return;
    const id = command.id;
    if (this.state.receipts[id]) {
      await this.receipt(id, this.state.receipts[id]); await this.reportStatus(); return;
    }
    if (this.mode === 'timeout') { this.log(`[${this.fixture.key}] injected no response ${id}`); return; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, this.delayMs));
    const args = command.args;
    let error = null;
    if (command.cmd !== 'set_volume' || !args || !Number.isInteger(args.value) || args.value < 0 || args.value > 100 || !Number.isSafeInteger(args.revision) || args.revision < 1) error = 'invalid_command';
    else if (!Number.isFinite(command.expiresAt) || command.expiresAt <= Date.now()) error = 'command_expired';
    else if (args.revision <= this.state.revision) error = 'superseded_revision';
    else if (this.mode === 'reject') error = '模拟设备拒绝调节音量';
    if (!error) {
      this.state.volume = args.value; this.state.revision = args.revision; this.state.executionCount += 1;
    }
    const receipt = {
      status: error ? 'error' : 'ok', ...(error ? { error } : {}),
      result: { volume: this.state.volume, revision: this.state.revision, executionCount: this.state.executionCount },
    };
    this.state.receipts[id] = receipt;
    const keys = Object.keys(this.state.receipts);
    if (keys.length > 256) delete this.state.receipts[keys[0]];
    await this.persist();
    this.log(`[${this.fixture.key}] ${error || 'executed'} ${id}, volume=${this.state.volume}, executions=${this.state.executionCount}`);
    await this.receipt(id, receipt);
    await this.reportStatus();
  }

  async stop({ abrupt = false } = {}) {
    if (this.timer) clearInterval(this.timer);
    if (this.voice) await this.voice.stop();
    const client = this.client;
    if (!client) return;
    client.options.reconnectPeriod = 0;
    if (abrupt) client.stream.destroy();
    else if (client.connected) await this.publish(this.message('presence', { state: 'offline' }), true);
    await client.endAsync(abrupt);
    await this.chain;
    this.client = null;
  }
}
