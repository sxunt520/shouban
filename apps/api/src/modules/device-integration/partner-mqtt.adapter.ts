import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { connect, MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import { DeviceCommandEntity, DeviceEntity } from '../figure-companion/entities';
import { DeviceAdapter, PARTNER_SIM_PROFILE, topicPrefix } from './partner-profile';

export interface PartnerInbound {
  externalDeviceId: string;
  retained: boolean;
  payload: Record<string, unknown>;
}

@Injectable()
export class PartnerMqttAdapter implements DeviceAdapter, OnModuleInit, OnModuleDestroy {
  readonly profile = PARTNER_SIM_PROFILE;
  private readonly logger = new Logger(PartnerMqttAdapter.name);
  private client?: MqttClient;
  private receiver?: (event: PartnerInbound) => Promise<void>;
  private voiceReset?: () => void;
  private voiceReceiver?: (event: PartnerInbound) => Promise<void>;
  private reconnectReceiver?: () => Promise<void>;
  private messageChain = Promise.resolve();
  private subscribed = false;
  get ready() { return this.client?.connected === true && this.subscribed; }
  supports(type: DeviceCommandEntity['type']) { return type === 'set_volume'; }

  receiveWith(receiver: (event: PartnerInbound) => Promise<void>, reconnect: () => Promise<void>) {
    this.receiver = receiver;
    this.reconnectReceiver = reconnect;
  }

  receiveVoiceWith(receiver: (event: PartnerInbound) => Promise<void>, reset: () => void) { this.voiceReceiver = receiver; this.voiceReset = reset; }

  async sendControl(device: DeviceEntity, payload: Record<string, unknown>) { await this.publish(device, payload); }

  onModuleInit() {
    if (process.env.PARTNER_MQTT_ENABLED !== 'true') return;
    const url = process.env.PARTNER_MQTT_URL;
    if (!url || !/^mqtts?:\/\//.test(url)) throw new Error('PARTNER_MQTT_URL must be mqtt:// or mqtts://');
    this.client = connect(url, {
      clientId: `figure-cloud-${randomUUID()}`, protocolVersion: 4,
      username: process.env.PARTNER_MQTT_USERNAME,
      password: process.env.PARTNER_MQTT_PASSWORD,
      clean: true, reconnectPeriod: 1000, connectTimeout: 5000,
      queueQoSZero: false, resubscribe: false,
    });
    this.client.on('connect', () => {
      this.client!.subscribe(`${topicPrefix()}/devices/+/up`, { qos: 1 }, (error, grants) => {
        if (error || grants?.some(g => Number(g.qos) === 128)) {
          this.logger.warn('MQTT subscription rejected'); return;
        }
        this.subscribed = true;
        this.logger.log('Development MQTT profile subscribed');
        this.enqueue(async () => { await this.reconnectReceiver?.(); });
      });
    });
    this.client.on('close', () => {
      this.subscribed = false;
      this.voiceReset?.();
      this.enqueue(async () => { await this.reconnectReceiver?.(); });
    });
    this.client.on('error', error => this.logger.warn(`MQTT connection: ${error.message}`));
    this.client.on('message', (topic, bytes, packet) => {
      const base = `${topicPrefix()}/devices/`;
      if (!topic.startsWith(base) || bytes.length > 8192) return;
      const suffix = topic.slice(base.length);
      if (!/^[a-f0-9]{12}\/up$/.test(suffix)) return;
      try {
        const payload: unknown = JSON.parse(bytes.toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const event = { externalDeviceId: suffix.split('/')[0], retained: packet.retain, payload: payload as Record<string, unknown> };
        this.enqueue(async () => { await this.receiver?.(event);
          if (['hello', 'listen', 'abort', 'goodbye', 'presence'].includes(String(event.payload.type))) await this.voiceReceiver?.(event); });
      } catch { this.logger.warn('Discarded invalid MQTT JSON'); }
    });
  }

  private enqueue(action: () => Promise<void>) {
    this.messageChain = this.messageChain.then(action).catch(error => {
      this.logger.warn(`MQTT event rejected: ${error instanceof Error ? error.message : 'invalid event'}`);
    });
  }

  private async publish(device: DeviceEntity, payload: Record<string, unknown>) {
    if (!this.ready || !device.externalDeviceId) throw new Error('MQTT transport is unavailable');
    // QoS delivery confirmation only. Execution is completed by a separate ACK.
    await this.client!.publishAsync(`${topicPrefix()}/devices/${device.externalDeviceId}/down`, JSON.stringify(payload), { qos: 1, retain: false });
  }

  async requestStatus(device: DeviceEntity) {
    await this.publish(device, { type: 'status.request', requestId: randomUUID() });
  }

  async send(device: DeviceEntity, command: DeviceCommandEntity) {
    if (!this.supports(command.type)) throw new Error('Unsupported development command');
    await this.publish(device, {
      type: 'custom', payload: {
        cmd: 'set_volume', id: command.id,
        args: { value: command.payload.volume, revision: command.payload.revision },
        expiresAt: command.expiresAt?.getTime(),
      },
    });
  }

  async onModuleDestroy() {
    this.subscribed = false;
    if (this.client) await this.client.endAsync(true);
    await this.messageChain;
  }
}
