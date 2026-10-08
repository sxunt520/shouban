import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RawData, WebSocket } from 'ws';
import RPCClient = require('@alicloud/pop-core');

interface NlsTokenResponse {
  Token?: {
    Id?: string;
    ExpireTime?: number;
  };
}

interface NlsAsrResponse {
  task_id?: string;
  result?: string;
  status?: number;
  message?: string;
}

export interface WavMetadata {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

interface NlsRealtimeMessage {
  header?: {
    name?: string;
    status?: number;
    status_text?: string;
    task_id?: string;
  };
  payload?: {
    index?: number;
    time?: number;
    begin_time?: number;
    result?: string;
  };
}

export interface RealtimeAsrProgress {
  text: string;
  sentenceIndex: number | null;
  audioTimeMs: number | null;
  elapsedMs: number;
  final: boolean;
}

export interface RealtimeAsrResult extends WavMetadata {
  text: string;
  taskId: string;
  provider: 'aliyun-nls-realtime';
  firstPartialMs: number | null;
  recognitionElapsedMs: number;
  finalizationElapsedMs: number | null;
}

export interface RealtimeAsrSession {
  write(audio: Buffer): void;
  finish(): Promise<RealtimeAsrResult>;
  abort(): void;
}

// Send 50 ms of 16 kHz mono PCM per frame. The previous 100 ms batching
// added avoidable latency to every intermediate and final recognition event.
const REALTIME_PCM_FRAME_BYTES = 1600;

class AliyunRealtimeAsrSession implements RealtimeAsrSession {
  private readonly socket: WebSocket;
  private readonly startedAt = Date.now();
  private readonly sentenceResults = new Map<number, string>();
  private pendingAudio = Buffer.alloc(0);
  private currentResult = '';
  private dataBytes = 0;
  private firstPartialMs: number | null = null;
  private stoppingAt: number | null = null;
  private started = false;
  private stopping = false;
  private settled = false;
  private readyTimeout?: NodeJS.Timeout;
  private completionTimeout?: NodeJS.Timeout;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveCompletion!: (result: RealtimeAsrResult) => void;
  private rejectCompletion!: (error: Error) => void;
  private readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  private readonly completionPromise = new Promise<RealtimeAsrResult>(
    (resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    },
  );

