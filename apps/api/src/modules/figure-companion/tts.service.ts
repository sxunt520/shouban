import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RawData, WebSocket } from 'ws';

interface DashScopeResponse {
  output?: {
    audio?: { url?: string; expires_at?: number };
    url?: string;
    voice_id?: string;
  };
  request_id?: string;
  code?: string;
  message?: string;
}

interface DashScopeRealtimeEvent {
  header?: {
    event?: string;
    error_code?: string;
    error_message?: string;
  };
}

interface SynthesizedAudio {
  audio: Buffer;
  requestId: string | null;
  transport: 'websocket' | 'http';
  firstPackageMs?: number;
}

export interface RealtimeTtsStreamCallbacks {
  onPcmChunk(chunk: Buffer): void;
  onRawPcmFirstPackage?(): void;
}

export interface TtsSynthesisResult {
  audio: Buffer;
  audioPath: string;
  format: 'wav';
  sampleRate: number;
  voice: string;
  model: string;
  text: string;
  provider: 'aliyun-dashscope';
  requestId: string | null;
}

export interface RealtimeTtsSession {
  readonly taskId: string;
  pushText(text: string): Promise<void>;
  finish(): Promise<TtsSynthesisResult>;
  cancel(): void;
}

const PCM_GATE_FRAME_MS = 10;
const PCM_GATE_SILENCE_RMS = 420;
const PCM_GATE_CONSERVATIVE_PREFIX_MS = 350;
const PCM_GATE_DEFAULT_PREFIX_MS = 300;
const PCM_GATE_FAST_PREFIX_MS = 240;
const PCM_GATE_FAST_CLEAN_STREAK = 3;
const PCM_GATE_RECOVERY_TURNS = 6;
const PCM_GATE_MIN_GAP_MS = 220;
const PCM_GATE_DECISION_MS = 800;

interface LeadingArtifactProfile {
  cleanStreak: number;
  conservativeTurnsRemaining: number;
  artifactCount: number;
}

/**
 * Some cloned CosyVoice voices occasionally emit a short, unrelated syllable
 * followed by a long silent gap before the requested sentence. Hold only the
 * first fraction of a second and remove that prefix when this exact acoustic
 * pattern is present. Normal speech is released unchanged after the decision
 * window, so this is safer than cutting a fixed number of milliseconds.
 */
class LeadingPcmArtifactGate {
  private readonly frameBytes: number;
  private pending = Buffer.alloc(0);
  private state: 'scanning' | 'dropping-gap' | 'passthrough' = 'scanning';
  private voicedStartFrame: number | null = null;
  private silenceStartFrame: number | null = null;
  private scannedFrames = 0;
  trimmedBytes = 0;

  constructor(
    private readonly sampleRate: number,
    readonly maxPrefixMs = PCM_GATE_CONSERVATIVE_PREFIX_MS,
  ) {
    this.frameBytes = Math.max(
      2,
      Math.floor((sampleRate * PCM_GATE_FRAME_MS) / 1000) * 2,
    );
  }

