import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { In, IsNull, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import {
  Alarm,
  AlarmSyncStatus,
  Character,
  ConversationMessage,
  DeviceView,
  User,
} from './contracts';
import {
  BindDeviceDto,
  CreateAlarmDto,
  CreateReminderDto,
  DeviceMessageDto,
  DeviceSessionDto,
  HeartbeatDto,
  UpdateAlarmDto,
  UpdateReminderDto,
} from './dto';
import {
  AlarmEntity,
  CharacterEntity,
  ConversationMessageEntity,
  DeviceCommandEntity,
  DeviceEntity,
  DeviceEventEntity,
  DeviceSessionEntity,
  ReminderEntity,
  UserEntity,
} from './entities';
import { TtsService } from './tts.service';
import { AsrService, RealtimeAsrResult } from './asr.service';
import { AiChatService } from './ai-chat.service';
import { AlarmSoundService } from './alarm-sound.service';
import { SpeechChunker } from './speech-chunker';

interface ConversationSpeechTurn {
  id: string;
  characterId: string;
  source: string;
  cancelled: boolean;
  cancelRealtimeTts?: () => void;
}

const VOICE_REPLY_PROMPT =
  '这是语音对话。请用自然、简短、完整的句子直接回答。首句优先用8到18个字表达完整意思，并以句号、问号或叹号结束；不要用“嗯”“啊”“呃”或省略号拖音开场，不要输出括号内的动作、神态或声音描写，不要为了抢播拆成几个零碎短句。';
// Debounce the first unpunctuated fragment instead of starting a one-shot
// timer on the first model delta. Providers often split a natural sentence
// like `我在呢，有什么...` immediately before the comma; a short quiet
// window lets the following clause arrive without adding much latency when
// the model genuinely pauses.
const FIRST_SPEECH_FRAGMENT_DELAY_MS = 200;
const FIRST_SPEECH_FRAGMENT_MIN_CHARS = 8;
const FIRST_SPEECH_FRAGMENT_MAX_CHARS = 16;

export type DeviceRealtimeReplyEvent =
  | { type: 'reply.started'; conversationTurnId: string }
  | { type: 'reply.text.delta'; delta: string }
  | {
      type: 'reply.audio';
      commandId: string;
      conversationTurnId: string;
      sequence: number;
      text: string;
      audioPath: string;
      audioFormat: string;
      sampleRate: number;
      audioData?: Buffer;
      audioStreamId?: string;
    }
  | {
      type: 'reply.audio.stream.start';
      streamId: string;
      conversationTurnId: string;
      sequence: number;
      sampleRate: number;
      channels: 1;
      format: 'pcm_s16le';
    }
  | {
      type: 'reply.audio.stream.chunk';
      streamId: string;
      audioData: Buffer;
    }
  | {
      type: 'reply.audio.stream.end';
      streamId: string;
      audioBytes: number;
    }
  | {
      type: 'reply.completed';
      conversationTurnId: string;
      assistantMessageId: string;
      chunkCount: number;
    }
  | { type: 'reply.error'; message: string };

type DeviceRealtimeReplyEmitter = ((event: DeviceRealtimeReplyEvent) => void) & {
  supportsPcmStream?: boolean;
};

@Injectable()
export class StoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StoreService.name);
  private readonly demoUser: User = {
    id: 'user-demo',
    displayName: '体验账号',
  };
  private readonly appTokens = new Map<string, string>([
    ['demo-app-token', this.demoUser.id],
  ]);
  private reminderTimer?: NodeJS.Timeout;
  private reminderTickRunning = false;
  private alarmTickRunning = false;
  private readonly reminderRetryAfter = new Map<string, number>();
  private readonly alarmRetryAfter = new Map<string, number>();
  private readonly conversationChains = new Map<string, Promise<void>>();
  private readonly conversationSpeechTurns = new Map<
    string,
    ConversationSpeechTurn
  >();

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(CharacterEntity)
    private readonly characterRepository: Repository<CharacterEntity>,
    @InjectRepository(ConversationMessageEntity)
    private readonly conversationRepository: Repository<ConversationMessageEntity>,
    @InjectRepository(DeviceEntity)
    private readonly deviceRepository: Repository<DeviceEntity>,
    @InjectRepository(DeviceSessionEntity)
    private readonly sessionRepository: Repository<DeviceSessionEntity>,
    @InjectRepository(ReminderEntity)
    private readonly reminderRepository: Repository<ReminderEntity>,
    @InjectRepository(AlarmEntity)
    private readonly alarmRepository: Repository<AlarmEntity>,
    @InjectRepository(DeviceCommandEntity)
    private readonly commandRepository: Repository<DeviceCommandEntity>,
    @InjectRepository(DeviceEventEntity)
    private readonly eventRepository: Repository<DeviceEventEntity>,
    private readonly tts: TtsService,
    private readonly asr: AsrService,
    private readonly aiChat: AiChatService,
    private readonly alarmSounds: AlarmSoundService,
  ) {}

  async onModuleInit() {
    await this.seedDevelopmentData();
    this.reminderTimer = setInterval(() => {
      void this.triggerDueReminders();
      void this.triggerDueAlarms();
    }, 1000);
  }

  onModuleDestroy() {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
  }

  loginDemo() {
    return { accessToken: 'demo-app-token', user: this.demoUser };
  }

  getUserForToken(token: string | null): User | null {
    if (!token) return null;
    const userId = this.appTokens.get(token);
    return userId === this.demoUser.id ? this.demoUser : null;
  }

  async getDeviceForToken(token: string | null): Promise<DeviceEntity | null> {
    if (!token) return null;
    const session = await this.sessionRepository.findOne({
      where: { tokenHash: this.hash(token) },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    return this.deviceRepository.findOne({ where: { id: session.deviceId } });
  }

  async listCharacters(): Promise<Character[]> {
    const characters = await this.characterRepository.find({
      order: { createdAt: 'ASC' },
    });
    return characters.map((item) => this.toCharacter(item));
  }

  async updateCharacterPrompt(
    userId: string,
    characterId: string,
    prompt: string,
  ): Promise<Character> {
    void userId;
    const character = await this.requireCharacter(characterId);
    character.prompt = prompt.trim();
    return this.toCharacter(await this.characterRepository.save(character));
  }

  async bindCharacterNfcTag(
    userId: string,
    characterId: string,
    rawUid: string,
  ): Promise<Character> {
    const [character, uid] = await Promise.all([
      this.requireCharacter(characterId),
      Promise.resolve(this.normalizeNfcUid(rawUid)),
    ]);
    const conflict = await this.characterRepository.findOne({
      where: { nfcTagUid: uid },
    });
    if (conflict && conflict.id !== character.id) {
      throw new ConflictException(`该标签已经绑定角色“${conflict.name}”`);
    }
    character.nfcTagUid = uid;
    const saved = await this.characterRepository.save(character);

    const activeDevices = await this.deviceRepository.find({
      where: { ownerUserId: userId, lastNfcTagUid: uid },
    });
    for (const device of activeDevices) {
      const switched = device.characterId !== saved.id;
      device.characterId = saved.id;
      device.lastNfcMatchedCharacterId = saved.id;
      await this.deviceRepository.save(device);
      if (switched) {
        await this.commandRepository.delete({
          deviceId: device.id,
          type: 'sync_character',
          acknowledgedAt: IsNull(),
        });
        await this.enqueueCommand(device.id, 'sync_character', {
          character: this.toDeviceCharacter(saved),
          source: 'nfc_bind',
          nfcTagUid: uid,
        });
        void this.enqueueNfcWelcome(device.id, saved);
      }
    }

    return this.toCharacter(saved);
  }

  async unbindCharacterNfcTag(
    userId: string,
    characterId: string,
  ): Promise<Character> {
    void userId;
    const character = await this.requireCharacter(characterId);
    character.nfcTagUid = null;
    return this.toCharacter(await this.characterRepository.save(character));
  }

  async listDevices(userId: string): Promise<DeviceView[]> {
    const devices = await this.deviceRepository.find({
      where: { ownerUserId: userId },
      order: { createdAt: 'ASC' },
    });
    const characters = await this.characterRepository.find();
    return devices.map((device) => this.toDeviceView(device, characters));
  }

  async getDevice(userId: string, deviceId: string): Promise<DeviceView> {
    const device = await this.requireOwnedDevice(userId, deviceId);
    return this.toDeviceView(device, await this.characterRepository.find());
  }

  async bindDevice(userId: string, dto: BindDeviceDto): Promise<DeviceView> {
    const pairingCode = dto.pairingCode.trim().toUpperCase();
    const device = await this.deviceRepository.findOne({ where: { pairingCode } });
    if (!device) throw new NotFoundException('绑定码不存在');
    if (device.ownerUserId && device.ownerUserId !== userId) {
      throw new ConflictException('该设备已经绑定其他账号');
    }
    const character = dto.characterId
      ? await this.requireCharacter(dto.characterId)
      : null;
    device.ownerUserId = userId;
    if (character) device.characterId = character.id;
    if (dto.name?.trim()) device.name = dto.name.trim();
    await this.deviceRepository.save(device);
    if (character) {
      await this.enqueueCommand(device.id, 'sync_character', {
        character: this.toDeviceCharacter(character),
      });
    }
    return this.toDeviceView(device, await this.characterRepository.find());
  }

  async unbindDevice(userId: string, deviceId: string) {
    const device = await this.requireOwnedDevice(userId, deviceId);

    // Old reminders and queued speech must never reach a future owner. Chat
    // history remains scoped to the old user and is intentionally preserved.
    await this.reminderRepository.update(
      { userId, deviceId, enabled: true },
      { enabled: false },
    );
    await this.alarmRepository.update(
      { userId, deviceId, enabled: true },
      { enabled: false },
    );
    await this.commandRepository.delete({
      deviceId,
      acknowledgedAt: IsNull(),
    });
    device.ownerUserId = null;
    device.characterId = null;
    device.lastNfcTagUid = null;
    device.lastNfcAt = null;
    device.lastNfcMatchedCharacterId = null;
    await this.deviceRepository.save(device);

    return { unbound: true, deviceId };
  }

  async updateCharacter(userId: string, deviceId: string, characterId: string) {
    const [device, character] = await Promise.all([
      this.requireOwnedDevice(userId, deviceId),
      this.requireCharacter(characterId),
    ]);
    if (device.characterId !== character.id) {
      await this.cancelPendingConversationSpeech(device.id, 'character_switched');
    }
    device.characterId = character.id;
    await this.deviceRepository.save(device);
    await this.enqueueCommand(device.id, 'sync_character', {
      character: this.toDeviceCharacter(character),
    });
    return this.toDeviceView(device, await this.characterRepository.find());
  }

  async updateDeviceName(userId: string, deviceId: string, name: string) {
    const nextName = name.trim();
    if (!nextName) throw new BadRequestException('设备名称不能为空');
    const device = await this.requireOwnedDevice(userId, deviceId);
    device.name = nextName;
    await this.deviceRepository.save(device);
    return this.toDeviceView(device, await this.characterRepository.find());
  }

  async updateVolume(userId: string, deviceId: string, volume: number) {
    const device = await this.requireOwnedDevice(userId, deviceId);
    device.volume = volume;
    await this.deviceRepository.save(device);
    await this.enqueueCommand(device.id, 'set_volume', { volume });
    return this.toDeviceView(device, await this.characterRepository.find());
  }

  async speakText(userId: string, deviceId: string, text: string) {
    const device = await this.requireOwnedDevice(userId, deviceId);
    const character = device.characterId
      ? await this.requireCharacter(device.characterId)
      : null;
    const speech = await this.tts.synthesize(
      text,
      character?.voiceId,
      character?.ttsModel,
    );
    return this.enqueueCommand(device.id, 'speak_text', {
      text,
      characterId: character?.id ?? null,
      voiceId: speech.voice,
      audioPath: speech.audioPath,
      audioFormat: speech.format,
      sampleRate: speech.sampleRate,
      provider: speech.provider,
      ttsModel: speech.model,
    });
  }

  async startListening(userId: string, deviceId: string) {
    const device = await this.requireOwnedDevice(userId, deviceId);
    const pending = await this.commandRepository.findOne({
      where: {
        deviceId: device.id,
        type: 'start_listening',
        acknowledgedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });
    if (pending) return pending;
    return this.enqueueCommand(device.id, 'start_listening', {
      durationMs: 10000,
      sampleRate: 16000,
      format: 'pcm_s16le',
      transport: 'websocket',
      fallbackTransport: 'wav_http',
      source: 'app',
      stopMode: 'vad',
    });
  }

  async listDeviceCommands(userId: string, deviceId: string) {
    await this.requireOwnedDevice(userId, deviceId);
    return this.commandRepository.find({
      where: { deviceId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
  }

  async listDeviceEvents(userId: string, deviceId: string) {
    await this.requireOwnedDevice(userId, deviceId);
    return this.eventRepository.find({
      where: { deviceId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
  }

  async getAlarmSyncStatus(
    userId: string,
    deviceId: string,
  ): Promise<AlarmSyncStatus> {
    await this.requireOwnedDevice(userId, deviceId);
    const command = await this.commandRepository.findOne({
      where: { deviceId, type: 'sync_alarms' },
      order: { createdAt: 'DESC' },
    });
    if (!command) {
      return {
        state: 'idle',
        revision: null,
        commandId: null,
        totalEnabled: 0,
        cachedCount: 0,
        message: null,
        updatedAt: null,
      };
    }

    const revision = typeof command.payload.revision === 'string'
      ? command.payload.revision
      : null;
    const totalEnabled = typeof command.payload.totalEnabled === 'number'
      ? command.payload.totalEnabled
      : 0;
    const events = revision
      ? await this.eventRepository.find({
          where: {
            deviceId,
            type: In([
              'alarm_sync_started',
              'alarm_sync_completed',
              'alarm_sync_failed',
            ]),
          },
          order: { createdAt: 'DESC' },
          take: 30,
        })
      : [];
    const event = events.find((item) => item.payload.revision === revision);
    const cachedCount = event && typeof event.payload.cachedCount === 'number'
      ? event.payload.cachedCount
      : command.acknowledgedAt ? totalEnabled : 0;
    const message = event && typeof event.payload.message === 'string'
      ? event.payload.message
      : null;
    const state: AlarmSyncStatus['state'] = event?.type === 'alarm_sync_completed'
      ? 'synced'
      : command.acknowledgedAt
      ? 'synced'
      : event?.type === 'alarm_sync_failed'
        ? 'failed'
        : event?.type === 'alarm_sync_started'
          ? 'syncing'
          : 'pending';
    return {
      state,
      revision,
      commandId: command.id,
      totalEnabled,
      cachedCount,
      message,
      updatedAt: (event?.createdAt ?? command.acknowledgedAt ?? command.createdAt)
        .toISOString(),
    };
  }

  async retryAlarmSync(userId: string, deviceId: string) {
    await this.requireOwnedDevice(userId, deviceId);
    await this.queueAlarmSyncForDevice(deviceId, userId);
    return this.getAlarmSyncStatus(userId, deviceId);
  }

  async listConversationMessages(
    userId: string,
    deviceId: string,
    before?: string,
    requestedLimit = 30,
  ): Promise<ConversationMessage[]> {
    const device = await this.requireOwnedDevice(userId, deviceId);
    if (!device.characterId) return [];
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(50, Math.trunc(requestedLimit)))
      : 30;
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && Number.isNaN(beforeDate.getTime())) {
      throw new BadRequestException('历史消息游标无效');
    }
    const messages = await this.conversationRepository.find({
      where: {
        userId,
        deviceId,
        characterId: device.characterId,
        ...(beforeDate ? { createdAt: LessThan(beforeDate) } : {}),
      },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return messages.reverse().map((message) => this.toConversationMessage(message));
  }

  async streamAppConversationMessage(
    userId: string,
    deviceId: string,
    text: string,
    clientRequestId: string | undefined,
    emit: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ) {
    const device = await this.requireOwnedDevice(userId, deviceId);
    if (!device.characterId) {
      throw new BadRequestException('设备尚未绑定角色');
    }
    const character = await this.requireCharacter(device.characterId);
    const normalizedText = text.trim();
    if (!normalizedText) throw new BadRequestException('消息不能为空');
    const normalizedRequestId = clientRequestId?.trim();
    if (normalizedRequestId && !/^[A-Za-z0-9_-]{8,20}$/.test(normalizedRequestId)) {
      throw new BadRequestException('客户端请求编号格式无效');
    }
    const source = normalizedRequestId
      ? `app:${normalizedRequestId}`
      : 'app_text_stream';

    const existingMessages = normalizedRequestId
      ? await this.conversationRepository.find({
          where: {
            userId,
            deviceId,
            characterId: character.id,
            source,
          },
          order: { createdAt: 'ASC' },
        })
      : [];
    let userMessage = existingMessages.find((message) => message.role === 'user');
    const completedMessage = existingMessages.find(
      (message) => message.role === 'assistant',
    );
    if (userMessage) {
      emit({ type: 'message.created', message: this.toConversationMessage(userMessage) });
    }
    if (completedMessage) {
      emit({
        type: 'message.completed',
        message: this.toConversationMessage(completedMessage),
        provider: 'cached',
        requestId: normalizedRequestId ?? null,
      });
      return;
    }

    if (!userMessage) {
      userMessage = await this.conversationRepository.save(
        this.conversationRepository.create({
          userId,
          deviceId,
          characterId: character.id,
          role: 'user',
          content: normalizedText,
          source,
        }),
      );
      emit({ type: 'message.created', message: this.toConversationMessage(userMessage) });
    }
    this.logger.debug(
      `App conversation stream accepted device=${deviceId} character=${character.id} request=${normalizedRequestId ?? 'none'}`,
    );

    const recentMessages = await this.conversationRepository.find({
      where: { userId, deviceId, characterId: character.id },
      order: { createdAt: 'DESC' },
      take: 16,
    });
    recentMessages.reverse();
    const basePrompt =
      character.prompt?.trim() ||
      `你是${character.name}。${character.description}请始终以这个角色的身份，用自然、简短的中文回答。`;
    this.logger.debug(
      `App conversation history ready device=${deviceId} messages=${recentMessages.length} request=${normalizedRequestId ?? 'none'}`,
    );

    const speechTurn = await this.beginAppConversationSpeech(
      device,
      character,
      source,
      userMessage.id,
    );
    const prompt = speechTurn
      ? `${basePrompt}\n${VOICE_REPLY_PROMPT}`
      : basePrompt;
    const speechChunker = speechTurn ? new SpeechChunker() : null;
    let speechSequence = 0;
    let assistantMessageId: string | null = null;
    let responseModel = process.env.AI_MODEL?.trim() || 'MiniMax-M2.7';
    let speechChain = Promise.resolve();
    let firstSpeechFragmentTimer: NodeJS.Timeout | undefined;
    const conversationStartedAt = Date.now();
    let firstDeltaLogged = false;
    const clearFirstSpeechFragmentTimer = () => {
      if (!firstSpeechFragmentTimer) return;
      clearTimeout(firstSpeechFragmentTimer);
      firstSpeechFragmentTimer = undefined;
    };
    const queueSpeechChunks = (chunks: string[]) => {
      if (!speechTurn) return;
      for (const chunk of chunks) {
        const spokenText = this.tts.normalizeForSpeech(chunk);
        if (!spokenText) continue;
        const sequence = speechSequence;
        speechSequence += 1;
        speechChain = speechChain.then(() =>
          this.prepareAppConversationSpeechChunk(
            device,
            character,
            speechTurn,
            spokenText,
            sequence,
            assistantMessageId,
            userMessage.id,
            responseModel,
          ),
        );
      }
      if (speechSequence > 0) clearFirstSpeechFragmentTimer();
    };
    const scheduleFirstSpeechFragment = () => {
      if (!speechChunker || speechSequence > 0) return;
      clearFirstSpeechFragmentTimer();
      firstSpeechFragmentTimer = setTimeout(() => {
        firstSpeechFragmentTimer = undefined;
        if (speechSequence > 0) return;
        const chunks = speechChunker.takeEarlyFragment(
          FIRST_SPEECH_FRAGMENT_MIN_CHARS,
          FIRST_SPEECH_FRAGMENT_MAX_CHARS,
        );
        if (chunks.length > 0) {
          this.logger.debug(
            `App conversation early speech fragment device=${device.id} chars=${this.tts.normalizeForSpeech(chunks[0]).length} elapsedMs=${Date.now() - conversationStartedAt}`,
          );
          queueSpeechChunks(chunks);
        }
      }, FIRST_SPEECH_FRAGMENT_DELAY_MS);
    };

    let reply: Awaited<ReturnType<AiChatService['stream']>>;
    try {
      reply = await this.aiChat.stream(
        prompt,
        recentMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        (delta) => {
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            this.logger.log(
              `App conversation first AI delta device=${device.id} elapsedMs=${Date.now() - conversationStartedAt}`,
            );
          }
          emit({ type: 'message.delta', delta });
          if (speechChunker) {
            queueSpeechChunks(speechChunker.push(delta));
            scheduleFirstSpeechFragment();
          }
        },
        signal,
      );
    } catch (error) {
      clearFirstSpeechFragmentTimer();
      if (speechTurn) {
        await this.cancelPendingConversationSpeech(
          device.id,
          signal?.aborted ? 'stream_cancelled' : 'stream_failed',
        );
      }
      throw error;
    }
    clearFirstSpeechFragmentTimer();
    responseModel = reply.model;
    if (speechChunker) queueSpeechChunks(speechChunker.flush());
    const assistantMessage = await this.conversationRepository.save(
      this.conversationRepository.create({
        userId,
        deviceId,
        characterId: character.id,
        role: 'assistant',
        content: reply.content,
        source,
      }),
    );
    assistantMessageId = assistantMessage.id;
    emit({
      type: 'message.completed',
      message: this.toConversationMessage(assistantMessage),
      provider: reply.model,
      requestId: reply.requestId,
    });
    if (speechTurn) {
      void speechChain
        .then(() =>
          this.finishAppConversationSpeech(
            device.id,
            speechTurn,
            assistantMessage.id,
            speechSequence,
          ),
        )
        .catch((error) =>
          this.failAppConversationSpeech(
            device.id,
            speechTurn,
            assistantMessage.id,
            error,
          ),
        );
    }
  }

  private async beginAppConversationSpeech(
    device: DeviceEntity,
    character: CharacterEntity,
    source: string,
    userMessageId: string,
  ) {
    if (!this.isDeviceOnline(device)) {
      await this.eventRepository.save(
        this.eventRepository.create({
          deviceId: device.id,
          type: 'conversation_speech_skipped',
          payload: {
            source,
            userMessageId,
            characterId: character.id,
            reason: 'device_offline',
          },
        }),
      );
      this.logger.log(
        `Skipping app conversation speech for offline device=${device.id} message=${userMessageId}`,
      );
      return null;
    }

    await this.cancelPendingConversationSpeech(device.id, 'superseded');
    const turn: ConversationSpeechTurn = {
      id: randomUUID(),
      characterId: character.id,
      source,
      cancelled: false,
    };
    this.conversationSpeechTurns.set(device.id, turn);
    await this.eventRepository.save(
      this.eventRepository.create({
        deviceId: device.id,
        type: 'conversation_speech_started',
        payload: {
          source,
          conversationTurnId: turn.id,
          userMessageId,
          characterId: character.id,
        },
      }),
    );
    return turn;
  }

  private async prepareAppConversationSpeechChunk(
    device: DeviceEntity,
    character: CharacterEntity,
    turn: ConversationSpeechTurn,
    text: string,
    sequence: number,
    assistantMessageId: string | null,
    userMessageId: string,
    aiModel: string,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    if (!this.isConversationSpeechTurnActive(device.id, turn)) return;
    try {
      const ttsStartedAt = Date.now();
      const audioStreamId = emitReply?.supportsPcmStream ? randomUUID() : null;
      const audioStreamSampleRate = Number(
        process.env.DASHSCOPE_TTS_SAMPLE_RATE || 24000,
      );
      let audioStreamStarted = false;
      let streamedAudioBytes = 0;
      this.logger.debug(
        `App conversation TTS started device=${device.id} turn=${turn.id} sequence=${sequence} chars=${text.length}`,
      );
      const speech = await this.tts.synthesize(
        text,
        character.voiceId,
        character.ttsModel,
        audioStreamId
          ? {
              onPcmChunk: (chunk) => {
                if (!audioStreamStarted) {
                  audioStreamStarted = true;
                  this.emitDeviceRealtimeReply(emitReply, {
                    type: 'reply.audio.stream.start',
                    streamId: audioStreamId,
                    conversationTurnId: turn.id,
                    sequence,
                    sampleRate: audioStreamSampleRate,
                    channels: 1,
                    format: 'pcm_s16le',
                  });
                }
                streamedAudioBytes += chunk.length;
                this.emitDeviceRealtimeReply(emitReply, {
                  type: 'reply.audio.stream.chunk',
                  streamId: audioStreamId,
                  audioData: chunk,
                });
              },
            }
          : undefined,
      );
      if (audioStreamStarted && audioStreamId) {
        this.emitDeviceRealtimeReply(emitReply, {
          type: 'reply.audio.stream.end',
          streamId: audioStreamId,
          audioBytes: streamedAudioBytes,
        });
      }
      if (!this.isConversationSpeechTurnActive(device.id, turn)) return;
      const currentDevice = await this.deviceRepository.findOne({
        where: { id: device.id },
      });
      if (
        currentDevice?.ownerUserId !== device.ownerUserId ||
        currentDevice.characterId !== character.id ||
        !this.isDeviceOnline(currentDevice) ||
        !this.isConversationSpeechTurnActive(device.id, turn)
      ) {
        this.logger.log(
          `Skipping stale app conversation speech chunk device=${device.id} turn=${turn.id} sequence=${sequence}`,
        );
        return;
      }

      const command = await this.enqueueCommand(device.id, 'speak_text', {
        text,
        characterId: character.id,
        voiceId: speech.voice,
        audioPath: speech.audioPath,
        audioFormat: speech.format,
        sampleRate: speech.sampleRate,
        provider: speech.provider,
        ttsModel: speech.model,
        aiModel,
        conversationMessageId: assistantMessageId,
        userMessageId,
        conversationTurnId: turn.id,
        sequence,
        source: 'app_conversation_stream_chunk',
      });
      if (!this.isConversationSpeechTurnActive(device.id, turn)) {
        command.acknowledgedAt = new Date();
        await this.commandRepository.save(command);
        return;
      }
      await this.eventRepository.save(
        this.eventRepository.create({
          deviceId: device.id,
          type: 'conversation_speech_chunk_ready',
          payload: {
            source: turn.source,
            conversationTurnId: turn.id,
            sequence,
            text,
            assistantMessageId,
            userMessageId,
            commandId: command.id,
            characterId: character.id,
            audioPath: speech.audioPath,
            voiceId: speech.voice,
            ttsModel: speech.model,
          },
        }),
      );
      this.emitDeviceRealtimeReply(emitReply, {
        type: 'reply.audio',
        commandId: command.id,
        conversationTurnId: turn.id,
        sequence,
        text,
        audioPath: speech.audioPath,
        audioFormat: speech.format,
        sampleRate: speech.sampleRate,
        audioData: audioStreamStarted ? undefined : speech.audio,
        audioStreamId: audioStreamStarted ? audioStreamId ?? undefined : undefined,
      });
      this.logger.log(
        `App conversation speech chunk queued device=${device.id} turn=${turn.id} sequence=${sequence} chars=${text.length} ttsMs=${Date.now() - ttsStartedAt}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Unable to prepare app conversation speech chunk device=${device.id} turn=${turn.id} sequence=${sequence}: ${message}`,
      );
      await this.eventRepository
        .save(
          this.eventRepository.create({
            deviceId: device.id,
            type: 'conversation_speech_chunk_failed',
            payload: {
              source: turn.source,
              conversationTurnId: turn.id,
              sequence,
              assistantMessageId,
              userMessageId,
              characterId: character.id,
              message,
            },
          }),
        )
        .catch(() => undefined);
    }
  }

  private async completeContinuousConversationSpeech(
    device: DeviceEntity,
    character: CharacterEntity,
    turn: ConversationSpeechTurn,
    text: string,
    chunkCount: number,
    assistantMessageId: string,
    userMessageId: string,
    aiModel: string,
    audioStreamId: string,
    audioStreamStarted: boolean,
    streamedAudioBytes: number,
    speech: Awaited<ReturnType<TtsService['synthesize']>>,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    if (audioStreamStarted) {
      this.emitDeviceRealtimeReply(emitReply, {
        type: 'reply.audio.stream.end',
        streamId: audioStreamId,
        audioBytes: streamedAudioBytes,
      });
    }
    if (!this.isConversationSpeechTurnActive(device.id, turn)) return;
    const currentDevice = await this.deviceRepository.findOne({
      where: { id: device.id },
    });
    if (
      currentDevice?.ownerUserId !== device.ownerUserId ||
      currentDevice.characterId !== character.id ||
      !this.isDeviceOnline(currentDevice) ||
      !this.isConversationSpeechTurnActive(device.id, turn)
    ) {
      this.logger.log(
        `Skipping stale continuous conversation speech device=${device.id} turn=${turn.id}`,
      );
      return;
    }

    const command = await this.enqueueCommand(device.id, 'speak_text', {
      text,
      characterId: character.id,
      voiceId: speech.voice,
      audioPath: speech.audioPath,
      audioFormat: speech.format,
      sampleRate: speech.sampleRate,
      provider: speech.provider,
      ttsModel: speech.model,
      aiModel,
      conversationMessageId: assistantMessageId,
      userMessageId,
      conversationTurnId: turn.id,
      sequence: 0,
      source: 'device_conversation_continuous_tts',
    });
    if (!this.isConversationSpeechTurnActive(device.id, turn)) {
      command.acknowledgedAt = new Date();
      await this.commandRepository.save(command);
      return;
    }
    await this.eventRepository.save(
      this.eventRepository.create({
        deviceId: device.id,
        type: 'conversation_speech_chunk_ready',
        payload: {
          source: turn.source,
          conversationTurnId: turn.id,
          sequence: 0,
          chunkCount,
          text,
          assistantMessageId,
          userMessageId,
          commandId: command.id,
          characterId: character.id,
          audioPath: speech.audioPath,
          voiceId: speech.voice,
          ttsModel: speech.model,
          transport: 'continuous_pcm',
        },
      }),
    );
    this.emitDeviceRealtimeReply(emitReply, {
      type: 'reply.audio',
      commandId: command.id,
      conversationTurnId: turn.id,
      sequence: 0,
      text,
      audioPath: speech.audioPath,
      audioFormat: speech.format,
      sampleRate: speech.sampleRate,
      audioData: audioStreamStarted ? undefined : speech.audio,
      audioStreamId: audioStreamStarted ? audioStreamId : undefined,
    });
    this.logger.log(
      `Continuous conversation speech queued device=${device.id} turn=${turn.id} chunks=${chunkCount} bytes=${streamedAudioBytes}`,
    );
  }

  private isConversationSpeechTurnActive(
    deviceId: string,
    turn: ConversationSpeechTurn,
  ) {
    return (
      !turn.cancelled && this.conversationSpeechTurns.get(deviceId) === turn
    );
  }

  private async finishAppConversationSpeech(
    deviceId: string,
    turn: ConversationSpeechTurn,
    assistantMessageId: string,
    chunkCount: number,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    if (!this.isConversationSpeechTurnActive(deviceId, turn)) return;
    this.conversationSpeechTurns.delete(deviceId);
    await this.eventRepository.save(
      this.eventRepository.create({
        deviceId,
        type: 'conversation_speech_queued',
        payload: {
          source: turn.source,
          conversationTurnId: turn.id,
          assistantMessageId,
          characterId: turn.characterId,
          chunkCount,
        },
      }),
    );
    this.emitDeviceRealtimeReply(emitReply, {
      type: 'reply.completed',
      conversationTurnId: turn.id,
      assistantMessageId,
      chunkCount,
    });
  }

  private emitDeviceRealtimeReply(
    emitReply: DeviceRealtimeReplyEmitter | undefined,
    event: DeviceRealtimeReplyEvent,
  ) {
    if (!emitReply) return;
    try {
      emitReply(event);
    } catch (error) {
      this.logger.warn(
        `Unable to emit realtime reply event type=${event.type}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async failAppConversationSpeech(
    deviceId: string,
    turn: ConversationSpeechTurn,
    assistantMessageId: string,
    error: unknown,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    if (this.conversationSpeechTurns.get(deviceId) === turn) {
      this.conversationSpeechTurns.delete(deviceId);
    }
    const message = error instanceof Error ? error.message : 'unknown error';
    this.logger.warn(
      `Conversation speech pipeline failed device=${deviceId} turn=${turn.id}: ${message}`,
    );
    this.emitDeviceRealtimeReply(emitReply, {
      type: 'reply.error',
      message,
    });
    await this.eventRepository
      .save(
        this.eventRepository.create({
          deviceId,
          type: 'conversation_speech_failed',
          payload: {
            source: turn.source,
            conversationTurnId: turn.id,
            assistantMessageId,
            characterId: turn.characterId,
            message,
          },
        }),
      )
      .catch(() => undefined);
  }

  listReminders(userId: string, deviceId?: string) {
    return this.reminderRepository.find({
      where: deviceId ? { userId, deviceId } : { userId },
      order: { scheduledAt: 'ASC' },
    });
  }

  async createReminder(userId: string, dto: CreateReminderDto) {
    await this.requireOwnedDevice(userId, dto.deviceId);
    const scheduledAt = new Date(dto.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('提醒时间格式不正确');
    }
    return this.reminderRepository.save(
      this.reminderRepository.create({
        userId,
        deviceId: dto.deviceId,
        title: dto.title.trim(),
        scheduledAt,
        repeat: dto.repeat ?? 'none',
        kind: dto.kind ?? 'reminder',
        enabled: true,
        lastTriggeredAt: null,
      }),
    );
  }

  async updateReminder(userId: string, reminderId: string, dto: UpdateReminderDto) {
    const reminder = await this.requireReminder(userId, reminderId);
    if (dto.title !== undefined) reminder.title = dto.title.trim();
    if (dto.scheduledAt !== undefined) {
      reminder.scheduledAt = new Date(dto.scheduledAt);
      reminder.lastTriggeredAt = null;
    }
    if (dto.repeat !== undefined) reminder.repeat = dto.repeat;
    if (dto.kind !== undefined) reminder.kind = dto.kind;
    if (dto.enabled !== undefined) reminder.enabled = dto.enabled;
    return this.reminderRepository.save(reminder);
  }

  async deleteReminder(userId: string, reminderId: string) {
    const reminder = await this.requireReminder(userId, reminderId);
    await this.reminderRepository.remove(reminder);
    return { deleted: true };
  }

  async listAlarms(userId: string, deviceId?: string): Promise<Alarm[]> {
    if (deviceId) await this.requireOwnedDevice(userId, deviceId);
    const alarms = await this.alarmRepository.find({
      where: deviceId ? { userId, deviceId } : { userId },
      order: { hour: 'ASC', minute: 'ASC', createdAt: 'ASC' },
    });
    return alarms.map((alarm) => this.toAlarm(alarm));
  }

  async createAlarm(userId: string, dto: CreateAlarmDto): Promise<Alarm> {
    await this.requireOwnedDevice(userId, dto.deviceId);
    const alarm = this.alarmRepository.create({
      userId,
      deviceId: dto.deviceId,
      hour: dto.hour,
      minute: dto.minute,
      days: [...dto.days].sort(),
      enabled: dto.enabled ?? true,
      snoozeEnabled: dto.snoozeEnabled,
      snoozeMinutes: dto.snoozeMinutes,
      snoozeCount: dto.snoozeCount,
      themeId: dto.themeId.trim(),
      useThemeSound: dto.useThemeSound,
      soundTitle: dto.soundTitle.trim(),
      soundId: dto.soundId?.trim() || null,
      timezone: dto.timezone?.trim() || 'Asia/Shanghai',
      nextTriggeredAt: null,
      snoozeScheduledAt: null,
      snoozeUsedCount: 0,
      lifecycleStatus: 'scheduled',
      ringingStartedAt: null,
      lastDismissedAt: null,
      lastTriggeredAt: null,
    });
    alarm.nextTriggeredAt = this.nextAlarmOccurrence(alarm, new Date());
    const saved = await this.alarmRepository.save(alarm);
    await this.queueAlarmSyncForDevice(saved.deviceId, userId);
    return this.toAlarm(saved);
  }

  async updateAlarm(
    userId: string,
    alarmId: string,
    dto: UpdateAlarmDto,
  ): Promise<Alarm> {
    const alarm = await this.requireAlarm(userId, alarmId);
    const wasEnabled = alarm.enabled;
    const scheduleChanged =
      dto.hour !== undefined ||
      dto.minute !== undefined ||
      dto.days !== undefined ||
      dto.timezone !== undefined;

    if (dto.hour !== undefined) alarm.hour = dto.hour;
    if (dto.minute !== undefined) alarm.minute = dto.minute;
    if (dto.days !== undefined) alarm.days = [...dto.days].sort();
    if (dto.enabled !== undefined) alarm.enabled = dto.enabled;
    if (dto.snoozeEnabled !== undefined) alarm.snoozeEnabled = dto.snoozeEnabled;
    if (dto.snoozeMinutes !== undefined) alarm.snoozeMinutes = dto.snoozeMinutes;
    if (dto.snoozeCount !== undefined) alarm.snoozeCount = dto.snoozeCount;
    if (dto.themeId !== undefined) alarm.themeId = dto.themeId.trim();
    if (dto.useThemeSound !== undefined) alarm.useThemeSound = dto.useThemeSound;
    if (dto.soundTitle !== undefined) alarm.soundTitle = dto.soundTitle.trim();
    if (dto.soundId !== undefined) alarm.soundId = dto.soundId?.trim() || null;
    if (dto.timezone !== undefined) alarm.timezone = dto.timezone.trim();
    if (scheduleChanged) {
      alarm.lastTriggeredAt = null;
      alarm.snoozeScheduledAt = null;
      alarm.snoozeUsedCount = 0;
      alarm.lifecycleStatus = 'scheduled';
      alarm.ringingStartedAt = null;
      alarm.nextTriggeredAt = this.nextAlarmOccurrence(alarm, new Date());
    }
    if (dto.enabled === true && (!wasEnabled || !alarm.nextTriggeredAt)) {
      alarm.nextTriggeredAt = this.nextAlarmOccurrence(alarm, new Date());
    }
    if (dto.enabled === false) {
      alarm.snoozeScheduledAt = null;
      alarm.lifecycleStatus = 'scheduled';
      alarm.ringingStartedAt = null;
    }

    const saved = await this.alarmRepository.save(alarm);
    await this.queueAlarmSyncForDevice(saved.deviceId, userId);
    return this.toAlarm(saved);
  }

  async snoozeAlarm(userId: string, alarmId: string): Promise<Alarm> {
    const alarm = await this.requireAlarm(userId, alarmId);
    if (!alarm.enabled) throw new BadRequestException('闹钟已关闭');
    const device = await this.requireOwnedDevice(userId, alarm.deviceId);
    const result = await this.scheduleAlarmSnooze(device, { alarmId });
    if (!result.snoozeAccepted) {
      const reason = result.snoozeReason === 'limit_reached'
        ? '已达到稍后提醒次数上限'
        : '这个闹钟没有开启稍后提醒';
      throw new BadRequestException(reason);
    }
    await this.enqueueCommand(device.id, 'control_alarm', {
      action: 'snooze',
      alarmId: alarm.id,
    });
    return this.toAlarm(await this.requireAlarm(userId, alarmId));
  }

  async dismissAlarm(userId: string, alarmId: string): Promise<Alarm> {
    const alarm = await this.requireAlarm(userId, alarmId);
    alarm.lifecycleStatus = 'scheduled';
    alarm.ringingStartedAt = null;
    alarm.snoozeScheduledAt = null;
    alarm.lastDismissedAt = new Date();
    this.alarmRetryAfter.delete(alarm.id);
    await this.cancelPendingAlarmCommands(alarm);
    const saved = await this.alarmRepository.save(alarm);
    await this.enqueueCommand(alarm.deviceId, 'control_alarm', {
      action: 'stop',
      alarmId: alarm.id,
    });
    return this.toAlarm(saved);
  }

  async deleteAlarm(userId: string, alarmId: string) {
    const alarm = await this.requireAlarm(userId, alarmId);
    const deviceId = alarm.deviceId;
    await this.cancelPendingAlarmCommands(alarm);
    await this.alarmRepository.remove(alarm);
    await this.queueAlarmSyncForDevice(deviceId, userId);
    return { deleted: true, alarmId };
  }

  async createDeviceSession(dto: DeviceSessionDto) {
    const device = await this.deviceRepository.findOne({
      where: { hardwareId: dto.hardwareId },
    });
    if (!device || device.deviceSecretHash !== this.hash(dto.deviceSecret)) {
      throw new NotFoundException('未登记的硬件或密钥错误');
    }
    await this.sessionRepository.delete({ expiresAt: LessThanOrEqual(new Date()) });
    const token = randomUUID();
    await this.sessionRepository.save(
      this.sessionRepository.create({
        tokenHash: this.hash(token),
        deviceId: device.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
    return {
      accessToken: token,
      expiresInSeconds: 86400,
      device: {
        id: device.id,
        pairingCode: device.pairingCode,
        bound: Boolean(device.ownerUserId),
      },
    };
  }

  async heartbeat(device: DeviceEntity, dto: HeartbeatDto) {
    const firmwareChanged = Boolean(
      dto.firmwareVersion && dto.firmwareVersion !== device.firmwareVersion,
    );
    device.lastSeenAt = new Date();
    if (dto.firmwareVersion) device.firmwareVersion = dto.firmwareVersion;
    if (dto.volume !== undefined) device.volume = dto.volume;
    await this.deviceRepository.save(device);
    if (firmwareChanged && device.ownerUserId) {
      void this.queueAlarmSyncForDevice(device.id, device.ownerUserId).catch(
        (error) => {
          this.logger.warn(
            `Unable to queue alarm sync after firmware change device=${device.id}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        },
      );
    }
    return {
      serverTime: new Date().toISOString(),
      bound: Boolean(device.ownerUserId),
      characterId: device.characterId,
      pendingCommandCount: await this.countPendingCommands(device),
    };
  }

  async getPendingCommands(device: DeviceEntity) {
    await this.expireStaleAlarmCommands(device);
    return this.commandRepository.find({
      where: { deviceId: device.id, acknowledgedAt: IsNull() },
      order: { createdAt: 'ASC' },
      take: 1,
    });
  }

  async countPendingCommands(device: DeviceEntity) {
    await this.expireStaleAlarmCommands(device);
    return this.commandRepository.count({
      where: { deviceId: device.id, acknowledgedAt: IsNull() },
    });
  }

  async acknowledgeCommand(device: DeviceEntity, commandId: string) {
    const command = await this.commandRepository.findOne({
      where: { id: commandId, deviceId: device.id },
    });
    if (!command) throw new NotFoundException('设备指令不存在');
    command.acknowledgedAt = new Date();
    await this.commandRepository.save(command);
    return { acknowledged: true };
  }

  async interruptDeviceConversation(
    device: DeviceEntity,
    reason = 'device_barge_in',
  ) {
    const cancellation = await this.cancelPendingConversationSpeech(
      device.id,
      reason,
    );
    await this.eventRepository.save(
      this.eventRepository.create({
        deviceId: device.id,
        type: 'conversation_interrupted',
        payload: { reason, ...cancellation },
      }),
    );
    return cancellation;
  }

  private async expireStaleAlarmCommands(device: DeviceEntity) {
    const pending = await this.commandRepository.find({
      where: { deviceId: device.id, type: 'play_reminder', acknowledgedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
    const now = Date.now();
    const expired = pending.filter((command) => {
      const explicitExpiry = typeof command.payload.expiresAt === 'string'
        ? new Date(command.payload.expiresAt).getTime()
        : Number.NaN;
      const expiry = Number.isFinite(explicitExpiry)
        ? explicitExpiry
        : command.createdAt.getTime() + 2 * 60_000;
      return expiry <= now;
    });
    if (!expired.length) return;

    for (const command of expired) {
      command.acknowledgedAt = new Date();
      const alarmId = typeof command.payload.alarmId === 'string'
        ? command.payload.alarmId
        : null;
      if (alarmId) {
        const alarm = await this.alarmRepository.findOne({
          where: { id: alarmId, deviceId: device.id },
        });
        if (alarm?.lifecycleStatus === 'ringing') {
          alarm.lifecycleStatus = 'scheduled';
          alarm.ringingStartedAt = null;
          await this.alarmRepository.save(alarm);
        }
      }
      await this.eventRepository.save(this.eventRepository.create({
        deviceId: device.id,
        type: 'alarm_command_expired',
        payload: { commandId: command.id, alarmId },
      }));
    }
    await this.commandRepository.save(expired);
    this.logger.warn(`Expired ${expired.length} stale alarm command(s) for device=${device.id}`);
  }

  private async cancelPendingAlarmCommands(alarm: AlarmEntity) {
    const commands = await this.commandRepository.find({
      where: {
        deviceId: alarm.deviceId,
        type: 'play_reminder',
        acknowledgedAt: IsNull(),
      },
    });
    const matching = commands.filter((command) => command.payload.alarmId === alarm.id);
    if (!matching.length) return;
    const cancelledAt = new Date();
    for (const command of matching) command.acknowledgedAt = cancelledAt;
    await this.commandRepository.save(matching);
  }

  private async cancelPendingConversationSpeech(
    deviceId: string,
    reason: string,
  ) {
    const activeTurn = this.conversationSpeechTurns.get(deviceId);
    if (activeTurn) {
      activeTurn.cancelled = true;
      activeTurn.cancelRealtimeTts?.();
      this.conversationSpeechTurns.delete(deviceId);
    }

    const commands = await this.commandRepository.find({
      where: {
        deviceId,
        type: 'speak_text',
        acknowledgedAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
    });
    const matching = commands.filter((command) => {
      const source =
        typeof command.payload.source === 'string' ? command.payload.source : '';
      return (
        source === 'app_conversation_stream' ||
        source === 'app_conversation_stream_chunk' ||
        source === 'device_conversation_continuous_tts' ||
        source === 'ai_conversation'
      );
    });
    if (matching.length) {
      const cancelledAt = new Date();
      for (const command of matching) command.acknowledgedAt = cancelledAt;
      await this.commandRepository.save(matching);
    }
    if (activeTurn || matching.length) {
      this.logger.log(
        `Conversation speech cancelled device=${deviceId} reason=${reason} pending=${matching.length}`,
      );
    }
    return {
      speechCancellationReason: reason,
      cancelledConversationTurnId: activeTurn?.id ?? null,
      cancelledSpeechCommandCount: matching.length,
    };
  }

  async receiveDeviceEvent(
    device: DeviceEntity,
    type: string,
    payload: Record<string, unknown> = {},
  ) {
    device.lastSeenAt = new Date();
    let eventPayload = payload;
    let matchedCharacter: CharacterEntity | null = null;
    let switched = false;

    if (type === 'nfc_tag_present') {
      if (typeof payload.uid !== 'string') {
        throw new BadRequestException('NFC 事件缺少 uid');
      }
      const uid = this.normalizeNfcUid(payload.uid);
      matchedCharacter = await this.characterRepository.findOne({
        where: { nfcTagUid: uid },
      });
      if (matchedCharacter && device.ownerUserId) {
        switched = device.characterId !== matchedCharacter.id;
        if (switched) {
          const cancellation = await this.cancelPendingConversationSpeech(
            device.id,
            'nfc_character_switched',
          );
          device.characterId = matchedCharacter.id;
          // Keep only the newest physical selection when the device was offline.
          await this.commandRepository.delete({
            deviceId: device.id,
            type: 'sync_character',
            acknowledgedAt: IsNull(),
          });
          await this.enqueueCommand(device.id, 'sync_character', {
            character: this.toDeviceCharacter(matchedCharacter),
            source: 'nfc',
            nfcTagUid: uid,
          });
          eventPayload = { ...eventPayload, ...cancellation };
        }
      }
      device.lastNfcTagUid = uid;
      device.lastNfcAt = new Date();
      device.lastNfcMatchedCharacterId = matchedCharacter?.id ?? null;
      eventPayload = {
        ...eventPayload,
        ...payload,
        uid,
        matched: Boolean(matchedCharacter),
        characterId: matchedCharacter?.id ?? null,
        characterName: matchedCharacter?.name ?? null,
        switched,
        deviceBound: Boolean(device.ownerUserId),
      };
    } else if (type === 'nfc_tag_removed') {
      const uid =
        typeof payload.uid === 'string'
          ? this.normalizeNfcUid(payload.uid)
          : device.lastNfcTagUid;
      if (uid && device.lastNfcTagUid === uid) {
        device.lastNfcTagUid = null;
        device.lastNfcMatchedCharacterId = null;
      }
      device.lastNfcAt = new Date();
      eventPayload = {
        ...payload,
        uid,
        present: false,
      };
    } else if (
      type === 'button_pressed' &&
      payload.commandType === 'stop_playback'
    ) {
      eventPayload = {
        ...payload,
        ...(await this.cancelPendingConversationSpeech(
          device.id,
          'function_button',
        )),
      };
    } else if (
      type === 'button_pressed' &&
      payload.commandType === 'snooze_reminder'
    ) {
      eventPayload = {
        ...payload,
        ...(await this.scheduleAlarmSnooze(device, payload)),
      };
    } else if (
      (type === 'alarm_playback_started' || type === 'alarm_playback_completed') &&
      typeof payload.alarmId === 'string'
    ) {
      const alarm = await this.alarmRepository.findOne({
        where: { id: payload.alarmId, deviceId: device.id, enabled: true },
      });
      if (alarm) {
        if (type === 'alarm_playback_started') {
          alarm.lifecycleStatus = 'ringing';
          alarm.ringingStartedAt = new Date();
        } else if (alarm.lifecycleStatus !== 'snoozing') {
          alarm.lifecycleStatus = 'scheduled';
          alarm.ringingStartedAt = null;
          alarm.lastDismissedAt = new Date();
        }
        await this.alarmRepository.save(alarm);
        eventPayload = { ...payload, alarmStateUpdated: true };
      }
    }

    const event = this.eventRepository.create({
      deviceId: device.id,
      type,
      payload: eventPayload,
    });
    const [, savedEvent] = await Promise.all([
      this.deviceRepository.save(device),
      this.eventRepository.save(event),
    ]);
    if (type === 'nfc_tag_present' && switched && matchedCharacter) {
      void this.enqueueNfcWelcome(device.id, matchedCharacter);
    }
    return {
      accepted: true,
      event: { type, payload: eventPayload, receivedAt: savedEvent.createdAt },
      nfcMatch:
        type === 'nfc_tag_present'
          ? {
              uid: eventPayload.uid,
              characterId: matchedCharacter?.id ?? null,
              characterName: matchedCharacter?.name ?? null,
              switched,
            }
          : undefined,
    };
  }

  async receiveDeviceRecording(
    device: DeviceEntity,
    commandId: string | undefined,
    body: unknown,
  ) {
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException('请求体必须是 WAV 二进制音频');
    }
    const normalizedCommandId = commandId?.trim() || null;
    if (normalizedCommandId) {
      const command = await this.commandRepository.findOne({
        where: {
          id: normalizedCommandId,
          deviceId: device.id,
          type: 'start_listening',
        },
      });
      if (!command) {
        throw new NotFoundException('录音指令不存在或不属于该设备');
      }
    }

    const recognition = await this.asr.recognizeWav(body);
    device.lastSeenAt = new Date();
    const eventType = recognition.text ? 'speech_recognized' : 'speech_empty';
    const event = this.eventRepository.create({
      deviceId: device.id,
      type: eventType,
      payload: {
        commandId: normalizedCommandId,
        source: normalizedCommandId ? 'app' : 'device_button',
        text: recognition.text,
        provider: recognition.provider,
        taskId: recognition.taskId,
        durationMs: recognition.durationMs,
        sampleRate: recognition.sampleRate,
      },
    });
    await Promise.all([
      this.deviceRepository.save(device),
      this.eventRepository.save(event),
    ]);
    if (recognition.text) {
      this.queueConversation(
        device.id,
        recognition.text,
        normalizedCommandId ? 'app_voice' : 'device_button_voice',
      );
    }
    return {
      accepted: true,
      commandId: normalizedCommandId,
      ...recognition,
    };
  }

  async receiveDevicePcmStream(
    device: DeviceEntity,
    commandId: string | undefined,
    pcm: Buffer,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    const recognition = await this.asr.recognizePcm16(pcm);
    return this.receiveDevicePcmRecognition(
      device,
      commandId,
      recognition,
      'websocket_pcm_batch_fallback',
      emitReply,
    );
  }

  async receiveDeviceRealtimeRecognition(
    device: DeviceEntity,
    commandId: string | undefined,
    recognition: RealtimeAsrResult,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    return this.receiveDevicePcmRecognition(
      device,
      commandId,
      recognition,
      'websocket_pcm_realtime',
      emitReply,
    );
  }

  private async receiveDevicePcmRecognition(
    device: DeviceEntity,
    commandId: string | undefined,
    recognition: Awaited<ReturnType<AsrService['recognizePcm16']>> | RealtimeAsrResult,
    transport: 'websocket_pcm_realtime' | 'websocket_pcm_batch_fallback',
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    const normalizedCommandId = commandId?.trim() || null;
    if (normalizedCommandId) {
      const command = await this.commandRepository.findOne({
        where: {
          id: normalizedCommandId,
          deviceId: device.id,
          type: 'start_listening',
        },
      });
      if (!command) {
        throw new NotFoundException('录音指令不存在或不属于该设备');
      }
    }

    device.lastSeenAt = new Date();
    const source = normalizedCommandId
      ? 'app_voice_websocket'
      : 'device_button_voice_websocket';
    const event = this.eventRepository.create({
      deviceId: device.id,
      type: recognition.text ? 'speech_recognized' : 'speech_empty',
      payload: {
        commandId: normalizedCommandId,
        source,
        transport,
        text: recognition.text,
        provider: recognition.provider,
        taskId: recognition.taskId,
        durationMs: recognition.durationMs,
        sampleRate: recognition.sampleRate,
        firstPartialMs:
          'firstPartialMs' in recognition ? recognition.firstPartialMs : null,
        recognitionElapsedMs:
          'recognitionElapsedMs' in recognition
            ? recognition.recognitionElapsedMs
            : null,
        finalizationElapsedMs:
          'finalizationElapsedMs' in recognition
            ? recognition.finalizationElapsedMs
            : null,
      },
    });
    await Promise.all([
      this.deviceRepository.save(device),
      this.eventRepository.save(event),
    ]);
    if (recognition.text) {
      this.queueConversation(device.id, recognition.text, source, emitReply);
    }
    return {
      accepted: true,
      commandId: normalizedCommandId,
      ...recognition,
    };
  }

  async replyToDeviceMessage(device: DeviceEntity, dto: DeviceMessageDto) {
    device.lastSeenAt = new Date();
    await this.deviceRepository.save(device);
    const result = await this.createConversationReply(
      device.id,
      dto.text.trim(),
      'device_text',
    );
    return {
      conversationId: `conversation-${device.id}`,
      text: result.reply.content,
      characterId: result.character.id,
      voiceId: result.speech.voice,
      audioUrl: result.speech.audioPath,
      provider: result.reply.model,
    };
  }

  private queueConversation(
    deviceId: string,
    text: string,
    source: string,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    const previous = this.conversationChains.get(deviceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.createStreamingConversationReply(
            deviceId,
            text,
            source,
            emitReply,
          );
        } catch (error) {
          this.emitDeviceRealtimeReply(emitReply, {
            type: 'reply.error',
            message:
              error instanceof Error ? error.message : 'AI 对话处理失败',
          });
          this.logger.error(
            `Conversation failed device=${deviceId}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
          await this.eventRepository.save(
            this.eventRepository.create({
              deviceId,
              type: 'conversation_failed',
              payload: {
                source,
                message:
                  error instanceof Error ? error.message : 'AI 对话处理失败',
              },
            }),
          );
        }
      })
      .finally(() => {
        if (this.conversationChains.get(deviceId) === next) {
          this.conversationChains.delete(deviceId);
        }
      });
    this.conversationChains.set(deviceId, next);
  }

  private async createStreamingConversationReply(
    deviceId: string,
    text: string,
    source: string,
    emitReply?: DeviceRealtimeReplyEmitter,
  ) {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device?.ownerUserId) throw new BadRequestException('设备尚未绑定用户');
    if (!device.characterId) throw new BadRequestException('设备尚未绑定角色');
    const character = await this.requireCharacter(device.characterId);
    const userMessage = await this.conversationRepository.save(
      this.conversationRepository.create({
        userId: device.ownerUserId,
        deviceId: device.id,
        characterId: character.id,
        role: 'user',
        content: text,
        source,
      }),
    );
    const recentMessages = await this.conversationRepository.find({
      where: {
        userId: device.ownerUserId,
        deviceId: device.id,
        characterId: character.id,
      },
      order: { createdAt: 'DESC' },
      take: 16,
    });
    recentMessages.reverse();
    const basePrompt =
      character.prompt?.trim() ||
      `你是${character.name}。${character.description}请始终以这个角色的身份，用自然、简短、适合语音播放的中文回答。`;
    const speechTurn = await this.beginAppConversationSpeech(
      device,
      character,
      source,
      userMessage.id,
    );
    if (speechTurn) {
      this.emitDeviceRealtimeReply(emitReply, {
        type: 'reply.started',
        conversationTurnId: speechTurn.id,
      });
    }
    const prompt = speechTurn
      ? `${basePrompt}\n${VOICE_REPLY_PROMPT}`
      : basePrompt;
    const chunker = speechTurn ? new SpeechChunker() : null;
    let sequence = 0;
    let assistantMessageId: string | null = null;
    let aiModel = process.env.AI_MODEL?.trim() || 'MiniMax-M2.7';
    let speechChain = Promise.resolve();
    let firstSpeechFragmentTimer: NodeJS.Timeout | undefined;
    const conversationStartedAt = Date.now();
    let firstDeltaLogged = false;
    const useContinuousTts = Boolean(
      speechTurn && emitReply?.supportsPcmStream,
    );
    const continuousAudioStreamId = useContinuousTts ? randomUUID() : null;
    const continuousSessionRequestedAt = Date.now();
    let continuousAudioStreamStarted = false;
    let continuousStreamedAudioBytes = 0;
    let continuousTtsFailed = false;
    let continuousTextSubmitted = false;
    const continuousTtsSession =
      useContinuousTts && speechTurn && continuousAudioStreamId
        ? this.tts.createRealtimeSession(
            character.voiceId,
            character.ttsModel,
            {
              onRawPcmFirstPackage: () => {
                this.logger.log(
                  `Device conversation raw TTS first package device=${device.id} turn=${speechTurn.id} elapsedMs=${Date.now() - conversationStartedAt}`,
                );
              },
              onPcmChunk: (chunk) => {
                if (!continuousAudioStreamStarted) {
                  continuousAudioStreamStarted = true;
                  this.logger.log(
                    `Device conversation first PCM device=${device.id} turn=${speechTurn.id} elapsedMs=${Date.now() - conversationStartedAt} ttsSessionMs=${Date.now() - continuousSessionRequestedAt}`,
                  );
                  this.emitDeviceRealtimeReply(emitReply, {
                    type: 'reply.audio.stream.start',
                    streamId: continuousAudioStreamId,
                    conversationTurnId: speechTurn.id,
                    sequence: 0,
                    sampleRate: Number(
                      process.env.DASHSCOPE_TTS_SAMPLE_RATE || 24000,
                    ),
                    channels: 1,
                    format: 'pcm_s16le',
                  });
                }
                continuousStreamedAudioBytes += chunk.length;
                this.emitDeviceRealtimeReply(emitReply, {
                  type: 'reply.audio.stream.chunk',
                  streamId: continuousAudioStreamId,
                  audioData: chunk,
                });
              },
            },
          )
        : null;
    // The first AI delta can arrive after a failed TTS handshake. The speech
    // chain handles that failure and falls back to the existing per-chunk
    // path, while this handler prevents an early unhandled rejection.
    void continuousTtsSession?.catch(() => undefined);
    void continuousTtsSession
      ?.then((session) => {
        this.logger.debug(
          `Continuous TTS session ready device=${device.id} turn=${speechTurn!.id} elapsedMs=${Date.now() - conversationStartedAt}`,
        );
        if (this.isConversationSpeechTurnActive(device.id, speechTurn!)) {
          speechTurn!.cancelRealtimeTts = () => session.cancel();
        } else {
          session.cancel();
        }
      })
      .catch(() => undefined);
    const clearFirstSpeechFragmentTimer = () => {
      if (!firstSpeechFragmentTimer) return;
      clearTimeout(firstSpeechFragmentTimer);
      firstSpeechFragmentTimer = undefined;
    };
    const queueChunks = (chunks: string[]) => {
      if (!speechTurn) return;
      for (const chunk of chunks) {
        const spokenText = this.tts.normalizeForSpeech(chunk);
        if (!spokenText) continue;
        const currentSequence = sequence++;
        speechChain = speechChain.then(async () => {
          if (continuousTtsSession && !continuousTtsFailed) {
            try {
              const session = await continuousTtsSession;
              await session.pushText(spokenText);
              continuousTextSubmitted = true;
              this.logger.debug(
                `Continuous TTS text submitted device=${device.id} turn=${speechTurn.id} sequence=${currentSequence} chars=${spokenText.length} elapsedMs=${Date.now() - conversationStartedAt}`,
              );
              return;
            } catch (error) {
              if (continuousTextSubmitted || continuousAudioStreamStarted) {
                throw error;
              }
              continuousTtsFailed = true;
              this.logger.warn(
                `Continuous TTS unavailable; using chunk fallback device=${device.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
              );
            }
          }
          await this.prepareAppConversationSpeechChunk(
            device,
            character,
            speechTurn,
            spokenText,
            currentSequence,
            assistantMessageId,
            userMessage.id,
            aiModel,
            emitReply,
          );
        });
      }
      if (sequence > 0) clearFirstSpeechFragmentTimer();
    };
    const scheduleFirstSpeechFragment = () => {
      if (!chunker || sequence > 0) return;
      clearFirstSpeechFragmentTimer();
      firstSpeechFragmentTimer = setTimeout(() => {
        firstSpeechFragmentTimer = undefined;
        if (sequence > 0) return;
        const chunks = chunker.takeEarlyFragment(
          FIRST_SPEECH_FRAGMENT_MIN_CHARS,
          FIRST_SPEECH_FRAGMENT_MAX_CHARS,
        );
        if (chunks.length > 0) {
          this.logger.debug(
            `Device conversation early speech fragment device=${device.id} chars=${this.tts.normalizeForSpeech(chunks[0]).length} elapsedMs=${Date.now() - conversationStartedAt}`,
          );
          queueChunks(chunks);
        }
      }, FIRST_SPEECH_FRAGMENT_DELAY_MS);
    };

    let reply: Awaited<ReturnType<AiChatService['stream']>>;
    try {
      reply = await this.aiChat.stream(
        prompt,
        recentMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        (delta) => {
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            this.logger.log(
              `Device conversation first AI delta device=${device.id} elapsedMs=${Date.now() - conversationStartedAt}`,
            );
          }
          this.emitDeviceRealtimeReply(emitReply, {
            type: 'reply.text.delta',
            delta,
          });
          if (chunker) {
            queueChunks(chunker.push(delta));
            scheduleFirstSpeechFragment();
          }
        },
      );
    } catch (error) {
      clearFirstSpeechFragmentTimer();
      void continuousTtsSession
        ?.then((session) => session.cancel())
        .catch(() => undefined);
      if (speechTurn) {
        await this.cancelPendingConversationSpeech(device.id, 'stream_failed');
      }
      throw error;
    }
    clearFirstSpeechFragmentTimer();
    aiModel = reply.model;
    if (chunker) queueChunks(chunker.flush());
    const assistantMessage = await this.conversationRepository.save(
      this.conversationRepository.create({
        userId: device.ownerUserId,
        deviceId: device.id,
        characterId: character.id,
        role: 'assistant',
        content: reply.content,
        source,
      }),
    );
    assistantMessageId = assistantMessage.id;
    if (speechTurn) {
      void speechChain
        .then(async () => {
          if (
            continuousTtsSession &&
            continuousAudioStreamId &&
            !continuousTtsFailed &&
            continuousTextSubmitted
          ) {
            const session = await continuousTtsSession;
            const speech = await session.finish();
            await this.completeContinuousConversationSpeech(
              device,
              character,
              speechTurn,
              reply.content,
              sequence,
              assistantMessage.id,
              userMessage.id,
              aiModel,
              continuousAudioStreamId,
              continuousAudioStreamStarted,
              continuousStreamedAudioBytes,
              speech,
              emitReply,
            );
          } else if (continuousTtsSession && !continuousTtsFailed) {
            const session = await continuousTtsSession;
            session.cancel();
          }
          await this.finishAppConversationSpeech(
            device.id,
            speechTurn,
            assistantMessage.id,
            sequence,
            emitReply,
          );
        })
        .catch((error) =>
          this.failAppConversationSpeech(
            device.id,
            speechTurn,
            assistantMessage.id,
            error,
            emitReply,
          ),
        );
    }
    await this.eventRepository.save(
      this.eventRepository.create({
        deviceId: device.id,
        type: 'conversation_reply_ready',
        payload: {
          source,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          text: reply.content,
          model: reply.model,
          chunkCount: sequence,
          transport: 'streaming_tts',
        },
      }),
    );
  }

  private async createConversationReply(
    deviceId: string,
    text: string,
    source: string,
  ) {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device?.ownerUserId) {
      throw new BadRequestException('设备尚未绑定用户');
    }
    if (!device.characterId) {
      throw new BadRequestException('设备尚未绑定角色');
    }
    const character = await this.requireCharacter(device.characterId);
    const userMessage = await this.conversationRepository.save(
      this.conversationRepository.create({
        userId: device.ownerUserId,
        deviceId: device.id,
        characterId: character.id,
        role: 'user',
        content: text,
        source,
      }),
    );
    const recentMessages = await this.conversationRepository.find({
      where: {
        userId: device.ownerUserId,
        deviceId: device.id,
        characterId: character.id,
      },
      order: { createdAt: 'DESC' },
      take: 30,
    });
    recentMessages.reverse();

    const prompt =
      character.prompt?.trim() ||
      `你是${character.name}。${character.description}请始终以这个角色的身份，用自然、简短、适合语音播放的中文回答。`;
    const reply = await this.aiChat.complete(
      prompt,
      recentMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    );
    const speech = await this.tts.synthesize(
      reply.content,
      character.voiceId,
      character.ttsModel,
    );
    const assistantMessage = await this.conversationRepository.save(
      this.conversationRepository.create({
        userId: device.ownerUserId,
        deviceId: device.id,
        characterId: character.id,
        role: 'assistant',
        content: reply.content,
        source: 'minimax',
      }),
    );
    const command = await this.enqueueCommand(device.id, 'speak_text', {
      text: reply.content,
      characterId: character.id,
      voiceId: speech.voice,
      audioPath: speech.audioPath,
      audioFormat: speech.format,
      sampleRate: speech.sampleRate,
      provider: speech.provider,
      ttsModel: speech.model,
      aiModel: reply.model,
      conversationMessageId: assistantMessage.id,
      source: 'ai_conversation',
    });
    await this.eventRepository.save(
      this.eventRepository.create({
        deviceId: device.id,
        type: 'conversation_reply_ready',
        payload: {
          source,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          commandId: command.id,
          text: reply.content,
          model: reply.model,
        },
      }),
    );
    return { character, reply, speech, command };
  }

  private enqueueCommand(
    deviceId: string,
    type: DeviceCommandEntity['type'],
    payload: Record<string, unknown>,
  ) {
    return this.commandRepository.save(
      this.commandRepository.create({
        deviceId,
        type,
        payload,
        acknowledgedAt: null,
      }),
    );
  }

  async queueAlarmSyncForDevice(deviceId: string, userId: string) {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, ownerUserId: userId },
    });
    if (!device) return null;

    const alarms = await this.alarmRepository.find({
      where: { deviceId, userId, enabled: true },
      order: { nextTriggeredAt: 'ASC', createdAt: 'ASC' },
    });
    const character = device.characterId
      ? await this.characterRepository.findOne({ where: { id: device.characterId } })
      : null;
    const syncedAlarms: Record<string, unknown>[] = [];

    for (const alarm of alarms.slice(0, 8)) {
      let audioPath: string;
      if (!alarm.useThemeSound && alarm.soundId) {
        // Stable, device-authenticated URL. The service restores the local copy
        // from COS when necessary, so firmware can retry until it is cached.
        audioPath = `/audio/alarm/${alarm.soundId}`;
      } else {
        const speech = await this.tts.synthesize(
          this.alarmSpeechText(alarm),
          character?.voiceId,
          character?.ttsModel,
        );
        audioPath = speech.audioPath;
      }
      const daysMask = alarm.days.reduce(
        (mask, day) => mask | (1 << day),
        0,
      );
      syncedAlarms.push({
        id: alarm.id,
        hour: alarm.hour,
        minute: alarm.minute,
        daysMask,
        snoozeEnabled: alarm.snoozeEnabled,
        snoozeMinutes: alarm.snoozeMinutes,
        snoozeCount: alarm.snoozeCount,
        title: alarm.soundTitle,
        audioPath,
      });
    }

    await this.commandRepository.delete({
      deviceId,
      type: 'sync_alarms',
      acknowledgedAt: IsNull(),
    });
    const command = await this.enqueueCommand(deviceId, 'sync_alarms', {
      revision: randomUUID(),
      timezone: 'Asia/Shanghai',
      generatedAt: new Date().toISOString(),
      totalEnabled: alarms.length,
      truncated: alarms.length > syncedAlarms.length,
      alarms: syncedAlarms,
    });
    this.logger.log(
      `Queued offline alarm sync device=${deviceId} alarms=${syncedAlarms.length}`,
    );
    return command;
  }

  private async enqueueNfcWelcome(
    deviceId: string,
    character: CharacterEntity,
  ) {
    const text = `Hello，我是${character.name}，接下来由我陪伴你`;
    try {
      const speech = await this.tts.synthesize(
        text,
        character.voiceId,
        character.ttsModel,
      );
      const currentDevice = await this.deviceRepository.findOne({
        where: { id: deviceId },
      });
      if (currentDevice?.characterId !== character.id) {
        this.logger.log(
          `Skipping stale NFC welcome device=${deviceId} character=${character.id}`,
        );
        return;
      }
      await this.enqueueCommand(deviceId, 'speak_text', {
        text,
        characterId: character.id,
        voiceId: speech.voice,
        audioPath: speech.audioPath,
        audioFormat: speech.format,
        sampleRate: speech.sampleRate,
        provider: speech.provider,
        ttsModel: speech.model,
        source: 'nfc_welcome',
      });
    } catch (error) {
      this.logger.warn(
        `Unable to prepare NFC welcome device=${deviceId} character=${character.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async scheduleAlarmSnooze(
    device: DeviceEntity,
    payload: Record<string, unknown>,
  ) {
    const requestedId =
      typeof payload.alarmId === 'string' ? payload.alarmId.trim() : '';
    let alarm = requestedId
      ? await this.alarmRepository.findOne({
          where: { id: requestedId, deviceId: device.id, enabled: true },
        })
      : null;

    // Compatibility fallback for firmware flashed before alarmId reporting.
    if (!alarm) {
      alarm = await this.alarmRepository.findOne({
        where: { deviceId: device.id, enabled: true },
        order: { lastTriggeredAt: 'DESC' },
      });
      const lastTriggeredAt = alarm?.lastTriggeredAt?.getTime() ?? 0;
      if (Date.now() - lastTriggeredAt > 60 * 60 * 1000) alarm = null;
    }

    if (!alarm) {
      return { snoozeAccepted: false, snoozeReason: 'no_active_alarm' };
    }
    if (!alarm.snoozeEnabled) {
      return {
        alarmId: alarm.id,
        snoozeAccepted: false,
        snoozeReason: 'disabled',
      };
    }
    if (alarm.snoozeCount > 0 && alarm.snoozeUsedCount >= alarm.snoozeCount) {
      return {
        alarmId: alarm.id,
        snoozeAccepted: false,
        snoozeReason: 'limit_reached',
        snoozeUsedCount: alarm.snoozeUsedCount,
      };
    }

    const scheduledAt = new Date(Date.now() + alarm.snoozeMinutes * 60_000);
    alarm.snoozeScheduledAt = scheduledAt;
    alarm.snoozeUsedCount += 1;
    alarm.lifecycleStatus = 'snoozing';
    alarm.ringingStartedAt = null;
    await this.alarmRepository.save(alarm);
    this.alarmRetryAfter.delete(alarm.id);
    return {
      alarmId: alarm.id,
      snoozeAccepted: true,
      snoozeMinutes: alarm.snoozeMinutes,
      snoozeUsedCount: alarm.snoozeUsedCount,
      snoozeScheduledAt: scheduledAt.toISOString(),
    };
  }

  private async triggerDueAlarms() {
    if (this.alarmTickRunning) return;
    this.alarmTickRunning = true;
    try {
      const now = new Date();
      const alarms = await this.alarmRepository.find({
        where: { enabled: true },
      });
      for (const alarm of alarms) {
        if (
          alarm.lifecycleStatus === 'ringing' &&
          alarm.ringingStartedAt &&
          now.getTime() - alarm.ringingStartedAt.getTime() > 10 * 60_000
        ) {
          alarm.lifecycleStatus = 'scheduled';
          alarm.ringingStartedAt = null;
          await this.alarmRepository.save(alarm);
        }
        if (!alarm.nextTriggeredAt) {
          alarm.nextTriggeredAt = this.nextAlarmOccurrence(alarm, now);
          await this.alarmRepository.save(alarm);
          continue;
        }

        const snoozeDue =
          alarm.snoozeScheduledAt !== null &&
          alarm.snoozeScheduledAt.getTime() <= now.getTime();
        const scheduledDue = alarm.nextTriggeredAt.getTime() <= now.getTime();
        if (!snoozeDue && !scheduledDue) continue;
        if ((this.alarmRetryAfter.get(alarm.id) ?? 0) > Date.now()) continue;

        const device = await this.deviceRepository.findOne({
          where: { id: alarm.deviceId, ownerUserId: alarm.userId },
        });
        if (!device) continue;
        const occurrence = snoozeDue && !scheduledDue ? 'snooze' : 'scheduled';

        if (this.supportsOfflineAlarmScheduler(device.firmwareVersion)) {
          alarm.lastTriggeredAt = now;
          alarm.lifecycleStatus = 'ringing';
          alarm.ringingStartedAt = now;
          if (snoozeDue) alarm.snoozeScheduledAt = null;
          if (occurrence === 'scheduled') {
            alarm.snoozeUsedCount = 0;
            alarm.snoozeScheduledAt = null;
            alarm.nextTriggeredAt = this.nextAlarmOccurrence(alarm, now);
          }
          await this.alarmRepository.save(alarm);
          await this.eventRepository.save(
            this.eventRepository.create({
              deviceId: device.id,
              type: 'alarm_local_trigger_expected',
              payload: {
                alarmId: alarm.id,
                title: alarm.soundTitle,
                occurrence,
                nextTriggeredAt: alarm.nextTriggeredAt?.toISOString() ?? null,
              },
            }),
          );
          this.alarmRetryAfter.delete(alarm.id);
          continue;
        }
        const character = device.characterId
          ? await this.characterRepository.findOne({ where: { id: device.characterId } })
          : null;
        const speechText = this.alarmSpeechText(alarm);

        try {
          const customSound = !alarm.useThemeSound && alarm.soundId
            ? await this.alarmSounds.resolvePlayback(alarm.userId, alarm.soundId)
            : null;
          const speech = customSound
            ? null
            : await this.tts.synthesize(
                speechText,
                character?.voiceId,
                character?.ttsModel,
              );
          const command = await this.enqueueCommand(device.id, 'play_reminder', {
            alarmId: alarm.id,
            title: alarm.soundTitle,
            kind: 'alarm',
            occurrence,
            themeId: alarm.themeId,
            soundId: alarm.soundId,
            useThemeSound: alarm.useThemeSound,
            snoozeEnabled: alarm.snoozeEnabled,
            snoozeMinutes: alarm.snoozeMinutes,
            snoozeCount: alarm.snoozeCount,
            text: customSound?.text || speechText,
            characterId: character?.id ?? null,
            voiceId: customSound?.voiceId || speech?.voice || null,
            audioPath: customSound?.audioPath || speech?.audioPath,
            audioFormat: speech?.format || 'wav',
            sampleRate: speech?.sampleRate || 24000,
            provider: customSound?.source || speech?.provider,
            ttsModel: customSound?.model || speech?.model || null,
            expiresAt: new Date(now.getTime() + 2 * 60_000).toISOString(),
          });

          alarm.lastTriggeredAt = now;
          alarm.lifecycleStatus = 'ringing';
          alarm.ringingStartedAt = now;
          if (snoozeDue) {
            alarm.snoozeScheduledAt = null;
          }
          if (occurrence === 'scheduled') {
            alarm.snoozeUsedCount = 0;
            alarm.snoozeScheduledAt = null;
            alarm.nextTriggeredAt = this.nextAlarmOccurrence(alarm, now);
          }
          await this.alarmRepository.save(alarm);
          await this.eventRepository.save(
            this.eventRepository.create({
              deviceId: device.id,
              type: 'alarm_triggered',
              payload: {
                alarmId: alarm.id,
                title: alarm.soundTitle,
                occurrence,
                commandId: command.id,
                nextTriggeredAt: alarm.nextTriggeredAt?.toISOString() ?? null,
                snoozeUsedCount: alarm.snoozeUsedCount,
              },
            }),
          );
          this.alarmRetryAfter.delete(alarm.id);
        } catch (error) {
          this.alarmRetryAfter.set(alarm.id, Date.now() + 30_000);
          this.logger.error(
            `Alarm audio failed alarm=${alarm.id}; retrying in 30 seconds: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
      }
    } finally {
      this.alarmTickRunning = false;
    }
  }

  private alarmSpeechText(alarm: AlarmEntity) {
    if (alarm.useThemeSound && alarm.themeId === 'suki-morning') {
      return '早上好，该起床啦。今天也要元气满满哦。';
    }
    return alarm.soundTitle;
  }

  private supportsOfflineAlarmScheduler(firmwareVersion: string) {
    const match = /^(\d+)\.(\d+)/.exec(firmwareVersion);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 0 || minor >= 8;
  }

  private nextAlarmOccurrence(alarm: AlarmEntity, after: Date) {
    // Asia/Shanghai has a fixed UTC+8 offset and no daylight saving time.
    const offsetMilliseconds = 8 * 60 * 60 * 1000;
    const shanghaiNow = new Date(after.getTime() + offsetMilliseconds);
    for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
      const localDay = new Date(shanghaiNow);
      localDay.setUTCDate(shanghaiNow.getUTCDate() + dayOffset);
      if (!alarm.days.includes(localDay.getUTCDay())) continue;
      const utcTime =
        Date.UTC(
          localDay.getUTCFullYear(),
          localDay.getUTCMonth(),
          localDay.getUTCDate(),
          alarm.hour,
          alarm.minute,
          0,
          0,
        ) - offsetMilliseconds;
      if (utcTime > after.getTime()) return new Date(utcTime);
    }
    throw new BadRequestException('无法计算闹钟的下次响铃时间');
  }

  private async triggerDueReminders() {
    if (this.reminderTickRunning) return;
    this.reminderTickRunning = true;
    try {
      const now = new Date();
      const reminders = await this.reminderRepository.find({
        where: { enabled: true, scheduledAt: LessThanOrEqual(now) },
      });
      for (const reminder of reminders) {
        if ((this.reminderRetryAfter.get(reminder.id) ?? 0) > Date.now()) continue;
        const device = await this.deviceRepository.findOne({
          where: { id: reminder.deviceId },
        });
        if (!device) continue;
        const character = device.characterId
          ? await this.characterRepository.findOne({ where: { id: device.characterId } })
          : null;
        try {
          const speech = await this.tts.synthesize(
            reminder.kind === 'alarm'
              ? `起床时间到了，${reminder.title}`
              : `提醒一下，${reminder.title}`,
            character?.voiceId,
            character?.ttsModel,
          );
          const command = await this.enqueueCommand(device.id, 'play_reminder', {
            reminderId: reminder.id,
            title: reminder.title,
            kind: reminder.kind,
            characterId: character?.id ?? null,
            voiceId: speech.voice,
            audioPath: speech.audioPath,
            audioFormat: speech.format,
            sampleRate: speech.sampleRate,
            provider: speech.provider,
            ttsModel: speech.model,
          });
          reminder.lastTriggeredAt = now;
          if (reminder.repeat === 'daily') {
            const next = new Date(reminder.scheduledAt);
            do next.setUTCDate(next.getUTCDate() + 1);
            while (next.getTime() <= now.getTime());
            reminder.scheduledAt = next;
          } else {
            reminder.enabled = false;
          }
          await this.reminderRepository.save(reminder);
          await this.eventRepository.save(
            this.eventRepository.create({
              deviceId: device.id,
              type: 'reminder_triggered',
              payload: {
                reminderId: reminder.id,
                title: reminder.title,
                kind: reminder.kind,
                commandId: command.id,
              },
            }),
          );
          this.reminderRetryAfter.delete(reminder.id);
        } catch (error) {
          this.reminderRetryAfter.set(reminder.id, Date.now() + 30_000);
          this.logger.error(
            `Reminder TTS failed reminder=${reminder.id}; retrying in 30 seconds: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
      }
    } finally {
      this.reminderTickRunning = false;
    }
  }

  private async requireCharacter(characterId: string) {
    const character = await this.characterRepository.findOne({ where: { id: characterId } });
    if (!character) throw new NotFoundException('角色不存在');
    return character;
  }

  private async requireOwnedDevice(userId: string, deviceId: string) {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, ownerUserId: userId },
    });
    if (!device) throw new NotFoundException('设备不存在或尚未绑定');
    return device;
  }

  private async requireReminder(userId: string, reminderId: string) {
    const reminder = await this.reminderRepository.findOne({
      where: { id: reminderId, userId },
    });
    if (!reminder) throw new NotFoundException('提醒不存在');
    return reminder;
  }

  private async requireAlarm(userId: string, alarmId: string) {
    const alarm = await this.alarmRepository.findOne({
      where: { id: alarmId, userId },
    });
    if (!alarm) throw new NotFoundException('闹钟不存在');
    await this.requireOwnedDevice(userId, alarm.deviceId);
    return alarm;
  }

  private toAlarm(alarm: AlarmEntity): Alarm {
    return {
      id: alarm.id,
      deviceId: alarm.deviceId,
      hour: alarm.hour,
      minute: alarm.minute,
      days: alarm.days,
      enabled: alarm.enabled,
      snoozeEnabled: alarm.snoozeEnabled,
      snoozeMinutes: alarm.snoozeMinutes,
      snoozeCount: alarm.snoozeCount,
      themeId: alarm.themeId,
      useThemeSound: alarm.useThemeSound,
      soundTitle: alarm.soundTitle,
      soundId: alarm.soundId,
      timezone: alarm.timezone,
      nextTriggeredAt: alarm.nextTriggeredAt?.toISOString() ?? null,
      snoozeScheduledAt: alarm.snoozeScheduledAt?.toISOString() ?? null,
      snoozeUsedCount: alarm.snoozeUsedCount,
      lifecycleStatus: alarm.lifecycleStatus,
      ringingStartedAt: alarm.ringingStartedAt?.toISOString() ?? null,
      lastDismissedAt: alarm.lastDismissedAt?.toISOString() ?? null,
      lastTriggeredAt: alarm.lastTriggeredAt?.toISOString() ?? null,
      createdAt: alarm.createdAt.toISOString(),
      updatedAt: alarm.updatedAt.toISOString(),
    };
  }

  private toCharacter(character: CharacterEntity): Character {
    return {
      id: character.id,
      name: character.name,
      description: character.description,
      accentColor: character.accentColor,
      backgroundImageUrl: character.backgroundImageUrl ?? null,
      voiceId: character.voiceId,
      ttsModel: character.ttsModel,
      greeting: character.greeting,
      prompt: character.prompt ?? '',
      nfcTagUid: character.nfcTagUid ?? null,
    };
  }

  private toDeviceCharacter(character: CharacterEntity) {
    return {
      id: character.id,
      name: character.name,
      description: character.description,
      accentColor: character.accentColor,
      backgroundImageUrl: character.backgroundImageUrl ?? null,
      voiceId: character.voiceId,
      ttsModel: character.ttsModel,
      greeting: character.greeting,
    };
  }

  private toConversationMessage(
    message: ConversationMessageEntity,
  ): ConversationMessage {
    return {
      id: message.id,
      deviceId: message.deviceId,
      characterId: message.characterId,
      role: message.role,
      content: message.content,
      source: message.source,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private toDeviceView(device: DeviceEntity, characters: CharacterEntity[]): DeviceView {
    const isOnline = this.isDeviceOnline(device);
    const character = characters.find((item) => item.id === device.characterId) ?? null;
    const nfcCharacter =
      device.lastNfcMatchedCharacterId === null
        ? null
        : characters.find((item) => item.id === device.lastNfcMatchedCharacterId) ?? null;
    return {
      id: device.id,
      hardwareId: device.hardwareId,
      name: device.name,
      firmwareVersion: device.firmwareVersion,
      characterId: device.characterId,
      character: character ? this.toCharacter(character) : null,
      nfcTag:
        device.lastNfcTagUid && device.lastNfcAt
          ? {
              uid: device.lastNfcTagUid,
              lastSeenAt: device.lastNfcAt.toISOString(),
              matched: Boolean(nfcCharacter),
              characterId: nfcCharacter?.id ?? null,
              characterName: nfcCharacter?.name ?? null,
            }
          : null,
      status: isOnline ? 'online' : 'offline',
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      volume: device.volume,
    };
  }

  private isDeviceOnline(device: DeviceEntity) {
    const onlineWindowSeconds = Number(
      process.env.DEVICE_ONLINE_WINDOW_SECONDS ?? 45,
    );
    return (
      device.lastSeenAt !== null &&
      Date.now() - device.lastSeenAt.getTime() < onlineWindowSeconds * 1000
    );
  }

  private async seedDevelopmentData() {
    await this.userRepository.upsert(
      { id: this.demoUser.id, displayName: this.demoUser.displayName },
      ['id'],
    );
    const characterSeeds: Array<Partial<CharacterEntity> & Pick<CharacterEntity, 'id'>> = [];
    for (const seed of characterSeeds) {
      const exists = await this.characterRepository.exist({ where: { id: seed.id } });
      if (!exists) {
        await this.characterRepository.save(this.characterRepository.create(seed));
      } else {
        const character = await this.characterRepository.findOne({
          where: { id: seed.id },
        });
        if (character && !character.prompt?.trim() && seed.prompt) {
          character.prompt = seed.prompt;
          await this.characterRepository.save(character);
        }
      }
    }
    const deviceExists = await this.deviceRepository.exist({
      where: { hardwareId: 'ESP32S3-DEMO-001' },
    });
    if (!deviceExists) {
      await this.deviceRepository.save(
        this.deviceRepository.create({
          hardwareId: 'ESP32S3-DEMO-001',
          deviceSecretHash: this.hash('figure-dev-secret-001'),
          pairingCode: 'FIGURE-0001',
          name: '我的手办底座',
          firmwareVersion: 'simulator-0.1.0',
          ownerUserId: null,
          characterId: null,
          lastSeenAt: null,
          lastNfcTagUid: null,
          lastNfcAt: null,
          lastNfcMatchedCharacterId: null,
          volume: 60,
        }),
      );
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private normalizeNfcUid(value: string): string {
    const uid = value.trim().toUpperCase().replace(/[\s:-]/g, '');
    if (!/^[0-9A-F]+$/.test(uid) || ![8, 14, 20].includes(uid.length)) {
      throw new BadRequestException('NFC UID 必须是 4、7 或 10 字节十六进制');
    }
    return uid;
  }
}
