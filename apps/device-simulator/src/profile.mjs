import { readFileSync } from 'node:fs';

export function fixtures(env = process.env) {
  return JSON.parse(readFileSync(env.PARTNER_MQTT_FIXTURES_PATH || new URL('../../../config/mqtt-devices.json', import.meta.url), 'utf8'));
}
export function prefix(env = process.env) {
  const value = (env.PARTNER_MQTT_TOPIC_PREFIX || 'shouban/dev/v1').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9_/-]+$/.test(value)) throw new Error('Invalid MQTT topic prefix');
  return value;
}
export function topics(device, env = process.env) {
  const base = `${prefix(env)}/devices/${device.externalDeviceId}`;
  return { up: `${base}/up`, down: `${base}/down` };
}
