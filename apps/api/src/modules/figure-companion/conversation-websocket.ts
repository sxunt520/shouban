import { INestApplication, Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { StoreService } from './store.service';

interface ConversationSocketRequest {
  type: 'message.create';
  token: string;
  deviceId: string;
  text: string;
  clientRequestId?: string;
}

const STREAM_PATH = '/v1/devices/messages/stream';

function readRequest(data: RawData): ConversationSocketRequest {
  const payload = JSON.parse(data.toString()) as Partial<ConversationSocketRequest>;
  if (
    payload.type !== 'message.create' ||
    typeof payload.token !== 'string' ||
    typeof payload.deviceId !== 'string' ||
    typeof payload.text !== 'string' ||
    (payload.clientRequestId !== undefined &&
      typeof payload.clientRequestId !== 'string')
  ) {
    throw new Error('流式对话请求格式无效');
  }
  return payload as ConversationSocketRequest;
}

function isConversationUpgrade(request: IncomingMessage) {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname === STREAM_PATH;
  } catch {
    return false;
  }
}

export function registerConversationWebSocket(app: INestApplication) {
  const logger = new Logger('ConversationWebSocket');
  const store = app.get(StoreService);
  const server = app.getHttpServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  server.on(
    'upgrade',
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!isConversationUpgrade(request)) return;
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    },
  );

  webSocketServer.on('connection', (socket) => {
    const controller = new AbortController();
    let started = false;
    const emit = (event: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    };

    socket.once('close', () => controller.abort());
    socket.once('error', () => controller.abort());
    socket.on('message', async (data) => {
      if (started) {
        emit({ type: 'error', message: '一个连接只能发送一条消息' });
        return;
      }
      started = true;

      try {
        const request = readRequest(data);
        const user = store.getUserForToken(request.token);
        if (!user) throw new Error('登录状态无效');
        await store.streamAppConversationMessage(
          user.id,
          request.deviceId,
          request.text,
          request.clientRequestId,
          emit,
          controller.signal,
        );
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'completed');
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : '流式对话失败';
          logger.warn(`Conversation socket failed: ${message}`);
          emit({ type: 'error', message });
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'failed');
        }
      }
    });
  });

  logger.log(`Conversation WebSocket ready at ${STREAM_PATH}`);
}
