import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DeviceCommandEntity, DeviceEntity } from '../figure-companion/entities';

// This profile is our development extension, not a claim about vendor firmware.
export const PARTNER_SIM_PROFILE = 'partner-mqtt-sim-v1';
export const MQTT_ACTIVE_STATUSES = ['pending', 'dispatched'] as const;
export type CommandStatus = 'pending' | 'dispatched' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export interface DeviceCapabilities {
  setVolume: boolean;
  conversation: boolean;
  nfc: boolean;
  offlineAlarms: boolean;
}
export interface DeviceAdapter {
  readonly profile: string;
  supports(type: DeviceCommandEntity['type']): boolean;
  send(device: DeviceEntity, command: DeviceCommandEntity): Promise<void>;
}
export interface LocalFixture {
  key: string; id: string; hardwareId: string; externalDeviceId: string;
  mac: string; clientId: string; name: string; pairingCode: string;
  initialVolume: number; username: string; password: string;
  autoBind?: boolean; clientUuid?: string; bootstrapSecret?: string;
}
export function localFixtures(): LocalFixture[] {
  const relative = 'config/mqtt-devices.json';
  const path = process.env.PARTNER_MQTT_FIXTURES_PATH ||
    (existsSync(resolve(process.cwd(), relative)) ? resolve(process.cwd(), relative) : resolve(process.cwd(), '../../', relative));
  return JSON.parse(readFileSync(path, 'utf8')) as LocalFixture[];
}
export function positiveSetting(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 100 || n > 86_400_000) throw new Error(`${name} must be 100..86400000 milliseconds`);
  return n;
}
export function topicPrefix(): string {
  const prefix = (process.env.PARTNER_MQTT_TOPIC_PREFIX || 'shouban/dev/v1').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9_/-]+$/.test(prefix)) throw new Error('Invalid PARTNER_MQTT_TOPIC_PREFIX');
  return prefix;
}
