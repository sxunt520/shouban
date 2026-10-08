import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import COS = require('cos-nodejs-sdk-v5');
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { Repository } from 'typeorm';
import { AlarmSound } from './contracts';
import { SynthesizeAlarmSoundDto } from './dto';
import { AlarmEntity, AlarmSoundEntity } from './entities';
import {
  buildAlarmCosObjectKey,
  isOpaqueAlarmCosObjectKey,
} from './alarm-storage';
import { TtsService } from './tts.service';

const ffmpegPath = require('ffmpeg-static') as string | null;

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MIN_CLONE_SAMPLE_BYTES = 10 * 24000 * 2;
const ALLOWED_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'mp4']);

@Injectable()
export class AlarmSoundService implements OnModuleInit {
  private readonly logger = new Logger(AlarmSoundService.name);
  private readonly directory = resolve(process.cwd(), '.data', 'alarm-sounds');
  private cosClient?: COS;

  constructor(
    @InjectRepository(AlarmSoundEntity)
    private readonly soundRepository: Repository<AlarmSoundEntity>,
    @InjectRepository(AlarmEntity)
    private readonly alarmRepository: Repository<AlarmEntity>,
    private readonly tts: TtsService,
  ) {}

  onModuleInit() {
    // Older recordings only existed on the API server. Move them to COS in the
    // background so all future alarm playback can bypass the API data path.
    setImmediate(() => {
      void this.migrateLegacyPlaybackFiles().catch((error) => {
        this.logger.warn(
          `Alarm playback migration deferred: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      });
    });
  }

  async list(userId: string): Promise<AlarmSound[]> {
    const sounds = await this.soundRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return sounds.map((sound) => this.toView(sound));
  }

  async uploadSource(
    userId: string,
    file: Express.Multer.File | undefined,
    requestedTitle?: string,
  ): Promise<AlarmSound> {
    if (!file?.buffer?.length) throw new BadRequestException('请选择音频文件');
    if (file.size > MAX_SOURCE_BYTES) {
      throw new BadRequestException('音频文件不能超过 12MB');
    }
    const extension = this.audioExtension(file.originalname, file.mimetype);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new BadRequestException('仅支持 WAV、MP3、M4A、AAC 音频');
    }

    const id = randomUUID();
    const title = (requestedTitle?.trim() || file.originalname.replace(/\.[^.]+$/, '') || '我的录音').slice(0, 120);
    const objectKey = buildAlarmCosObjectKey(extension);
    const uploaded = await this.putCosObject(objectKey, file.buffer, file.mimetype || `audio/${extension}`);
    await mkdir(this.directory, { recursive: true });
    const inputPath = resolve(this.directory, `${id}.source.${extension}`);
    const localFileName = `${id}.wav`;
    const outputPath = resolve(this.directory, localFileName);
    await writeFile(inputPath, file.buffer);
    try {
      await this.runFfmpeg([
        '-y', '-i', inputPath, '-vn', '-t', '60', '-ac', '1', '-ar', '24000',
        '-c:a', 'pcm_s16le', outputPath,
      ]);
    } finally {
      await unlink(inputPath).catch(() => undefined);
    }

    const outputObjectKey = buildAlarmCosObjectKey('wav');
    const normalizedAudio = await readFile(outputPath);
    const normalizedUpload = await this.putCosObject(
      outputObjectKey,
      normalizedAudio,
      'audio/wav',
    );

    const entity = this.soundRepository.create({
      id,
      userId,
      title,
      kind: 'recording',
      status: 'ready',
      sourceName: file.originalname.slice(0, 180),
      sourceMimeType: file.mimetype || `audio/${extension}`,
      sourceObjectKey: objectKey,
      sourceUrl: uploaded.url,
      outputObjectKey,
      outputUrl: normalizedUpload.url,
      localFileName,
      sourceLocalFileName: localFileName,
      text: null,
      voiceId: null,
      ttsModel: null,
      backgroundMusicId: null,
      errorMessage: null,
    });
    return this.toView(await this.soundRepository.save(entity));
  }

  async startSynthesis(
    userId: string,
    sourceId: string,
    dto: SynthesizeAlarmSoundDto,
  ): Promise<AlarmSound> {
    const source = await this.requireOwned(userId, sourceId);
    const sourceLocalFileName = source.sourceLocalFileName || source.localFileName;
    let normalizedSource: Buffer;
    try {
      normalizedSource = await readFile(resolve(this.directory, sourceLocalFileName));
    } catch {
      throw new BadRequestException('音色源文件不存在，请重新导入或录制');
    }
    if (normalizedSource.length < MIN_CLONE_SAMPLE_BYTES) {
      throw new BadRequestException('复刻音色需要至少 10 秒连续、清晰的人声；当前音频仍可直接用作闹铃');
    }
    const id = randomUUID();
    const result = this.soundRepository.create({
      id,
      userId,
      title: dto.title.trim(),
      kind: 'diy',
      status: 'processing',
      sourceName: source.sourceName,
      sourceMimeType: source.sourceMimeType,
      sourceObjectKey: source.sourceObjectKey,
      sourceUrl: source.sourceUrl,
      outputObjectKey: null,
      outputUrl: null,
      localFileName: `${id}.wav`,
      sourceLocalFileName,
      text: dto.text.trim(),
      voiceId: null,
      ttsModel: 'cosyvoice-v3.5-plus',
      backgroundMusicId: dto.backgroundMusicId || null,
      errorMessage: null,
    });
    const saved = await this.soundRepository.save(result);
    setImmediate(() => void this.processSynthesis(saved.id));
    return this.toView(saved);
  }

  async delete(userId: string, soundId: string) {
    const sound = await this.requireOwned(userId, soundId);
    const sharedSourceCount = await this.soundRepository.count({
      where: { sourceObjectKey: sound.sourceObjectKey },
    });
    const sharedOutputCount = sound.outputObjectKey
      ? await this.soundRepository.count({
          where: { outputObjectKey: sound.outputObjectKey },
        })
      : 0;
    const alarms = await this.alarmRepository.find({
      where: { userId, soundId },
    });
    const affectedDeviceIds = [...new Set(alarms.map((alarm) => alarm.deviceId))];
    if (alarms.length) await this.alarmRepository.remove(alarms);
    await this.soundRepository.remove(sound);
    const localFileIsSharedSource =
      sharedSourceCount > 1 && sound.sourceLocalFileName === sound.localFileName;
    if (!localFileIsSharedSource) {
      await unlink(resolve(this.directory, sound.localFileName)).catch(() => undefined);
    }
    if (sound.outputObjectKey && sharedOutputCount <= 1) {
      await this.deleteCosObject(sound.outputObjectKey);
    }
    if (sharedSourceCount <= 1) {
      if (sound.sourceLocalFileName && sound.sourceLocalFileName !== sound.localFileName) {
        await unlink(resolve(this.directory, sound.sourceLocalFileName)).catch(() => undefined);
      }
      await this.deleteCosObject(sound.sourceObjectKey);
    }
    return {
      deleted: true,
      soundId,
      deletedAlarms: alarms.length,
      affectedDeviceIds,
    };
  }

  async readForUser(userId: string, soundId: string) {
    const sound = await this.requireOwned(userId, soundId);
    return this.readLocal(sound);
  }

  async readForDevice(ownerUserId: string | null, soundId: string) {
    if (!ownerUserId) throw new NotFoundException('铃声不存在');
    const sound = await this.requireOwned(ownerUserId, soundId);
    return this.readLocal(sound);
  }

  async playbackUrlForUser(userId: string, soundId: string) {
    const playback = await this.resolvePlayback(userId, soundId);
    return {
      url: playback.audioPath,
      expiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
    };
  }

  async resolvePlayback(userId: string, soundId: string) {
    const sound = await this.requireOwned(userId, soundId);
    if (sound.status !== 'ready') {
      throw new ServiceUnavailableException(
        sound.status === 'failed' ? sound.errorMessage || '铃声生成失败' : '铃声仍在生成中',
      );
    }
    const outputObjectKey = await this.ensureCloudPlayback(sound);
    return {
      // This is generated just before the command is issued. It is deliberately
      // not persisted because signed URLs expire; soundId/objectKey stay stable.
      audioPath: this.signedCosUrl(outputObjectKey),
      text: sound.text,
      voiceId: sound.voiceId,
      model: sound.ttsModel,
      source: sound.kind === 'diy' ? 'custom-diy' : 'custom-recording',
    };
  }

  private async processSynthesis(soundId: string) {
    const sound = await this.soundRepository.findOne({ where: { id: soundId } });
    if (!sound || sound.status !== 'processing' || !sound.text) return;
    const cloneSamplePath = resolve(this.directory, `${sound.id}.clone-sample.wav`);
    let cloneSampleObjectKey: string | null = null;
    try {
      // The original upload remains available for direct alarm playback. Voice
      // enrollment gets a separate, normalized 20-second WAV so large source
      // files stay below DashScope's 10 MB cloning limit.
      if (!sound.sourceLocalFileName) throw new Error('音色源文件不存在，请重新导入或录制');
      await this.runFfmpeg([
        '-y', '-i', resolve(this.directory, sound.sourceLocalFileName), '-vn', '-t', '20',
        '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', cloneSamplePath,
      ]);
      const cloneSample = await readFile(cloneSamplePath);
      cloneSampleObjectKey = buildAlarmCosObjectKey('wav');
      await this.putCosObject(cloneSampleObjectKey, cloneSample, 'audio/wav');
      const signedSourceUrl = this.signedCosUrl(cloneSampleObjectKey);
      const voice = await this.tts.cloneVoice(
        signedSourceUrl,
        `a${sound.id.replace(/-/g, '').slice(0, 9)}`,
        'cosyvoice-v3.5-plus',
      );
      const speech = await this.tts.synthesize(sound.text, voice.voiceId, voice.model);
      const ttsFileName = speech.audioPath.split('/').pop();
      if (!ttsFileName) throw new Error('TTS 音频地址无效');
      const speechAudio = await this.tts.readCachedAudio(ttsFileName);
      const outputPath = resolve(this.directory, sound.localFileName);
      await mkdir(this.directory, { recursive: true });
      if (sound.backgroundMusicId) {
        await this.mixBackground(speechAudio.buffer, outputPath, sound.backgroundMusicId);
      } else {
        await writeFile(outputPath, speechAudio.buffer);
      }
      const outputBuffer = await readFile(outputPath);
      const outputObjectKey = buildAlarmCosObjectKey('wav');
      const uploaded = await this.putCosObject(outputObjectKey, outputBuffer, 'audio/wav');
      sound.voiceId = voice.voiceId;
      sound.ttsModel = voice.model;
      sound.outputObjectKey = outputObjectKey;
      sound.outputUrl = uploaded.url;
      sound.status = 'ready';
      sound.errorMessage = null;
      await this.soundRepository.save(sound);
      this.logger.log(`DIY alarm sound ready id=${sound.id} voice=${voice.voiceId}`);
    } catch (error) {
      sound.status = 'failed';
      sound.errorMessage = (error instanceof Error ? error.message : '铃声生成失败').slice(0, 500);
      await this.soundRepository.save(sound);
      this.logger.error(`DIY alarm sound failed id=${sound.id}: ${sound.errorMessage}`);
    } finally {
      await unlink(cloneSamplePath).catch(() => undefined);
      if (cloneSampleObjectKey) await this.deleteCosObject(cloneSampleObjectKey);
    }
  }

  private async mixBackground(buffer: Buffer, outputPath: string, backgroundMusicId: string) {
    const voicePath = `${outputPath}.voice.wav`;
    await writeFile(voicePath, buffer);
    const expression = backgroundMusicId === 'morning-chime'
      ? '0.045*sin(2*PI*523.25*t)+0.035*sin(2*PI*659.25*t)+0.025*sin(2*PI*783.99*t)'
      : '0.04*sin(2*PI*261.63*t)+0.03*sin(2*PI*329.63*t)+0.025*sin(2*PI*392*t)';
    try {
      await this.runFfmpeg([
        '-y', '-i', voicePath,
        '-f', 'lavfi', '-i', `aevalsrc=${expression}:d=60:s=24000`,
        '-filter_complex', '[1:a]volume=0.55[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]',
        '-map', '[out]', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', outputPath,
      ]);
    } finally {
      await unlink(voicePath).catch(() => undefined);
    }
  }

  private async readLocal(sound: AlarmSoundEntity) {
    if (sound.status !== 'ready') throw new NotFoundException('铃声尚未生成完成');
    try {
      const buffer = await readFile(resolve(this.directory, sound.localFileName));
      return { buffer, size: buffer.length };
    } catch {
      if (!sound.outputObjectKey) throw new NotFoundException('铃声文件不存在');
      try {
        const buffer = await this.getCosObject(sound.outputObjectKey);
        await mkdir(this.directory, { recursive: true });
        await writeFile(resolve(this.directory, sound.localFileName), buffer).catch(
          () => undefined,
        );
        return { buffer, size: buffer.length };
      } catch {
        throw new NotFoundException('铃声文件不存在');
      }
    }
  }

  private async ensureCloudPlayback(sound: AlarmSoundEntity) {
    if (
      sound.outputObjectKey &&
      isOpaqueAlarmCosObjectKey(sound.outputObjectKey, 'wav')
    ) {
      return sound.outputObjectKey;
    }
    const previousObjectKey = sound.outputObjectKey;
    const localPath = resolve(this.directory, sound.localFileName);
    let buffer: Buffer;
    try {
      buffer = await readFile(localPath);
    } catch {
      if (!sound.outputObjectKey) {
        throw new NotFoundException('铃声文件不存在，无法迁移到云端');
      }
      try {
        buffer = await this.getCosObject(sound.outputObjectKey);
      } catch {
        throw new NotFoundException('铃声文件不存在，无法迁移到云端');
      }
    }
    const objectKey = buildAlarmCosObjectKey('wav');
    const uploaded = await this.putCosObject(objectKey, buffer, 'audio/wav');
    sound.outputObjectKey = objectKey;
    sound.outputUrl = uploaded.url;
    await this.soundRepository.save(sound);
    await this.deleteUnreferencedObject(previousObjectKey, 'outputObjectKey');
    this.logger.log(`Alarm playback migrated to COS id=${sound.id} key=${objectKey}`);
    return objectKey;
  }

  private async ensureCloudSource(sound: AlarmSoundEntity) {
    if (isOpaqueAlarmCosObjectKey(sound.sourceObjectKey)) return;
    const previousObjectKey = sound.sourceObjectKey;
    const extension = this.audioExtension(
      previousObjectKey,
      sound.sourceMimeType || '',
    ) || 'wav';
    const buffer = await this.getCosObject(previousObjectKey);
    const objectKey = buildAlarmCosObjectKey(extension);
    const uploaded = await this.putCosObject(
      objectKey,
      buffer,
      sound.sourceMimeType || `audio/${extension}`,
    );
    sound.sourceObjectKey = objectKey;
    sound.sourceUrl = uploaded.url;
    await this.soundRepository.save(sound);
    await this.deleteUnreferencedObject(previousObjectKey, 'sourceObjectKey');
    this.logger.log(`Alarm source migrated to COS id=${sound.id} key=${objectKey}`);
  }

  private async deleteUnreferencedObject(
    objectKey: string | null,
    column: 'sourceObjectKey' | 'outputObjectKey',
  ) {
    if (!objectKey) return;
    const references = await this.soundRepository.count({
      where: { [column]: objectKey },
    });
    if (references === 0) await this.deleteCosObject(objectKey);
  }

  private async migrateLegacyPlaybackFiles() {
    const sounds = await this.soundRepository.find();
    for (const sound of sounds) {
      try {
        await this.ensureCloudSource(sound);
        if (sound.status === 'ready') await this.ensureCloudPlayback(sound);
      } catch (error) {
        this.logger.warn(
          `Alarm playback migration deferred id=${sound.id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private async requireOwned(userId: string, soundId: string) {
    const sound = await this.soundRepository.findOne({ where: { id: soundId, userId } });
    if (!sound) throw new NotFoundException('铃声不存在');
    return sound;
  }

  private async putCosObject(key: string, body: Buffer, contentType: string) {
    const { bucket, region } = this.cosConfig();
    const result = await this.cos().putObject({
      Bucket: bucket,
      Region: region,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
    });
    return { url: `https://${result.Location}` };
  }

  private async getCosObject(key: string) {
    const { bucket, region } = this.cosConfig();
    const result = await this.cos().getObject({
      Bucket: bucket,
      Region: region,
      Key: key,
    });
    return result.Body;
  }

  private signedCosUrl(key: string) {
    const { bucket, region } = this.cosConfig();
    return this.cos().getObjectUrl({
      Bucket: bucket,
      Region: region,
      Key: key,
      Sign: true,
      Expires: 3600,
      Protocol: 'https:',
    });
  }

  private async deleteCosObject(key: string) {
    const { bucket, region } = this.cosConfig();
    try {
      await this.cos().deleteObject({ Bucket: bucket, Region: region, Key: key });
    } catch (error) {
      this.logger.warn(
        `COS cleanup failed key=${key}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private cos() {
    if (this.cosClient) return this.cosClient;
    const secretId = process.env.TENCENT_COS_SECRET_ID?.trim();
    const secretKey = process.env.TENCENT_COS_SECRET_KEY?.trim();
    if (!secretId || !secretKey) {
      throw new ServiceUnavailableException('腾讯 COS 密钥尚未配置');
    }
    this.cosClient = new COS({ SecretId: secretId, SecretKey: secretKey });
    return this.cosClient;
  }

  private cosConfig() {
    const bucket = process.env.TENCENT_COS_BUCKET?.trim();
    const region = process.env.TENCENT_COS_REGION?.trim();
    if (!bucket || !region) {
      throw new ServiceUnavailableException('腾讯 COS 存储桶或地域尚未配置');
    }
    return { bucket, region };
  }

  private audioExtension(fileName: string, mimeType: string) {
    const fromName = extname(fileName).slice(1).toLowerCase();
    if (fromName) return fromName === 'mpeg' ? 'mp3' : fromName;
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
    if (mimeType.includes('aac')) return 'aac';
    return '';
  }

  private runFfmpeg(args: string[]) {
    const executable = ffmpegPath;
    if (!executable) {
      throw new ServiceUnavailableException('服务器缺少 FFmpeg，无法处理音频');
    }
    return new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        executable,
        ['-hide_banner', '-loglevel', 'error', ...args],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let errorOutput = '';
      child.stderr.on('data', (chunk: Buffer) => {
        errorOutput = `${errorOutput}${String(chunk)}`.slice(-2000);
      });
      child.on('error', reject);
      child.on('close', (code: number | null) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`音频处理失败：${errorOutput.trim() || `FFmpeg ${code}`}`));
      });
    });
  }

  private toView(sound: AlarmSoundEntity): AlarmSound {
    return {
      id: sound.id,
      title: sound.title,
      kind: sound.kind,
      status: sound.status,
      sourceName: sound.sourceName,
      sourceMimeType: sound.sourceMimeType,
      sourceObjectKey: sound.sourceObjectKey,
      sourceUrl: sound.sourceUrl,
      outputObjectKey: sound.outputObjectKey,
      outputUrl: sound.outputUrl,
      text: sound.text,
      voiceId: sound.voiceId,
      ttsModel: sound.ttsModel,
      backgroundMusicId: sound.backgroundMusicId,
      errorMessage: sound.errorMessage,
      createdAt: sound.createdAt.toISOString(),
      updatedAt: sound.updatedAt.toISOString(),
    };
  }
}
