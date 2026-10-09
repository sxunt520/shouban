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

export interface Device {
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
  status: 'online' | 'offline';
  lastSeenAt: string | null;
  volume: number;
  desiredVolume?: number | null;
  protocolProfile?: string;
  capabilities?: { setVolume: boolean; conversation: boolean; nfc: boolean; offlineAlarms: boolean };
  referenceVoiceAvailable?: boolean;
  connectivity?: { network: 'online' | 'unknown'; controlReachable: boolean; voiceActive: boolean; lastEvidenceAt: string | null };
  nfcSimulator?: boolean;
  nfcState?: { present: boolean; uid: string | null; lastSeenAt: string | null; matched: boolean; characterId: string | null };
  speechCommand?: { id: string; text: string; status: CommandStatus; phase: string; errorMessage: string | null; completedAt: string | null } | null;
  identifyCommand?: { id: string; status: CommandStatus; errorMessage: string | null; completedAt: string | null } | null;
  volumeCommand?: {
    id: string; status: CommandStatus; requestedVolume: number; revision: number | null;
    errorMessage: string | null; expiresAt: string | null; completedAt: string | null;
  } | null;
}

export interface Reminder {
  id: string;
  deviceId: string;
  title: string;
  scheduledAt: string;
  repeat: 'none' | 'daily';
  kind: 'reminder' | 'alarm';
  enabled: boolean;
  lastTriggeredAt: string | null;
  execution?: { occurrenceAt: string; commandId: string | null; status: string; phase: string | null; message: string | null; completedAt: string | null } | null;
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

export interface AlarmSyncStatus {
  state: 'idle' | 'pending' | 'syncing' | 'synced' | 'failed';
  revision: string | null;
  commandId: string | null;
  totalEnabled: number;
  cachedCount: number;
  message: string | null;
  updatedAt: string | null;
}

export interface AlarmSound {
  id: string;
  title: string;
  kind: 'recording' | 'diy';
  status: 'ready' | 'processing' | 'failed';
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

export type CommandType =
  | 'sync_character'
  | 'sync_alarms'
  | 'control_alarm'
  | 'play_reminder'
  | 'speak_text'
  | 'start_listening'
  | 'set_volume'
  | 'identify_device';

export type CommandStatus = 'pending' | 'dispatched' | 'succeeded' | 'failed' | 'expired' | 'cancelled';

export interface DeviceCommand {
  id: string;
  deviceId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt: string | null;
  status?: CommandStatus;
  failureReason?: string | null;
  attempts?: number;
}

export interface DeviceEvent {
  id: string;
  deviceId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  user: User;
}