  constructor(
    endpoint: string,
    token: string,
    private readonly appKey: string,
    private readonly taskId: string,
    private readonly maxSentenceSilenceMs: number,
    private readonly finalizationTimeoutMs: number,
    private readonly onProgress?: (progress: RealtimeAsrProgress) => void,
  ) {
    const url = new URL(endpoint);
    url.searchParams.set('token', token);
    this.socket = new WebSocket(url);
    this.completionPromise.catch(() => undefined);
    this.socket.on('open', () => this.startTranscription());
    this.socket.on('message', (data) => this.handleMessage(data));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', (code, reason) => {
      if (!this.settled) {
        this.fail(
          new Error(
            `实时语音识别连接已关闭（${code}${reason.length ? `：${reason.toString()}` : ''}）`,
          ),
        );
      }
    });
    this.readyTimeout = setTimeout(
      () => this.fail(new Error('实时语音识别启动超时')),
      10_000,
    );
  }

  async waitUntilReady() {
    await this.readyPromise;
    return this;
  }

  write(audio: Buffer) {
    if (!this.started || this.stopping || this.settled || audio.length === 0) {
      return;
    }
    this.dataBytes += audio.length;
    this.pendingAudio = this.pendingAudio.length
      ? Buffer.concat([this.pendingAudio, audio])
      : Buffer.from(audio);
    while (this.pendingAudio.length >= REALTIME_PCM_FRAME_BYTES) {
      this.socket.send(this.pendingAudio.subarray(0, REALTIME_PCM_FRAME_BYTES), {
        binary: true,
      });
      this.pendingAudio = this.pendingAudio.subarray(REALTIME_PCM_FRAME_BYTES);
    }
  }

  async finish() {
    if (!this.started || this.settled) return this.completionPromise;
    if (!this.stopping) {
      this.stopping = true;
      this.stoppingAt = Date.now();
      if (this.pendingAudio.length) {
        this.socket.send(this.pendingAudio, { binary: true });
        this.pendingAudio = Buffer.alloc(0);
      }
      this.socket.send(
        JSON.stringify({
          header: {
            message_id: randomId(),
            task_id: this.taskId,
            namespace: 'SpeechTranscriber',
            name: 'StopTranscription',
            appkey: this.appKey,
          },
        }),
      );
      this.completionTimeout = setTimeout(
        () => this.fail(new Error('实时语音识别结束超时')),
        this.finalizationTimeoutMs,
      );
    }
    return this.completionPromise;
  }

  abort() {
    this.fail(new Error('实时语音识别已取消'));
  }

  private startTranscription() {
    this.socket.send(
      JSON.stringify({
        header: {
          message_id: randomId(),
          task_id: this.taskId,
          namespace: 'SpeechTranscriber',
          name: 'StartTranscription',
          appkey: this.appKey,
        },
        payload: {
          format: 'pcm',
          sample_rate: 16000,
          enable_intermediate_result: true,
          enable_punctuation_prediction: true,
          enable_inverse_text_normalization: true,
          max_sentence_silence: this.maxSentenceSilenceMs,
        },
      }),
    );
  }

  private handleMessage(data: RawData) {
    let message: NlsRealtimeMessage;
    try {
      message = JSON.parse(data.toString()) as NlsRealtimeMessage;
    } catch {
      this.fail(new Error('实时语音识别返回了无法解析的数据'));
      return;
    }
    const name = message.header?.name;
    const status = message.header?.status;
    if (name === 'TaskFailed' || (status !== undefined && status !== 20000000)) {
      this.fail(
        new Error(
          `阿里云实时语音识别失败：${message.header?.status_text || status || '未知错误'}`,
        ),
      );
      return;
    }
    if (name === 'TranscriptionStarted') {
      this.started = true;
      if (this.readyTimeout) clearTimeout(this.readyTimeout);
      this.resolveReady();
      return;
    }
    if (name === 'TranscriptionResultChanged') {
      const text = message.payload?.result?.trim() ?? '';
      this.currentResult = text;
      if (text && this.firstPartialMs === null) {
        this.firstPartialMs = Date.now() - this.startedAt;
      }
      if (text) this.emitProgress(message, text, false);
      return;
    }
    if (name === 'SentenceEnd') {
      const text = message.payload?.result?.trim() ?? '';
      const index = message.payload?.index;
      if (text) {
        this.sentenceResults.set(
          typeof index === 'number' ? index : this.sentenceResults.size,
          text,
        );
        if (this.firstPartialMs === null) {
          this.firstPartialMs = Date.now() - this.startedAt;
        }
        this.emitProgress(message, text, true);
      }
      this.currentResult = '';
      return;
    }
    if (name === 'TranscriptionCompleted') {
      const sentenceText = [...this.sentenceResults.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, text]) => text)
        .join('');
      const text = sentenceText || this.currentResult;
      this.succeed(text);
    }
  }

  private emitProgress(
    message: NlsRealtimeMessage,
    text: string,
    final: boolean,
  ) {
    this.onProgress?.({
      text,
      sentenceIndex:
        typeof message.payload?.index === 'number' ? message.payload.index : null,
      audioTimeMs:
        typeof message.payload?.time === 'number' ? message.payload.time : null,
      elapsedMs: Date.now() - this.startedAt,
      final,
    });
  }

  private succeed(text: string) {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.resolveCompletion({
      text,
      taskId: this.taskId,
      provider: 'aliyun-nls-realtime',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: this.dataBytes,
      durationMs: Math.round((this.dataBytes * 1000) / 32000),
      firstPartialMs: this.firstPartialMs,
      recognitionElapsedMs: Date.now() - this.startedAt,
      finalizationElapsedMs:
        this.stoppingAt === null ? null : Date.now() - this.stoppingAt,
    });
    this.socket.close(1000, 'completed');
  }

  private fail(error: Error) {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    if (!this.started) this.rejectReady(error);
    this.rejectCompletion(error);
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.terminate();
    }
  }

  private clearTimers() {
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    if (this.completionTimeout) clearTimeout(this.completionTimeout);
  }
}

function randomId() {
  return randomBytes(16).toString('hex');
}

@Injectable()
export class AsrService {
  private readonly logger = new Logger(AsrService.name);
  private cachedToken?: { id: string; expiresAtSeconds: number };

