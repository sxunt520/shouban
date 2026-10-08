import { INestApplication, Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { AsrService, RealtimeAsrSession } from './asr.service';
import { DeviceEntity } from './entities';
import { DeviceRealtimeReplyEvent, StoreService } from './store.service';
import { VoiceRecognitionHub } from './voice-recognition-hub';

interface AudioStartRequest {
  type: 'audio.start';
  token: string;
  format: 'opus' | 'pcm_s16le';
  sampleRate: 16000;
  channels: 1;
  frameDurationMs?: 20;
  commandId?: string | null;
  pushToTalk?: boolean;
}

interface OpusDecoder {
  decode(packet: Buffer): Buffer;
}

type OpusDecoderConstructor = new (
  sampleRate: number,
  channels: number,
) => OpusDecoder;

const STREAM_PATH = '/v1/device/conversation/stream';
const MAX_PCM_BYTES = 16000 * 2 * 10;
const MIN_PCM_BYTES = 16000 * 2 / 10;
const MAX_OPUS_PACKET_BYTES = 1275;
const RECORDING_IDLE_TIMEOUT_MS = 15_000;
const CONNECTION_IDLE_TIMEOUT_MS = 10 * 60_000;
const REPLY_TIMEOUT_MS = 120_000;
const REALTIME_ASR_FINISH_GRACE_MS = 800;
const DEVICE_AUTH_CACHE_MS = 5 * 60_000;

function isDeviceVoiceUpgrade(request: IncomingMessage) {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname === STREAM_PATH;
  } catch {
    return false;
  }
}

