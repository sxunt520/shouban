export type DeviceStatus = 'online' | 'offline';
export type ReminderRepeat = 'none' | 'daily';
export type ReminderKind = 'reminder' | 'alarm';
export type CommandType =
  | 'sync_character'
  | 'play_reminder'
  | 'speak_text'
  | 'start_listening'
  | 'sync_alarms'
  | 'control_alarm'
  | 'set_volume';

export interface AlarmSyncStatus {
  state: 'idle' | 'pending' | 'syncing' | 'synced' | 'failed';
  revision: string | null;
  commandId: string | null;
  totalEnabled: number;
  cachedCount: number;
  message: string | null;
  updatedAt: string | null;
}

export interface User {
  id: string;
  displayName: string;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  accentColor: string;
  backgroundImageUrl: string | null;
  voiceId: string;
  ttsModel: string;
  greeting: string;
  prompt: string;
  nfcTagUid: string | null;
}

export interface ConversationMessage {
  id: string;
  deviceId: string;
  characterId: string;
  role: 'user' | 'assistant';
  content: string;
  source: string;
  createdAt: string;
}

export interface DeviceRecord {
  id: string;
  hardwareId: string;
  deviceSecret: string;
  pairingCode: string;
  name: string;
  firmwareVersion: string;
  ownerUserId: string | null;
  characterId: string | null;
  lastSeenAt: string | null;
  volume: number;
}

export interface DeviceView {
  id: string;
  hardwareId: string;
  name: string;
  firmwareVersion: string;
  characterId: string | null;
  character: Character | null;
  nfcTag: {
    uid: string;
    lastSeenAt: string;
    matched: boolean;
    characterId: string | null;
    characterName: string | null;
  } | null;
  status: DeviceStatus;
  lastSeenAt: string | null;
  volume: number;
}

export interface Reminder {
  id: string;
  userId: string;
  deviceId: string;
  title: string;
  scheduledAt: string;
  repeat: ReminderRepeat;
  kind: ReminderKind;
  enabled: boolean;
  lastTriggeredAt: string | null;
}

export interface Alarm {
  id: string;
  deviceId: string;
  hour: number;
  minute: number;
  days: number[];
  enabled: boolean;
  snoozeEnabled: boolean;
  snoozeMinutes: number;
  snoozeCount: number;
  themeId: string;
  useThemeSound: boolean;
  soundTitle: string;
  soundId: string | null;
  timezone: string;
  nextTriggeredAt: string | null;
  snoozeScheduledAt: string | null;
  snoozeUsedCount: number;
  lifecycleStatus: 'scheduled' | 'ringing' | 'snoozing';
  ringingStartedAt: string | null;
  lastDismissedAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AlarmSoundKind = 'recording' | 'diy';
export type AlarmSoundStatus = 'ready' | 'processing' | 'failed';

export interface AlarmSound {
  id: string;
  title: string;
  kind: AlarmSoundKind;
  status: AlarmSoundStatus;
  sourceName: string;
  sourceMimeType: string;
  sourceObjectKey: string;
  sourceUrl: string;
  outputObjectKey: string | null;
  outputUrl: string | null;
  text: string | null;
  voiceId: string | null;
  ttsModel: string | null;
  backgroundMusicId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceCommand {
  id: string;
  deviceId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt: string | null;
}
