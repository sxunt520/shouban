import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { projectRoot } from './local-environment.mjs';
export function ensureR1mFixtures(env) {
  if (!/_mqtt_dev$/.test(env.DB_DATABASE || '')) throw new Error('R1M fixtures require a development database');
  const path = resolve(projectRoot, '.data/r1m-devices.json');
  if (!existsSync(path)) {
    mkdirSync(resolve(projectRoot, '.data'), { recursive: true });
    writeFileSync(path, JSON.stringify([{ id: '33333333-3333-4333-8333-333333333333', hardwareId: 'R1M-WS-SIM', mac: '02:00:00:00:00:03', clientUuid: randomUUID(), name: 'R1M 4G/Wi-Fi 联调底座', bootstrapSecret: randomBytes(32).toString('base64url'), pairingCode: `R1M-${randomBytes(10).toString('hex').toUpperCase()}`, transport: 'websocket', httpPolling: true }], null, 2), { mode: 0o600 });
  }
  const devices = JSON.parse(readFileSync(path));
  if (!devices.some(f => f.hardwareId === 'R1M-MQTT-SIM')) {
    devices.push({ id: '44444444-4444-4444-8444-444444444444', hardwareId: 'R1M-MQTT-SIM', mac: '02:00:00:00:00:04', clientUuid: randomUUID(), name: 'R1M MQTT/UDP 联调底座', bootstrapSecret: randomBytes(32).toString('base64url'), pairingCode: `R1M-${randomBytes(10).toString('hex').toUpperCase()}`, transport: 'mqtt', httpPolling: true, serialNumber: 'DEV-R1M-0004', activationKeyHex: randomBytes(32).toString('hex') });
    writeFileSync(path, JSON.stringify(devices, null, 2), { mode: 0o600 });
  }
  const adminPath = resolve(projectRoot, '.data/r1m-broker-admin');
  if (!existsSync(adminPath)) writeFileSync(adminPath, randomBytes(32).toString('base64url'), { mode: 0o600 });
  env.R1M_BROKER_ADMIN_TOKEN = readFileSync(adminPath, 'utf8'); env.R1M_MQTT_PROPOSAL_ENABLED = 'true';
  env.R1M_DEV_ENABLED = 'true'; env.R1M_FIXTURES_PATH = path;
  env.R1M_WS_PUBLIC_URL = `ws://127.0.0.1:${env.PORT || 3000}/v1/partner/r1m/voice`;
}