  push(chunk: Buffer) {
    if (chunk.length === 0) return [];
    if (this.state === 'passthrough') return [chunk];
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk);
    return this.inspect();
  }

  finish() {
    if (this.state === 'dropping-gap') {
      this.trimmedBytes += this.pending.length;
      this.pending = Buffer.alloc(0);
      return [];
    }
    if (this.pending.length === 0) return [];
    const tail = this.pending;
    this.pending = Buffer.alloc(0);
    this.state = 'passthrough';
    return [tail];
  }

  private inspect(): Buffer[] {
    if (this.state === 'dropping-gap') {
      return this.dropUntilSpeech();
    }

    const completeFrames = Math.floor(this.pending.length / this.frameBytes);
    while (this.scannedFrames < completeFrames) {
      const frame = this.pending.subarray(
        this.scannedFrames * this.frameBytes,
        (this.scannedFrames + 1) * this.frameBytes,
      );
      const silent = this.rms(frame) < PCM_GATE_SILENCE_RMS;
      if (!silent) {
        if (this.voicedStartFrame === null) {
          this.voicedStartFrame = this.scannedFrames;
        }
        this.silenceStartFrame = null;
      } else if (this.voicedStartFrame !== null) {
        if (this.silenceStartFrame === null) {
          this.silenceStartFrame = this.scannedFrames;
        }
        const voicedPrefixMs =
          (this.silenceStartFrame - this.voicedStartFrame) * PCM_GATE_FRAME_MS;
        const silenceMs =
          (this.scannedFrames + 1 - this.silenceStartFrame) * PCM_GATE_FRAME_MS;
        if (
          voicedPrefixMs <= this.maxPrefixMs &&
          silenceMs >= PCM_GATE_MIN_GAP_MS
        ) {
          const discardedBytes = (this.scannedFrames + 1) * this.frameBytes;
          this.trimmedBytes += discardedBytes;
          this.pending = this.pending.subarray(discardedBytes);
          this.state = 'dropping-gap';
          this.scannedFrames = 0;
          return this.dropUntilSpeech();
        }
      }
      this.scannedFrames += 1;

      // Once normal speech has continued beyond the longest prefix that can
      // qualify as an artifact, the future audio can no longer turn this into
      // the "short syllable + long gap" pattern. Release immediately instead
      // of always holding the full decision window.
      if (
        this.voicedStartFrame !== null &&
        this.silenceStartFrame === null &&
        (this.scannedFrames - this.voicedStartFrame) * PCM_GATE_FRAME_MS >
          this.maxPrefixMs
      ) {
        const buffered = this.pending;
        this.pending = Buffer.alloc(0);
        this.state = 'passthrough';
        return [buffered];
      }
    }

    if (this.scannedFrames * PCM_GATE_FRAME_MS >= PCM_GATE_DECISION_MS) {
      const buffered = this.pending;
      this.pending = Buffer.alloc(0);
      this.state = 'passthrough';
      return [buffered];
    }
    return [];
  }

  private dropUntilSpeech(): Buffer[] {
    const completeFrames = Math.floor(this.pending.length / this.frameBytes);
    for (let frameIndex = 0; frameIndex < completeFrames; frameIndex += 1) {
      const offset = frameIndex * this.frameBytes;
      const frame = this.pending.subarray(offset, offset + this.frameBytes);
      if (this.rms(frame) >= PCM_GATE_SILENCE_RMS) {
        this.trimmedBytes += offset;
        const speech = this.pending.subarray(offset);
        this.pending = Buffer.alloc(0);
        this.state = 'passthrough';
        return speech.length ? [speech] : [];
      }
    }
    const completeBytes = completeFrames * this.frameBytes;
    this.trimmedBytes += completeBytes;
    this.pending = this.pending.subarray(completeBytes);
    return [];
  }

  private rms(frame: Buffer) {
    let sumSquares = 0;
    const samples = Math.floor(frame.length / 2);
    for (let offset = 0; offset + 1 < frame.length; offset += 2) {
      const sample = frame.readInt16LE(offset);
      sumSquares += sample * sample;
    }
    return samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
  }
}

@Injectable()
export class TtsService implements OnModuleDestroy {
  private readonly logger = new Logger(TtsService.name);
  private readonly cacheDirectory = resolve(process.cwd(), '.data', 'tts');
  private readonly realtimeSocketPool = new Map<string, WebSocket[]>();
  private readonly realtimeSocketIdleTimers = new Map<WebSocket, NodeJS.Timeout>();
  private readonly leadingArtifactProfiles = new Map<
    string,
    LeadingArtifactProfile
  >();

  onModuleDestroy() {
    for (const timer of this.realtimeSocketIdleTimers.values()) {
      clearTimeout(timer);
    }
    this.realtimeSocketIdleTimers.clear();
    for (const sockets of this.realtimeSocketPool.values()) {
      for (const socket of sockets) socket.terminate();
    }
    this.realtimeSocketPool.clear();
    this.leadingArtifactProfiles.clear();
  }

