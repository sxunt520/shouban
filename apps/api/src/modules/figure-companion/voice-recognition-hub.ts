import { Injectable } from '@nestjs/common';

export type VoiceRecognitionEvent =
  | { type: 'voice.listening'; deviceId: string }
  | {
      type: 'voice.transcript.partial' | 'voice.transcript.sentence';
      deviceId: string;
      text: string;
      elapsedMs: number;
    }
  | {
      type: 'voice.transcript.final';
      deviceId: string;
      text: string;
      durationMs: number;
      firstPartialMs: number | null;
      asrMode: 'realtime' | 'batch_fallback';
    }
  | { type: 'voice.error'; deviceId: string; message: string };

type Listener = (event: VoiceRecognitionEvent) => void;

@Injectable()
export class VoiceRecognitionHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(deviceId: string, listener: Listener) {
    const deviceListeners = this.listeners.get(deviceId) ?? new Set<Listener>();
    deviceListeners.add(listener);
    this.listeners.set(deviceId, deviceListeners);
    return () => {
      deviceListeners.delete(listener);
      if (deviceListeners.size === 0) this.listeners.delete(deviceId);
    };
  }

  publish(event: VoiceRecognitionEvent) {
    for (const listener of this.listeners.get(event.deviceId) ?? []) {
      listener(event);
    }
  }
}
