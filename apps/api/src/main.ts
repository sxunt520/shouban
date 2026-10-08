import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { raw } from 'express';
import { AppModule } from './app.module';
import { registerConversationWebSocket } from './modules/figure-companion/conversation-websocket';
import { registerDeviceVoiceWebSocket } from './modules/figure-companion/device-voice-websocket';
import { registerVoiceRecognitionWebSocket } from './modules/figure-companion/voice-recognition-websocket';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('v1');
  app.use(
    '/v1/device/conversation/audio',
    raw({ type: ['audio/wav', 'application/octet-stream'], limit: '512kb' }),
  );
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  registerConversationWebSocket(app);
  registerDeviceVoiceWebSocket(app);
  registerVoiceRecognitionWebSocket(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Figure API listening on http://0.0.0.0:${port}/v1`);
}

void bootstrap();