  async startRealtimeRecognition(
    onProgress?: (progress: RealtimeAsrProgress) => void,
  ): Promise<RealtimeAsrSession> {
    const appKey = this.required('ALIYUN_NLS_APP_KEY');
    const token = await this.getToken();
    const endpoint =
      process.env.ALIYUN_NLS_REALTIME_ENDPOINT?.trim() ||
      'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1';
    const maxSentenceSilenceMs = boundedInteger(
      process.env.ALIYUN_NLS_ASR_MAX_SENTENCE_SILENCE_MS,
      500,
      200,
      2000,
    );
    const finalizationTimeoutMs = boundedInteger(
      process.env.ALIYUN_NLS_ASR_FINAL_TIMEOUT_MS,
      5000,
      2000,
      20000,
    );
    const session = new AliyunRealtimeAsrSession(
      endpoint,
      token,
      appKey,
      randomId(),
      maxSentenceSilenceMs,
      finalizationTimeoutMs,
      onProgress,
    );
    try {
      await session.waitUntilReady();
      return session;
    } catch (error) {
      throw new ServiceUnavailableException(
        `连接阿里云实时语音识别失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      );
    }
  }

  async recognizeWav(audio: Buffer) {
    const metadata = this.validateWav(audio);
    const appKey = this.required('ALIYUN_NLS_APP_KEY');
    const token = await this.getToken();
    const endpoint =
      process.env.ALIYUN_NLS_ASR_ENDPOINT?.trim() ||
      'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr';
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      appkey: appKey,
      format: 'wav',
      sample_rate: String(metadata.sampleRate),
      enable_punctuation_prediction: 'true',
      enable_inverse_text_normalization: 'true',
      enable_voice_detection: 'true',
    }).toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-NLS-Token': token,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(audio.length),
        },
        body: new Uint8Array(audio),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `连接阿里云语音识别服务失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }

    const payload = (await response.json().catch(() => ({}))) as NlsAsrResponse;
    if (!response.ok || payload.status !== 20000000) {
      this.logger.error(
        `NLS ASR failed http=${response.status} status=${payload.status ?? 'unknown'} taskId=${payload.task_id ?? 'unknown'} message=${payload.message ?? 'unknown'}`,
      );
      throw new BadGatewayException(
        `阿里云语音识别失败：${payload.message || payload.status || response.status}`,
      );
    }

    const text = payload.result?.trim() ?? '';
    this.logger.log(
      `ASR ready chars=${text.length} durationMs=${metadata.durationMs} taskId=${payload.task_id ?? 'unknown'}`,
    );
    return {
      text,
      taskId: payload.task_id ?? null,
      provider: 'aliyun-nls' as const,
      ...metadata,
    };
  }

  async recognizePcm16(audio: Buffer) {
    if (audio.length < 3200 || audio.length > 320 * 1024) {
      throw new BadRequestException('PCM 录音大小无效，必须为 0.1～10 秒');
    }
    if ((audio.length & 1) !== 0) {
      throw new BadRequestException('PCM 录音必须按 16-bit 采样对齐');
    }

    const wav = Buffer.allocUnsafe(44 + audio.length);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(36 + audio.length, 4);
    wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(audio.length, 40);
    audio.copy(wav, 44);
    return this.recognizeWav(wav);
  }

  private async getToken() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      this.cachedToken &&
      this.cachedToken.expiresAtSeconds > nowSeconds + 300
    ) {
      return this.cachedToken.id;
    }

    const client = new RPCClient({
      accessKeyId: this.required('ALIYUN_ACCESS_KEY_ID'),
      accessKeySecret: this.required('ALIYUN_ACCESS_KEY_SECRET'),
      endpoint:
        process.env.ALIYUN_NLS_TOKEN_ENDPOINT?.trim() ||
        'https://nls-meta.cn-shanghai.aliyuncs.com',
      apiVersion: '2019-02-28',
    });
    let result: NlsTokenResponse;
    try {
      result = await client.request<NlsTokenResponse>(
        'CreateToken',
        {},
        { method: 'POST' },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        `获取阿里云 NLS Token 失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      );
    }

    const id = result.Token?.Id;
    const expiresAtSeconds = Number(result.Token?.ExpireTime ?? 0);
    if (!id || !Number.isFinite(expiresAtSeconds)) {
      throw new ServiceUnavailableException('阿里云 NLS Token 响应无效');
    }
    this.cachedToken = { id, expiresAtSeconds };
    this.logger.log('NLS access token refreshed');
    return id;
  }

  private validateWav(audio: Buffer): WavMetadata {
    if (audio.length < 44 || audio.length > 512 * 1024) {
      throw new BadRequestException('录音大小无效，必须为 44B～512KB');
    }
    if (
      audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new BadRequestException('设备上传的内容不是 RIFF/WAVE 音频');
    }

    let offset = 12;
    let audioFormat = 0;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let dataBytes = 0;
    while (offset + 8 <= audio.length) {
      const chunkName = audio.toString('ascii', offset, offset + 4);
      const chunkLength = audio.readUInt32LE(offset + 4);
      const dataOffset = offset + 8;
      if (chunkLength > audio.length - dataOffset) {
        throw new BadRequestException('WAV 分块长度无效');
      }
      if (chunkName === 'fmt ' && chunkLength >= 16) {
        audioFormat = audio.readUInt16LE(dataOffset);
        channels = audio.readUInt16LE(dataOffset + 2);
        sampleRate = audio.readUInt32LE(dataOffset + 4);
        bitsPerSample = audio.readUInt16LE(dataOffset + 14);
      } else if (chunkName === 'data') {
        dataBytes = chunkLength;
      }
      offset = dataOffset + chunkLength + (chunkLength & 1);
    }

    if (
      audioFormat !== 1 ||
      channels !== 1 ||
      sampleRate !== 16000 ||
      bitsPerSample !== 16 ||
      dataBytes === 0
    ) {
      throw new BadRequestException(
        '仅支持 16kHz、16-bit、单声道 PCM WAV 录音',
      );
    }
    return {
      sampleRate,
      channels,
      bitsPerSample,
      dataBytes,
      durationMs: Math.round(
        (dataBytes * 1000) / (sampleRate * channels * (bitsPerSample / 8)),
      ),
    };
  }

  private required(name: string) {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new ServiceUnavailableException(`尚未配置 ${name}`);
    }
    return value;
  }
}

function boundedInteger(
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(rawValue ?? fallback);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}
