import { INestApplication } from '@nestjs/common';
import { WebSocketServer } from 'ws';
import { R1mAccessService } from '../device-integration/r1m-access.service';
import { R1mVoiceService } from './r1m-voice.service';

export function registerR1mVoiceWebSocket(app: INestApplication) {
  const access = app.get(R1mAccessService), voice = app.get(R1mVoiceService);
  const ws = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  app.getHttpServer().on('upgrade', (request: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    if (request.url?.split('?')[0] !== '/v1/partner/r1m/voice') return;
    const timeout = setTimeout(() => socket.destroy(), 5000);
    void (async () => {
      try {
        if (request.headers['protocol-version'] !== '1') throw new Error('Unsupported protocol');
        const device = await access.authenticate(request.headers);
        if (!socket.destroyed) ws.handleUpgrade(request, socket, head, client => voice.connect(client, device));
      } catch { if (!socket.destroyed) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } }
      finally { clearTimeout(timeout); }
    })();
  });
}
