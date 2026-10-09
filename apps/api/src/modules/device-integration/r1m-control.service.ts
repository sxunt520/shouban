import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DeviceCommandEntity, DeviceEntity } from '../figure-companion/entities';

export const R1M_PROFILE = 'r1m-v1';
export function r1mCommandArgs(command: DeviceCommandEntity) {
  return command.type === 'set_volume' ? { value: command.payload.volume, revision: command.revision } : command.payload;
}
export interface R1mConnection {
  id: string;
  sessionId?: string;
  send: (message: Record<string, unknown>) => void;
  close: () => void;
  voiceActive: boolean;
  play?: (command: DeviceCommandEntity) => void;
  stopPlayback?: (commandId?: string) => void;
}
/** Authenticated control reachability, deliberately independent of HTTP telemetry and MQTT's cloud connection. */
@Injectable()
export class R1mControlService implements OnModuleDestroy {
  private connections = new Map<string, R1mConnection>();
  private broker = new Map<string, { connectionId: string; connected: boolean }>();
  clearBroker(id: string) { this.broker.delete(id); }
  brokerPresence(id: string, connectionId: string, connected: boolean) {
    const previous = this.broker.get(id);
    if (!connected && previous?.connectionId !== connectionId) return;
    this.broker.set(id, { connectionId, connected }); this.observe(id);
    if (!connected) this.revoke(id);
  }
  resetBroker() { for (const id of this.broker.keys()) this.revoke(id); this.broker.clear(); }
  private observations = new Map<string, number>();
  private ack?: (deviceId: string, payload: Record<string, unknown>) => Promise<unknown>;
  onAck(listener: NonNullable<R1mControlService['ack']>) { this.ack = listener; }
  acknowledge(deviceId: string, payload: Record<string, unknown>) { return this.ack?.(deviceId, payload); }
  private event?: (id: string, event: Record<string, unknown>, session: string) => Promise<unknown>;
  onDeviceEvent(handler: NonNullable<R1mControlService['event']>) { this.event = handler; }
  receiveDeviceEvent(id: string, event: Record<string, unknown>, session: string) { return this.event?.(id, event, session); }
  connection(id: string) { return this.connections.get(id); }
  attach(deviceId: string, send: R1mConnection['send'], close: R1mConnection['close'], sessionId?: string) {
    this.revoke(deviceId);
    const connection = { id: randomUUID(), sessionId, send, close, voiceActive: false };
    this.connections.set(deviceId, connection); this.observations.set(deviceId, Date.now());
    return connection;
  }
  detach(deviceId: string, connection: R1mConnection) {
    if (this.connections.get(deviceId) === connection) this.connections.delete(deviceId);
  }
  current(deviceId: string, connection: R1mConnection) { return this.connections.get(deviceId) === connection; }
  ready(deviceId: string) { return this.connections.has(deviceId); }
  observe(deviceId: string) { this.observations.set(deviceId, Date.now()); }
  view(deviceId: string) {
    const connection = this.connections.get(deviceId);
    return { network: connection || this.broker.get(deviceId)?.connected ? 'online' as const : 'unknown' as const, controlReachable: !!connection,
      voiceActive: connection?.voiceActive ?? false, lastEvidenceAt: this.observations.has(deviceId) ? new Date(this.observations.get(deviceId)!).toISOString() : null };
  }
  revoke(deviceId: string) {
    const old = this.connections.get(deviceId); this.connections.delete(deviceId); old?.close();
  }
  async send(device: DeviceEntity, command: DeviceCommandEntity) {
    const connection = this.connections.get(device.id);
    if (!connection) throw new Error('R1M control channel is closed');
    if (command.type === 'speak_text') { if (!connection.play) throw new Error('Playback handler unavailable'); connection.play(command); return; }
    connection.send({ type: 'custom', payload: { cmd: command.type, id: command.id,
      args: r1mCommandArgs(command), expiresAt: command.expiresAt?.getTime() } });
  }
  stopPlayback(deviceId: string, commandId?: string) { this.connections.get(deviceId)?.stopPlayback?.(commandId); }
  onModuleDestroy() { for (const id of this.connections.keys()) this.revoke(id); }
}
