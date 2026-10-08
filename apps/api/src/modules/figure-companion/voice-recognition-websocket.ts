import { INestApplication, Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { StoreService } from './store.service';
import { VoiceRecognitionHub } from './voice-recognition-hub';

interface SubscribeRequest {
  type: 'voice.subscribe';
  token: string;
  deviceId: string;
}

const VOICE_EVENTS_PATH = '/v1/devices/voice/events';

function isVoiceEventsUpgrade(request: IncomingMessage) {
  try {
    return (
      new URL(request.url ?? '/', 'http://localhost').pathname ===
      VOICE_EVENTS_PATH
    );
  } catch {
    return false;
  }
}

function readSubscribe(data: RawData): SubscribeRequest {
  const payload = JSON.parse(data.toString()) as Partial<SubscribeRequest>;
  if (
    payload.type !== 'voice.subscribe' ||
    typeof payload.token !== 'string' ||
    typeof payload.deviceId !== 'string'
  ) {
    throw new Error('实时识别订阅参数无效');
  }
  return payload as SubscribeRequest;
}

export function registerVoiceRecognitionWebSocket(app: INestApplication) {
  const logger = new Logger('VoiceRecognitionWebSocket');
  const store = app.get(StoreService);
  const hub = app.get(VoiceRecognitionHub);
  const server = app.getHttpServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on(
    'upgrade',
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!isVoiceEventsUpgrade(request)) return;
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    },
  );

  webSocketServer.on('connection', (socket) => {
    let subscribed = false;
    let unsubscribe: (() => void) | undefined;
    const authTimeout = setTimeout(() => {
      if (!subscribed && socket.readyState === WebSocket.OPEN) {
        socket.close(1008, 'subscription timeout');
      }
    }, 10_000);
    const emit = (event: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    };
    const cleanup = () => {
      clearTimeout(authTimeout);
      unsubscribe?.();
      unsubscribe = undefined;
    };
    socket.once('close', cleanup);
    socket.once('error', cleanup);
    socket.on('message', async (data) => {
      if (subscribed) return;
      try {
        const request = readSubscribe(data);
        const user = store.getUserForToken(request.token);
        if (!user) throw new Error('登录状态无效');
        await store.getDevice(user.id, request.deviceId);
        subscribed = true;
        clearTimeout(authTimeout);
        unsubscribe = hub.subscribe(request.deviceId, emit);
        emit({ type: 'voice.subscribed', deviceId: request.deviceId });
      } catch (error) {
        const message = error instanceof Error ? error.message : '订阅失败';
        logger.warn(`Voice recognition subscription failed: ${message}`);
        emit({ type: 'voice.error', message });
        if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'failed');
      }
    });
  });

  logger.log(`Voice recognition WebSocket ready at ${VOICE_EVENTS_PATH}`);
}
