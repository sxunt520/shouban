import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { projectRoot } from './local-environment.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const mac = args.mac?.toLowerCase();
const host = args.host;
if (!mac || !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac) || !host || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new Error('Use --mac=aa:bb:cc:dd:ee:ff --host=<computer LAN IPv4>');
mkdirSync(resolve(projectRoot, '.data'), { recursive: true });
const registryPath = resolve(projectRoot, '.data/partner-reference.json');
const existing = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath)) : [];
let device = existing.find(d => d.mac === mac);
if (!device) {
  const externalDeviceId = mac.replaceAll(':', '');
  device = { key: 'reference', id: randomUUID(), hardwareId: `REF-${externalDeviceId.toUpperCase()}`, externalDeviceId, mac,
    clientId: `shouban-ref-${externalDeviceId}`, clientUuid: randomUUID(), name: '实体参考底座', pairingCode: `REF-${randomBytes(6).toString('hex').toUpperCase()}`,
    initialVolume: 60, username: `ref-${externalDeviceId}`, password: randomBytes(24).toString('hex'), bootstrapSecret: randomBytes(32).toString('hex'), autoBind: false };
}
const base = JSON.parse(readFileSync(resolve(projectRoot, 'config/mqtt-devices.json')));
writeFileSync(registryPath, JSON.stringify([...base, device], null, 2), { mode: 0o600 });
const envPath = resolve(projectRoot, '.env.mqtt.local');
const env = dotenv.parse(readFileSync(existsSync(envPath) ? envPath : resolve(projectRoot, 'config/mqtt-local.env.example')));
Object.assign(env, { PARTNER_MQTT_FIXTURES_PATH: registryPath, PARTNER_MQTT_URL: `mqtt://${host}:18883`, PARTNER_MQTT_DEVICE_URL: `mqtt://${host}:18883`, LOCAL_MQTT_HOST: host, MQTT_REFERENCE_LAN_ENABLED: 'true' });
writeFileSync(envPath, Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n')+'\n', { mode: 0o600 });
const header = `#define REFERENCE_BOOTSTRAP_URL ${JSON.stringify(`http://${host}:3000/v1/partner/ota/`)}\n#define REFERENCE_BOOTSTRAP_SECRET ${JSON.stringify(device.bootstrapSecret)}\n#define REFERENCE_CLIENT_UUID ${JSON.stringify(device.clientUuid)}\n`;
writeFileSync(resolve(projectRoot, 'firmware/partner-reference/main/reference_config.h'), header, { mode: 0o600 });
console.log(`Reference prepared: ZAOC_${device.externalDeviceId.slice(-6).toUpperCase()}, claim code ${device.pairingCode}`);
console.log('Private credentials remain in ignored local files. BLE carries only ssid/password; the bootstrap URL is compiled in.');