function loadOpusDecoder(logger: Logger): OpusDecoderConstructor | null {
  try {
    // Loaded lazily so a missing native binding only disables Opus; PCM remains
    // available for existing devices and development environments.
    const codec = require('@discordjs/opus') as {
      OpusEncoder?: OpusDecoderConstructor;
    };
    if (typeof codec.OpusEncoder === 'function') return codec.OpusEncoder;
  } catch (error) {
    logger.warn(
      `Opus decoder unavailable; PCM fallback only: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
  return null;
}

function readStart(
  data: RawData,
  opusSupported: boolean,
): AudioStartRequest {
  const payload = JSON.parse(data.toString()) as Partial<AudioStartRequest>;
  if (
    payload.type !== 'audio.start' ||
    typeof payload.token !== 'string' ||
    (payload.format !== 'pcm_s16le' && payload.format !== 'opus') ||
    payload.sampleRate !== 16000 ||
    payload.channels !== 1 ||
    (payload.format === 'opus' &&
      (!opusSupported || payload.frameDurationMs !== 20)) ||
    (payload.commandId !== undefined &&
      payload.commandId !== null &&
      typeof payload.commandId !== 'string')
  ) {
    throw new Error(
      opusSupported
        ? '语音流参数无效，仅支持 Opus/PCM16、16kHz、单声道'
        : '当前服务仅支持 PCM16/16kHz/单声道',
    );
  }
  return payload as AudioStartRequest;
}

function toBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

export function registerDeviceVoiceWebSocket(app: INestApplication) {
  const logger = new Logger('DeviceVoiceWebSocket');
  const store = app.get(StoreService);
  const asr = app.get(AsrService);
  const voiceHub = app.get(VoiceRecognitionHub);
  const server = app.getHttpServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const OpusDecoderClass = loadOpusDecoder(logger);

  server.on(
    'upgrade',
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!isDeviceVoiceUpgrade(request)) return;
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    },
  );

  webSocketServer.on('connection', (socket) => {
    let device: DeviceEntity | null = null;
    let request: AudioStartRequest | null = null;
    let chunks: Buffer[] = [];
    let receivedPcmBytes = 0;
    let receivedWireBytes = 0;
    let finishing = false;
    let realtimeAsr: RealtimeAsrSession | null = null;
    let realtimeAsrPromise: Promise<RealtimeAsrSession | null> | null = null;
    let discardPendingRealtimeAsr = false;
    let opusDecoder: OpusDecoder | null = null;
    let realtimeFallbackReason: string | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    let replyTimer: NodeJS.Timeout | undefined;
    let speechEndedAt: number | null = null;
    let turnStartedAt: number | null = null;
    let firstAudioAt: number | null = null;
    let turnSerial = 0;
    let authenticatedToken: string | null = null;
    let authenticatedAt = 0;

    const emit = (event: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    };
    const closeWithError = (message: string, code = 1008) => {
      logger.warn(
        `Device voice socket failed device=${device?.id ?? 'unauthenticated'}: ${message}`,
      );
      if (device) {
        voiceHub.publish({ type: 'voice.error', deviceId: device.id, message });
      }
      emit({ type: 'error', message });
      if (socket.readyState === WebSocket.OPEN) socket.close(code, 'failed');
    };
    const resetIdleTimer = (timeoutMs = RECORDING_IDLE_TIMEOUT_MS) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => closeWithError('语音流等待超时', 1008),
        timeoutMs,
      );
    };
    const resetReplyTimer = () => {
      if (replyTimer) clearTimeout(replyTimer);
      replyTimer = setTimeout(
        () => closeWithError('AI 回复等待超时', 1011),
        REPLY_TIMEOUT_MS,
      );
    };
    const resetTurn = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (replyTimer) clearTimeout(replyTimer);
      request = null;
      chunks = [];
      receivedPcmBytes = 0;
      receivedWireBytes = 0;
      finishing = false;
      discardPendingRealtimeAsr = true;
      realtimeAsr = null;
      realtimeAsrPromise = null;
      opusDecoder = null;
      realtimeFallbackReason = null;
      speechEndedAt = null;
      turnStartedAt = null;
      firstAudioAt = null;
      resetIdleTimer(CONNECTION_IDLE_TIMEOUT_MS);
    };
    const createRealtimeReplyEmitter = (serial: number) => {
      const emitter = (event: DeviceRealtimeReplyEvent) => {
        if (serial !== turnSerial || !finishing) return;
        const elapsedMs =
          speechEndedAt === null ? null : Date.now() - speechEndedAt;
        if (event.type === 'reply.audio.stream.chunk') {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(event.audioData, { binary: true });
          }
        } else if (event.type === 'reply.audio' && event.audioData) {
          const { audioData, ...wireEvent } = event;
          emit({
            ...wireEvent,
            audioTransport: 'websocket',
            audioBytes: audioData.length,
            elapsedMsSinceSpeechEnd: elapsedMs,
          });
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(audioData, { binary: true });
          }
        } else {
          emit({
            ...event,
            ...(event.type === 'reply.audio' && event.audioStreamId
              ? { audioTransport: 'streamed_pcm' }
              : {}),
            elapsedMsSinceSpeechEnd: elapsedMs,
          });
        }
        resetReplyTimer();
        if (event.type === 'reply.audio') {
          logger.log(
            `Realtime reply audio ready device=${device?.id ?? 'unknown'} turn=${serial} sequence=${event.sequence} elapsedMs=${elapsedMs ?? 'n/a'}`,
          );
        } else if (event.type === 'reply.completed') {
          logger.log(
            `Realtime reply completed device=${device?.id ?? 'unknown'} turn=${serial} chunks=${event.chunkCount} elapsedMs=${elapsedMs ?? 'n/a'}`,
          );
        }
      };
      emitter.supportsPcmStream = true;
      return emitter;
    };

    resetIdleTimer(CONNECTION_IDLE_TIMEOUT_MS);
    emit({
      type: 'session.capabilities',
      formats: OpusDecoderClass ? ['opus', 'pcm_s16le'] : ['pcm_s16le'],
      preferredFormat: OpusDecoderClass ? 'opus' : 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      opusFrameDurationMs: OpusDecoderClass ? 20 : null,
      persistent: true,
    });
    socket.on('ping', () => resetIdleTimer(CONNECTION_IDLE_TIMEOUT_MS));
    socket.once('close', () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (replyTimer) clearTimeout(replyTimer);
      discardPendingRealtimeAsr = true;
      if (!finishing) realtimeAsr?.abort();
      chunks = [];
    });
    socket.on('message', async (data, isBinary) => {
      if (finishing) {
        if (isBinary || !device) return;
        try {
          const payload = JSON.parse(data.toString()) as {
            type?: string;
            commandId?: string;
            played?: boolean;
          };
          if (
            payload.type === 'reply.audio.ack' &&
            typeof payload.commandId === 'string'
          ) {
            await store.acknowledgeCommand(device, payload.commandId);
            emit({
              type: 'reply.audio.acknowledged',
              commandId: payload.commandId,
              played: payload.played === true,
            });
            resetReplyTimer();
            return;
          }
          if (payload.type === 'reply.interrupt') {
            const interruptedTurn = turnSerial;
            const cancellation = await store.interruptDeviceConversation(device);
            if (interruptedTurn !== turnSerial) return;
            emit({ type: 'reply.interrupted', ...cancellation });
            logger.log(
              `Realtime reply interrupted device=${device.id} turn=${interruptedTurn}`,
            );
            resetTurn();
            emit({ type: 'session.idle', persistent: true });
            return;
          }
          if (payload.type === 'reply.done') {
            const completedTurn = turnSerial;
            emit({ type: 'session.completed' });
            logger.log(
              `Realtime voice turn finished device=${device.id} turn=${completedTurn} elapsedMs=${speechEndedAt === null ? 'n/a' : Date.now() - speechEndedAt}`,
            );
            resetTurn();
            emit({ type: 'session.idle', persistent: true });
            return;
          }
          throw new Error('未知的实时回复控制消息');
        } catch (error) {
          closeWithError(
            error instanceof Error ? error.message : '实时回复确认失败',
            1008,
          );
        }
        return;
      }
      resetIdleTimer();
      try {
        if (!request) {
          if (isBinary) throw new Error('请先发送 audio.start');
          request = readStart(data, OpusDecoderClass !== null);
          turnStartedAt = Date.now();
          const authCacheHit =
            device !== null &&
            authenticatedToken === request.token &&
            Date.now() - authenticatedAt < DEVICE_AUTH_CACHE_MS;
          const authenticatedDevice = authCacheHit
            ? device
            : await store.getDeviceForToken(request.token);
          if (!authenticatedDevice) {
            throw new Error('设备登录状态无效，请重新创建会话');
          }
          device = authenticatedDevice;
          authenticatedToken = request.token;
          authenticatedAt = Date.now();
          turnSerial += 1;
          chunks = [];
          receivedPcmBytes = 0;
          receivedWireBytes = 0;
          finishing = false;
          discardPendingRealtimeAsr = false;
          realtimeFallbackReason = null;
          speechEndedAt = null;
          firstAudioAt = null;
          opusDecoder =
            request.format === 'opus' && OpusDecoderClass
              ? new OpusDecoderClass(request.sampleRate, request.channels)
              : null;
          voiceHub.publish({ type: 'voice.listening', deviceId: device.id });
          const activeTurnSerial = turnSerial;
          const asrStartedAt = Date.now();
          realtimeAsrPromise = asr
            .startRealtimeRecognition((progress) => {
              if (activeTurnSerial !== turnSerial) return;
              if (device) {
                voiceHub.publish({
                  type: progress.final
                    ? 'voice.transcript.sentence'
                    : 'voice.transcript.partial',
                  deviceId: device.id,
                  text: progress.text,
                  elapsedMs: progress.elapsedMs,
                });
              }
              emit({
                type: progress.final
                  ? 'transcript.sentence'
                  : 'transcript.partial',
                text: progress.text,
                sentenceIndex: progress.sentenceIndex,
                audioTimeMs: progress.audioTimeMs,
                elapsedMs: progress.elapsedMs,
              });
            })
            .then((session) => {
              if (
                discardPendingRealtimeAsr ||
                activeTurnSerial !== turnSerial ||
                request === null
              ) {
                session.abort();
                return null;
              }
              realtimeAsr = session;
              for (const chunk of chunks) session.write(chunk);
              logger.log(
                `Realtime ASR ready device=${device?.id ?? 'unknown'} turn=${activeTurnSerial} startupMs=${Date.now() - asrStartedAt} bufferedPcmBytes=${receivedPcmBytes}`,
              );
              return session;
            })
            .catch((error) => {
              if (activeTurnSerial !== turnSerial) return null;
              realtimeFallbackReason =
                error instanceof Error ? error.message : '实时识别连接失败';
              logger.warn(
                `Realtime ASR unavailable device=${device?.id ?? 'unknown'} turn=${activeTurnSerial}; using batch fallback: ${realtimeFallbackReason}`,
              );
              return null;
            });
          emit({
            type: 'session.ready',
            format: request.format,
            sampleRate: request.sampleRate,
            channels: request.channels,
            maxDurationMs: 10_000,
            asrMode: 'realtime_starting',
          });
          logger.log(
            `Device voice stream ready device=${device.id} turn=${turnSerial} readyMs=${Date.now() - turnStartedAt} authCache=${authCacheHit ? 'hit' : 'miss'}`,
          );
          return;
        }

        if (isBinary) {
          const chunk = toBuffer(data);
          receivedWireBytes += chunk.length;
          let pcmChunk: Buffer;
          if (request.format === 'opus') {
            if (
              !opusDecoder ||
              chunk.length === 0 ||
              chunk.length > MAX_OPUS_PACKET_BYTES
            ) {
              throw new Error('Opus 音频帧无效');
            }
            try {
              pcmChunk = opusDecoder.decode(chunk);
            } catch (error) {
              throw new Error(
                `Opus 音频解码失败：${
                  error instanceof Error ? error.message : '未知错误'
                }`,
              );
            }
          } else {
            pcmChunk = chunk;
          }
          if ((pcmChunk.length & 1) !== 0 || pcmChunk.length === 0) {
            throw new Error('解码后的 PCM 数据未按 16-bit 采样对齐');
          }
          if (receivedPcmBytes + pcmChunk.length > MAX_PCM_BYTES) {
            throw new Error('录音超过 10 秒上限');
          }
          if (firstAudioAt === null) {
            firstAudioAt = Date.now();
            logger.log(
              `Device first audio device=${device?.id ?? 'unknown'} turn=${turnSerial} elapsedMs=${turnStartedAt === null ? 'n/a' : firstAudioAt - turnStartedAt}`,
            );
          }
          chunks.push(Buffer.from(pcmChunk));
          receivedPcmBytes += pcmChunk.length;
          realtimeAsr?.write(pcmChunk);
          return;
        }

        const payload = JSON.parse(data.toString()) as { type?: string };
        if (payload.type !== 'audio.end') {
          throw new Error('未知的语音流控制消息');
        }
        if (receivedPcmBytes < MIN_PCM_BYTES) {
          throw new Error('录音过短，请至少说话 0.1 秒');
        }
        const activeDevice = device;
        if (!activeDevice) {
          throw new Error('设备登录状态无效，请重新创建会话');
        }
        finishing = true;
        const activeTurnSerial = turnSerial;
        const emitRealtimeReply =
          createRealtimeReplyEmitter(activeTurnSerial);
        speechEndedAt = Date.now();
        if (idleTimer) clearTimeout(idleTimer);
        const pcm = Buffer.concat(chunks, receivedPcmBytes);
        emit({
          type: 'audio.received',
          format: request.format,
          wireBytes: receivedWireBytes,
          pcmBytes: receivedPcmBytes,
          compressionRatio:
            receivedWireBytes > 0
              ? Number((receivedPcmBytes / receivedWireBytes).toFixed(2))
              : 1,
        });
        let result: Awaited<ReturnType<StoreService['receiveDevicePcmStream']>>;
        let activeRealtimeAsr = realtimeAsr;
        if (!activeRealtimeAsr && realtimeAsrPromise) {
          activeRealtimeAsr = await Promise.race([
            realtimeAsrPromise,
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), REALTIME_ASR_FINISH_GRACE_MS),
            ),
          ]);
        }
        if (!activeRealtimeAsr && realtimeAsrPromise) {
          discardPendingRealtimeAsr = true;
          realtimeFallbackReason ??=
            `实时识别在说话结束后 ${REALTIME_ASR_FINISH_GRACE_MS}ms 内尚未就绪`;
        }
        chunks = [];
        if (activeRealtimeAsr) {
          try {
            const recognition = await activeRealtimeAsr.finish();
            result = await store.receiveDeviceRealtimeRecognition(
              activeDevice,
              request.commandId ?? undefined,
              recognition,
              emitRealtimeReply,
            );
          } catch (error) {
            realtimeFallbackReason =
              error instanceof Error ? error.message : '实时识别失败';
            logger.warn(
              `Realtime ASR failed device=${activeDevice.id}; retrying with batch ASR: ${realtimeFallbackReason}`,
            );
            result = await store.receiveDevicePcmStream(
              activeDevice,
              request.commandId ?? undefined,
              pcm,
              emitRealtimeReply,
            );
          }
        } else {
          result = await store.receiveDevicePcmStream(
            activeDevice,
            request.commandId ?? undefined,
            pcm,
            emitRealtimeReply,
          );
        }
        emit({
          type: 'transcript.final',
          text: result.text,
          durationMs: result.durationMs,
          taskId: result.taskId,
          asrMode:
            result.provider === 'aliyun-nls-realtime'
              ? 'realtime'
              : 'batch_fallback',
          firstPartialMs:
            'firstPartialMs' in result ? result.firstPartialMs : null,
          finalizationElapsedMs:
            'finalizationElapsedMs' in result
              ? result.finalizationElapsedMs
              : null,
        });
        voiceHub.publish({
          type: 'voice.transcript.final',
          deviceId: activeDevice.id,
          text: result.text,
          durationMs: result.durationMs,
          firstPartialMs:
            'firstPartialMs' in result ? result.firstPartialMs : null,
          asrMode:
            result.provider === 'aliyun-nls-realtime'
              ? 'realtime'
              : 'batch_fallback',
        });
        emit({
          type: 'conversation.accepted',
          accepted: true,
          hasText: Boolean(result.text),
        });
        logger.log(
          `Device voice stream completed device=${activeDevice.id} turn=${activeTurnSerial} format=${request.format} wireBytes=${receivedWireBytes} pcmBytes=${receivedPcmBytes} ratio=${receivedWireBytes > 0 ? (receivedPcmBytes / receivedWireBytes).toFixed(2) : '1.00'} chars=${result.text.length} provider=${result.provider} speechToTranscriptMs=${Date.now() - speechEndedAt} firstPartialMs=${'firstPartialMs' in result ? result.firstPartialMs : 'n/a'} finalizationMs=${'finalizationElapsedMs' in result ? result.finalizationElapsedMs : 'n/a'}${realtimeFallbackReason ? ` fallback=${realtimeFallbackReason}` : ''}`,
        );
        if (!result.text && activeTurnSerial === turnSerial) {
          emit({ type: 'session.completed' });
          resetTurn();
          emit({ type: 'session.idle', persistent: true });
        } else if (result.text) {
          resetReplyTimer();
        }
      } catch (error) {
        closeWithError(
          error instanceof Error ? error.message : '实时语音处理失败',
          finishing ? 1011 : 1008,
        );
      }
    });
  });

  logger.log(`Device voice WebSocket ready at ${STREAM_PATH}`);
}