  async cloneVoice(
    audioUrl: string,
    requestedPrefix: string,
    requestedModel = 'cosyvoice-v3.5-plus',
  ) {
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        '尚未配置 DASHSCOPE_API_KEY，无法复刻音色',
      );
    }
    const endpoint =
      process.env.DASHSCOPE_VOICE_ENROLLMENT_ENDPOINT?.trim() ||
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
    const model = requestedModel.trim() || 'cosyvoice-v3.5-plus';
    const prefix = requestedPrefix
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 10) || 'alarm';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'voice-enrollment',
          input: {
            action: 'create_voice',
            target_model: model,
            prefix,
            url: audioUrl,
            language_hints: ['zh'],
            max_prompt_audio_length: 20,
            enable_volume_normalization: 'true',
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `连接阿里云音色复刻服务失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    const payload = (await response.json().catch(() => ({}))) as DashScopeResponse;
    if (!response.ok || !payload.output?.voice_id) {
      this.logger.error(
        `DashScope voice cloning failed status=${response.status} requestId=${payload.request_id ?? 'unknown'} code=${payload.code ?? 'unknown'}`,
      );
      throw new ServiceUnavailableException(
        `阿里云音色复刻失败：${payload.message || payload.code || response.status}`,
      );
    }
    this.logger.log(
      `Voice cloned model=${model} voice=${payload.output.voice_id} requestId=${payload.request_id ?? 'unknown'}`,
    );
    return {
      voiceId: payload.output.voice_id,
      model,
      requestId: payload.request_id ?? null,
    };
  }

  async synthesize(
    text: string,
    requestedVoiceId?: string | null,
    requestedModel?: string | null,
    streamCallbacks?: RealtimeTtsStreamCallbacks,
  ): Promise<TtsSynthesisResult> {
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        '尚未配置 DASHSCOPE_API_KEY，无法生成角色语音',
      );
    }

    const endpoint =
      process.env.DASHSCOPE_TTS_ENDPOINT?.trim() ||
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
    const defaultModel =
      process.env.DASHSCOPE_TTS_MODEL?.trim() || 'cosyvoice-v3.5-plus';
    const model = requestedModel?.trim() || defaultModel;
    const format = process.env.DASHSCOPE_TTS_FORMAT?.trim() || 'wav';
    const sampleRate = Number(process.env.DASHSCOPE_TTS_SAMPLE_RATE || 24000);
    const defaultVoice =
      process.env.DASHSCOPE_TTS_DEFAULT_VOICE?.trim() || 'longanyang';
    const voice =
      requestedVoiceId && !requestedVoiceId.startsWith('aliyun-voice-placeholder-')
        ? requestedVoiceId
        : defaultVoice;

    if (format !== 'wav') {
      throw new ServiceUnavailableException(
        '当前 ESP32 固件只支持 WAV，请将 DASHSCOPE_TTS_FORMAT 设置为 wav',
      );
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
      throw new ServiceUnavailableException('DASHSCOPE_TTS_SAMPLE_RATE 配置无效');
    }

    const spokenText = this.normalizeForSpeech(text);
    if (!spokenText) {
      throw new ServiceUnavailableException('文本中没有需要朗读的内容');
    }

    let synthesized: SynthesizedAudio;
    let realtimeStreamStarted = false;
    if (process.env.DASHSCOPE_TTS_REALTIME_ENABLED?.trim() !== 'false') {
      try {
        synthesized = await this.synthesizeRealtimeAudio(
          apiKey,
          model,
          voice,
          sampleRate,
          spokenText,
          streamCallbacks
            ? {
                onPcmChunk: (chunk) => {
                  realtimeStreamStarted = true;
                  streamCallbacks.onPcmChunk(chunk);
                },
              }
            : undefined,
        );
      } catch (error) {
        if (realtimeStreamStarted) {
          throw new ServiceUnavailableException(
            `实时语音流中断：${error instanceof Error ? error.message : '未知错误'}`,
          );
        }
        this.logger.warn(
          `Realtime TTS failed; falling back to HTTP: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        synthesized = await this.synthesizeHttpAudio(
          endpoint,
          apiKey,
          model,
          voice,
          format,
          sampleRate,
          spokenText,
        );
      }
    } else {
      synthesized = await this.synthesizeHttpAudio(
        endpoint,
        apiKey,
        model,
        voice,
        format,
        sampleRate,
        spokenText,
      );
    }
    return this.persistSynthesizedAudio(
      synthesized,
      sampleRate,
      voice,
      model,
      spokenText,
    );
  }

  async createRealtimeSession(
    requestedVoiceId?: string | null,
    requestedModel?: string | null,
    streamCallbacks?: RealtimeTtsStreamCallbacks,
  ): Promise<RealtimeTtsSession> {
    const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        '尚未配置 DASHSCOPE_API_KEY，无法生成角色语音',
      );
    }
    if (process.env.DASHSCOPE_TTS_REALTIME_ENABLED?.trim() === 'false') {
      throw new ServiceUnavailableException('实时语音合成当前已关闭');
    }

    const defaultModel =
      process.env.DASHSCOPE_TTS_MODEL?.trim() || 'cosyvoice-v3.5-plus';
    const model = requestedModel?.trim() || defaultModel;
    const sampleRate = Number(process.env.DASHSCOPE_TTS_SAMPLE_RATE || 24000);
    const defaultVoice =
      process.env.DASHSCOPE_TTS_DEFAULT_VOICE?.trim() || 'longanyang';
    const voice =
      requestedVoiceId && !requestedVoiceId.startsWith('aliyun-voice-placeholder-')
        ? requestedVoiceId
        : defaultVoice;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
      throw new ServiceUnavailableException('DASHSCOPE_TTS_SAMPLE_RATE 配置无效');
    }

    const session = await this.openRealtimeSession(
      apiKey,
      model,
      voice,
      sampleRate,
      streamCallbacks,
    );
    const submittedText: string[] = [];
    return {
      taskId: session.taskId,
      pushText: async (text: string) => {
        const spokenText = this.normalizeForSpeech(text);
        if (!spokenText) return;
        submittedText.push(spokenText);
        session.pushText(spokenText);
      },
      finish: async () => {
        if (submittedText.length === 0) {
          session.cancel();
          throw new ServiceUnavailableException('文本中没有需要朗读的内容');
        }
        const synthesized = await session.finish();
        return this.persistSynthesizedAudio(
          synthesized,
          sampleRate,
          voice,
          model,
          submittedText.join(''),
        );
      },
      cancel: () => session.cancel(),
    };
  }

  private async persistSynthesizedAudio(
    synthesized: SynthesizedAudio,
    sampleRate: number,
    voice: string,
    model: string,
    spokenText: string,
  ): Promise<TtsSynthesisResult> {
    const { audio } = synthesized;
    if (
      audio.length < 44 ||
      audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new ServiceUnavailableException('阿里云返回的音频不是有效 WAV 文件');
    }
    if (audio.length > 8 * 1024 * 1024) {
      throw new ServiceUnavailableException('生成的音频超过设备支持的 8MB 上限');
    }

    await mkdir(this.cacheDirectory, { recursive: true });
    const fileName = `${randomUUID()}.wav`;
    await writeFile(resolve(this.cacheDirectory, fileName), audio);
    this.logger.log(
      `TTS ready model=${model} voice=${voice} transport=${synthesized.transport} bytes=${audio.length} firstPackageMs=${synthesized.firstPackageMs ?? 'n/a'} requestId=${synthesized.requestId ?? 'unknown'}`,
    );
    return {
      audio,
      audioPath: `/audio/${fileName}`,
      format: 'wav' as const,
      sampleRate,
      voice,
      model,
      text: spokenText,
      provider: 'aliyun-dashscope' as const,
      requestId: synthesized.requestId,
    };
  }

  private leadingArtifactGateProfile(voice: string) {
    const adaptiveEnabled =
      process.env.DASHSCOPE_TTS_LEADING_ARTIFACT_ADAPTIVE?.trim() !== 'false';
    if (!adaptiveEnabled) {
      return {
        mode: 'fixed' as const,
        maxPrefixMs: PCM_GATE_CONSERVATIVE_PREFIX_MS,
      };
    }

    const profile = this.leadingArtifactProfiles.get(voice);
    if (profile?.conservativeTurnsRemaining) {
      return {
        mode: 'conservative' as const,
        maxPrefixMs: PCM_GATE_CONSERVATIVE_PREFIX_MS,
      };
    }
    if ((profile?.cleanStreak ?? 0) >= PCM_GATE_FAST_CLEAN_STREAK) {
      return {
        mode: 'fast' as const,
        maxPrefixMs: PCM_GATE_FAST_PREFIX_MS,
      };
    }
    return {
      mode: 'learning' as const,
      maxPrefixMs: PCM_GATE_DEFAULT_PREFIX_MS,
    };
  }

  private recordLeadingArtifactResult(voice: string, artifactDetected: boolean) {
    const existing = this.leadingArtifactProfiles.get(voice) ?? {
      cleanStreak: 0,
      conservativeTurnsRemaining: 0,
      artifactCount: 0,
    };
    const profile = artifactDetected
      ? {
          cleanStreak: 0,
          conservativeTurnsRemaining: PCM_GATE_RECOVERY_TURNS,
          artifactCount: existing.artifactCount + 1,
        }
      : {
          cleanStreak: Math.min(20, existing.cleanStreak + 1),
          conservativeTurnsRemaining: Math.max(
            0,
            existing.conservativeTurnsRemaining - 1,
          ),
          artifactCount: existing.artifactCount,
        };

    // A server normally has only a handful of character voices. Keep a hard
    // bound nevertheless so arbitrary voice IDs cannot grow process memory.
    if (
      !this.leadingArtifactProfiles.has(voice) &&
      this.leadingArtifactProfiles.size >= 32
    ) {
      const oldestVoice = this.leadingArtifactProfiles.keys().next().value;
      if (oldestVoice) this.leadingArtifactProfiles.delete(oldestVoice);
    }
    this.leadingArtifactProfiles.set(voice, profile);
    const next = this.leadingArtifactGateProfile(voice);
    this.logger.debug(
      `Realtime TTS gate profile voice=${voice} result=${artifactDetected ? 'artifact' : 'clean'} cleanStreak=${profile.cleanStreak} recovery=${profile.conservativeTurnsRemaining} artifacts=${profile.artifactCount} next=${next.mode}/${next.maxPrefixMs}ms`,
    );
  }

  private async openRealtimeSession(
    apiKey: string,
    model: string,
    voice: string,
    sampleRate: number,
    streamCallbacks?: RealtimeTtsStreamCallbacks,
  ): Promise<{
    taskId: string;
    pushText(text: string): void;
    finish(): Promise<SynthesizedAudio>;
    cancel(): void;
  }> {
    const endpoint =
      process.env.DASHSCOPE_TTS_WS_ENDPOINT?.trim() ||
      'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
    const taskId = randomUUID();
    const startedAt = Date.now();
    const poolKey = this.realtimeSocketPoolKey(endpoint, apiKey);
    const acquiredSocket = await this.acquireRealtimeSocket(
      poolKey,
      endpoint,
      apiKey,
    );

    return new Promise((resolveSession, rejectSession) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let receivedByteLength = 0;
      let firstPackageMs: number | undefined;
      let taskStarted = false;
      let settled = false;
      let finishSent = false;
      let sessionResolved = false;
      let idleTimeout: NodeJS.Timeout;
      let resolveResult!: (value: SynthesizedAudio) => void;
      let rejectResult!: (reason: Error) => void;
      const leadingArtifactFilterMode =
        process.env.DASHSCOPE_TTS_LEADING_ARTIFACT_FILTER?.trim().toLowerCase() ||
        'true';
      const filterLeadingArtifact =
        leadingArtifactFilterMode !== 'false' &&
        (leadingArtifactFilterMode === 'all' || voice.includes('-bailian-'));
      const gateProfile = filterLeadingArtifact
        ? this.leadingArtifactGateProfile(voice)
        : null;
      const leadingArtifactGate = filterLeadingArtifact
        ? new LeadingPcmArtifactGate(sampleRate, gateProfile!.maxPrefixMs)
        : null;
      const result = new Promise<SynthesizedAudio>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      // A session can fail before the caller awaits finish(). Keep Node from
      // reporting that expected startup failure as an unhandled rejection.
      void result.catch(() => undefined);
      const socket = acquiredSocket.socket;
      const refreshTimeout = () => {
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(
          () => fail(new Error('实时语音合成等待超时')),
          60_000,
        );
      };
      const acceptPcm = (chunk: Buffer) => {
        if (chunk.length === 0) return;
        if (firstPackageMs === undefined) firstPackageMs = Date.now() - startedAt;
        byteLength += chunk.length;
        chunks.push(chunk);
        try {
          streamCallbacks?.onPcmChunk(chunk);
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error('实时语音分块处理失败'),
          );
        }
      };
      const finish = () => {
        if (settled) return;
        for (const tail of leadingArtifactGate?.finish() ?? []) acceptPcm(tail);
        if (settled) return;
        settled = true;
        clearTimeout(idleTimeout);
        if (leadingArtifactGate && leadingArtifactGate.trimmedBytes > 0) {
          this.logger.warn(
            `Removed leading realtime TTS artifact task=${taskId} voice=${voice} gate=${gateProfile!.mode} prefixMs=${leadingArtifactGate.maxPrefixMs} bytes=${leadingArtifactGate.trimmedBytes} durationMs=${Math.round((leadingArtifactGate.trimmedBytes * 1000) / (sampleRate * 2))}`,
          );
        }
        if (leadingArtifactGate && receivedByteLength > 0) {
          this.recordLeadingArtifactResult(
            voice,
            leadingArtifactGate.trimmedBytes > 0,
          );
        }
        resolveResult({
          audio: this.wrapPcmAsWav(Buffer.concat(chunks, byteLength), sampleRate),
          requestId: taskId,
          transport: 'websocket',
          firstPackageMs,
        });
        cleanupSocketListeners();
        this.releaseRealtimeSocket(poolKey, socket);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimeout);
        if (!sessionResolved) rejectSession(error);
        rejectResult(error);
        cleanupSocketListeners();
        socket.terminate();
      };
      const send = (action: string, payload: Record<string, unknown>) => {
        if (settled || socket.readyState !== WebSocket.OPEN) {
          throw new Error('实时语音连接不可用');
        }
        socket.send(
          JSON.stringify({
            header: { action, task_id: taskId, streaming: 'duplex' },
            payload,
          }),
        );
        refreshTimeout();
      };
      const session = {
        taskId,
        pushText: (text: string) => {
          if (!taskStarted || finishSent) {
            throw new Error('实时语音任务尚未开始或已经结束');
          }
          send('continue-task', { input: { text } });
        },
        finish: () => {
          if (!finishSent && !settled) {
            finishSent = true;
            send('finish-task', { input: {} });
          }
          return result;
        },
        cancel: () => {
          if (settled) return;
          try {
            if (taskStarted && !finishSent) {
              finishSent = true;
              send('finish-task', { input: { directive: 'cancel' } });
            }
          } finally {
            fail(new Error('实时语音合成已取消'));
          }
        },
      };

      const handleMessage = (data: RawData, isBinary: boolean) => {
        if (settled) return;
        refreshTimeout();
        if (isBinary) {
          const chunk = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          if (receivedByteLength === 0) {
            try {
              streamCallbacks?.onRawPcmFirstPackage?.();
            } catch (error) {
              fail(
                error instanceof Error
                  ? error
                  : new Error('实时语音首包处理失败'),
              );
              return;
            }
          }
          receivedByteLength += chunk.length;
          if (receivedByteLength > 8 * 1024 * 1024) {
            fail(new Error('实时语音音频超过设备支持的 8MB 上限'));
            return;
          }
          for (const filteredChunk of leadingArtifactGate?.push(chunk) ?? [chunk]) {
            acceptPcm(filteredChunk);
            if (settled) break;
          }
          return;
        }

        let event: DashScopeRealtimeEvent;
        try {
          event = JSON.parse(data.toString()) as DashScopeRealtimeEvent;
        } catch {
          fail(new Error('实时语音服务返回了无效事件'));
          return;
        }
        if (event.header?.event === 'task-started') {
          taskStarted = true;
          sessionResolved = true;
          resolveSession(session);
          return;
        }
        if (event.header?.event === 'task-finished') {
          finish();
          return;
        }
        if (event.header?.event === 'task-failed') {
          fail(
            new Error(
              event.header.error_message ||
                event.header.error_code ||
                '实时语音合成失败',
            ),
          );
        }
      };
      const handleError = (error: Error) => fail(error);
      const handleClose = () => {
        if (!settled) fail(new Error('实时语音连接提前关闭'));
      };
      const cleanupSocketListeners = () => {
        socket.off('message', handleMessage);
        socket.off('error', handleError);
        socket.off('close', handleClose);
      };

      socket.on('message', handleMessage);
      socket.once('error', handleError);
      socket.once('close', handleClose);
      refreshTimeout();
      try {
        send('run-task', {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model,
          parameters: {
            text_type: 'PlainText',
            voice,
            format: 'pcm',
            sample_rate: sampleRate,
            volume: 50,
            rate: 1,
            pitch: 1,
            enable_ssml: false,
          },
          input: {},
        });
        this.logger.debug(
          `Realtime TTS task started task=${taskId} socket=${acquiredSocket.reused ? 'reused' : 'new'}`,
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error('实时语音任务启动失败'));
      }
    });
  }

  private async synthesizeRealtimeAudio(
    apiKey: string,
    model: string,
    voice: string,
    sampleRate: number,
    text: string,
    streamCallbacks?: RealtimeTtsStreamCallbacks,
  ): Promise<SynthesizedAudio> {
    const session = await this.openRealtimeSession(
      apiKey,
      model,
      voice,
      sampleRate,
      streamCallbacks,
    );
    session.pushText(text);
    return session.finish();
  }

  private realtimeSocketPoolKey(endpoint: string, apiKey: string) {
    const credentialHash = createHash('sha256')
      .update(apiKey)
      .digest('hex')
      .slice(0, 12);
    return `${endpoint}|${credentialHash}`;
  }

  private async acquireRealtimeSocket(
    poolKey: string,
    endpoint: string,
    apiKey: string,
  ): Promise<{ socket: WebSocket; reused: boolean }> {
    const pooled = this.realtimeSocketPool.get(poolKey);
    while (pooled?.length) {
      const socket = pooled.pop()!;
      const idleTimer = this.realtimeSocketIdleTimers.get(socket);
      if (idleTimer) clearTimeout(idleTimer);
      this.realtimeSocketIdleTimers.delete(socket);
      if (socket.readyState === WebSocket.OPEN) {
        return { socket, reused: true };
      }
      socket.terminate();
    }
    if (pooled?.length === 0) this.realtimeSocketPool.delete(poolKey);

    const socket = new WebSocket(endpoint, {
      headers: {
        authorization: `bearer ${apiKey}`,
        'X-DashScope-DataInspection': 'enable',
      },
    });
    // Keep idle pooled sockets from surfacing an unhandled EventEmitter error;
    // active tasks install their own error handler with full failure handling.
    socket.on('error', () => undefined);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.terminate();
        rejectPromise(new Error('实时语音 WebSocket 连接超时'));
      }, 10_000);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('open', handleOpen);
        socket.off('error', handleError);
        socket.off('close', handleClose);
      };
      const handleOpen = () => {
        cleanup();
        resolvePromise();
      };
      const handleError = (error: Error) => {
        cleanup();
        rejectPromise(error);
      };
      const handleClose = () => {
        cleanup();
        rejectPromise(new Error('实时语音 WebSocket 在连接时关闭'));
      };
      socket.once('open', handleOpen);
      socket.once('error', handleError);
      socket.once('close', handleClose);
    });
    return { socket, reused: false };
  }

  private releaseRealtimeSocket(poolKey: string, socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN) {
      socket.terminate();
      return;
    }
    const configuredIdleMs = Number(
      process.env.DASHSCOPE_TTS_WS_POOL_IDLE_MS || 60_000,
    );
    const idleMs = Number.isFinite(configuredIdleMs)
      ? Math.min(300_000, Math.max(5_000, configuredIdleMs))
      : 60_000;
    const sockets = this.realtimeSocketPool.get(poolKey) ?? [];
    sockets.push(socket);
    this.realtimeSocketPool.set(poolKey, sockets);
    const idleTimer = setTimeout(() => {
      this.realtimeSocketIdleTimers.delete(socket);
      const current = this.realtimeSocketPool.get(poolKey);
      if (current) {
        const index = current.indexOf(socket);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) this.realtimeSocketPool.delete(poolKey);
      }
      socket.close();
    }, idleMs);
    idleTimer.unref();
    this.realtimeSocketIdleTimers.set(socket, idleTimer);
  }

  private wrapPcmAsWav(pcm: Buffer, sampleRate: number) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm], 44 + pcm.length);
  }

  private async synthesizeHttpAudio(
    endpoint: string,
    apiKey: string,
    model: string,
    voice: string,
    format: string,
    sampleRate: number,
    text: string,
  ): Promise<SynthesizedAudio> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: { text, voice, format, sample_rate: sampleRate },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `连接阿里云语音服务失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    const payload = (await response.json().catch(() => ({}))) as DashScopeResponse;
    if (!response.ok) {
      this.logger.error(
        `DashScope TTS failed status=${response.status} requestId=${payload.request_id ?? 'unknown'} code=${payload.code ?? 'unknown'}`,
      );
      throw new ServiceUnavailableException(
        `阿里云语音生成失败：${payload.message || payload.code || response.status}`,
      );
    }
    const providerAudioUrl = payload.output?.audio?.url ?? payload.output?.url;
    if (!providerAudioUrl) {
      throw new ServiceUnavailableException('阿里云响应中没有音频地址');
    }
    const audioResponse = await fetch(providerAudioUrl);
    if (!audioResponse.ok) {
      throw new ServiceUnavailableException(
        `下载阿里云生成的音频失败：${audioResponse.status}`,
      );
    }
    return {
      audio: Buffer.from(await audioResponse.arrayBuffer()),
      requestId: payload.request_id ?? null,
      transport: 'http',
    };
  }

  normalizeForSpeech(text: string) {
    let withoutDirections = text;
    // Remove innermost bracketed stage directions repeatedly so nested forms
    // are handled as well. These annotations are display text and should never
    // be sent to TTS, regardless of their wording or position in the reply.
    for (let depth = 0; depth < 4; depth += 1) {
      const next = withoutDirections.replace(
        /（[^（）]*）|\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]/g,
        '',
      );
      if (next === withoutDirections) break;
      withoutDirections = next;
    }
    const stripped = withoutDirections
      .replace(/\s+/g, ' ')
      .replace(/\s*([，。！？、,.!?；;：:])\s*/g, '$1')
      .replace(/([，、；;：:])(?=[。！？.!?])/g, '')
      // A streamed model may begin with a hesitation before producing the
      // useful sentence. Keep the original assistant text for history, but
      // do not spend first-audio latency synthesizing a drawn-out filler.
      .replace(
        /^(?:(?:嗯+|啊+|呃+|额+|唔+)[…·—~～，。！？、,.!?；;：:\s]*)+/,
        '',
      )
      .trim();

    return stripped;
  }

  async readCachedAudio(fileName: string) {
    if (!/^[0-9a-f-]{36}\.wav$/i.test(fileName)) {
      throw new NotFoundException('音频不存在');
    }
    const filePath = resolve(this.cacheDirectory, fileName);
    try {
      const [buffer, fileStat] = await Promise.all([
        readFile(filePath),
        stat(filePath),
      ]);
      return { buffer, size: fileStat.size };
    } catch {
      throw new NotFoundException('音频不存在或已过期');
    }
  }
}
