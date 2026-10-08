import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  AlarmSoundKind,
  AlarmSoundStatus,
  CommandType,
  ReminderKind,
  ReminderRepeat,
} from './contracts';

@Entity('figure_users')
export class UserEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Column({ type: 'varchar', length: 80 })
  displayName: string;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Entity('figure_characters')
export class CharacterEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'varchar', length: 500 })
  description: string;

  @Column({ type: 'varchar', length: 16 })
  accentColor: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  backgroundImageUrl: string | null;

  @Column({ type: 'varchar', length: 160 })
  voiceId: string;

  @Column({ type: 'varchar', length: 80, default: 'cosyvoice-v3.5-plus' })
  ttsModel: string;

  @Column({ type: 'varchar', length: 500 })
  greeting: string;

  // Nullable keeps schema synchronization compatible with existing MariaDB rows.
  @Column({ type: 'text', nullable: true })
  prompt: string | null;

  // A physical figure is currently identified by one ISO 14443-A tag UID.
  // Store the canonical uppercase hex value without separators (4/7/10 bytes).
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20, nullable: true })
  nfcTagUid: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Entity('figure_conversation_messages')
@Index(['userId', 'deviceId', 'characterId', 'createdAt'])
export class ConversationMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  userId: string;

  @Column({ type: 'char', length: 36 })
  deviceId: string;

  @Column({ type: 'varchar', length: 64 })
  characterId: string;

  @Column({ type: 'enum', enum: ['user', 'assistant'] })
  role: 'user' | 'assistant';

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'varchar', length: 32, default: 'voice' })
  source: string;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Entity('figure_devices')
export class DeviceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  hardwareId: string;

  @Column({ type: 'char', length: 64 })
  deviceSecretHash: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  pairingCode: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'varchar', length: 64, default: 'unknown' })
  firmwareVersion: string;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  ownerUserId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  characterId: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'tinyint', unsigned: true, default: 60 })
  volume: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  lastNfcTagUid: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastNfcAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastNfcMatchedCharacterId: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Entity('figure_device_sessions')
export class DeviceSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  @Index()
  @Column({ type: 'char', length: 36 })
  deviceId: string;

  @Column({ type: 'datetime', precision: 3 })
  expiresAt: Date;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Entity('figure_reminders')
export class ReminderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  userId: string;

  @Index()
  @Column({ type: 'char', length: 36 })
  deviceId: string;

  @Column({ type: 'varchar', length: 80 })
  title: string;

  @Index()
  @Column({ type: 'datetime', precision: 3 })
  scheduledAt: Date;

  @Column({ type: 'enum', enum: ['none', 'daily'], default: 'none' })
  repeat: ReminderRepeat;

  @Column({ type: 'varchar', length: 16, default: 'reminder' })
  kind: ReminderKind;

  @Index()
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastTriggeredAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Entity('figure_alarms')
@Index(['userId', 'deviceId'])
export class AlarmEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  userId: string;

  @Index()
  @Column({ type: 'char', length: 36 })
  deviceId: string;

  @Column({ type: 'tinyint', unsigned: true })
  hour: number;

  @Column({ type: 'tinyint', unsigned: true })
  minute: number;

  // MariaDB 10.1 has no native JSON column. Values are weekday numbers 0-6.
  @Column({ type: 'simple-json' })
  days: number[];

  @Index()
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'boolean', default: true })
  snoozeEnabled: boolean;

  @Column({ type: 'tinyint', unsigned: true, default: 5 })
  snoozeMinutes: number;

  // Zero means unlimited snoozes.
  @Column({ type: 'tinyint', unsigned: true, default: 3 })
  snoozeCount: number;

  @Column({ type: 'varchar', length: 64, default: 'suki-morning' })
  themeId: string;

  @Column({ type: 'boolean', default: true })
  useThemeSound: boolean;

  @Column({ type: 'varchar', length: 120 })
  soundTitle: string;

  @Column({ type: 'char', length: 36, nullable: true })
  soundId: string | null;

  @Column({ type: 'varchar', length: 64, default: 'Asia/Shanghai' })
  timezone: string;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: true })
  nextTriggeredAt: Date | null;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: true })
  snoozeScheduledAt: Date | null;

  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  snoozeUsedCount: number;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'scheduled' })
  lifecycleStatus: 'scheduled' | 'ringing' | 'snoozing';

  @Column({ type: 'datetime', precision: 3, nullable: true })
  ringingStartedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastDismissedAt: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  lastTriggeredAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Entity('figure_alarm_sounds')
@Index(['userId', 'kind'])
export class AlarmSoundEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  userId: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 16 })
  kind: AlarmSoundKind;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'ready' })
  status: AlarmSoundStatus;

  @Column({ type: 'varchar', length: 180 })
  sourceName: string;

  @Column({ type: 'varchar', length: 80 })
  sourceMimeType: string;

  @Column({ type: 'varchar', length: 255 })
  sourceObjectKey: string;

  @Column({ type: 'text' })
  sourceUrl: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  outputObjectKey: string | null;

  @Column({ type: 'text', nullable: true })
  outputUrl: string | null;

  @Column({ type: 'varchar', length: 180 })
  localFileName: string;

  @Column({ type: 'varchar', length: 180, nullable: true })
  sourceLocalFileName: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  text: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  voiceId: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  ttsModel: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  backgroundMusicId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 3 })
  updatedAt: Date;
}

@Entity('figure_device_commands')
export class DeviceCommandEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'char', length: 36 })
  deviceId: string;

  @Column({
    type: 'enum',
    enum: [
      'sync_character',
      'play_reminder',
      'speak_text',
      'start_listening',
      'sync_alarms',
      'control_alarm',
      'set_volume',
    ],
  })
  type: CommandType;

  // MariaDB 10.1 has no native JSON column. TypeORM serializes this to text.
  @Column({ type: 'simple-json' })
  payload: Record<string, unknown>;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  acknowledgedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;
}

@Entity('figure_device_events')
export class DeviceEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'char', length: 36 })
  deviceId: string;

  @Index()
  @Column({ type: 'varchar', length: 80 })
  type: string;

  @Column({ type: 'simple-json' })
  payload: Record<string, unknown>;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date;
}

export const databaseEntities = [
  UserEntity,
  CharacterEntity,
  ConversationMessageEntity,
  DeviceEntity,
  DeviceSessionEntity,
  ReminderEntity,
  AlarmEntity,
  AlarmSoundEntity,
  DeviceCommandEntity,
  DeviceEventEntity,
];
