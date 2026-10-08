import {
  Alarm,
  AlarmSyncStatus,
  AlarmSound,
  Character,
  ConversationMessage,
  Device,
  DeviceCommand,
  DeviceEvent,
  LoginResponse,
  Reminder,
} from './types';
import * as FileSystem from 'expo-file-system';

export type AlarmInput = Pick<
  Alarm,
  | 'deviceId'
  | 'hour'
  | 'minute'
  | 'days'
  | 'enabled'
  | 'snoozeEnabled'
  | 'snoozeMinutes'
  | 'snoozeCount'
  | 'themeId'
  | 'useThemeSound'
  | 'soundTitle'
  | 'soundId'
  | 'timezone'
>;

const DEFAULT_API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://192.168.18.225:3000';
const API_SETTINGS_FILE = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}backend-settings.json`
  : null;

export function normalizeApiBaseUrl(value?: string) {
  const raw = value?.trim();
  if (!raw) throw new Error('请输入后端服务地址');

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('后端地址格式不正确，例如：http://192.168.31.157:3000');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('后端地址只支持 http 或 https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('后端地址不能包含账号、查询参数或锚点');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path && path !== '/v1') {
    throw new Error('后端地址只需填写 IP（或域名）和端口，不要附加其他路径');
  }
  return `${parsed.protocol}//${parsed.host}/v1`;
}

export let API_BASE_URL = normalizeApiBaseUrl(DEFAULT_API_BASE_URL);

export type ConversationStreamEvent =
  | { type: 'message.created'; message: ConversationMessage }
  | { type: 'message.delta'; delta: string }
  | {
      type: 'message.completed';
      message: ConversationMessage;
      provider: string;
      requestId: string | null;
    }
  | { type: 'error'; message: string };

export type DeviceVoiceEvent =
  | { type: 'voice.listening'; deviceId: string }
  | {
      type: 'voice.transcript.partial' | 'voice.transcript.sentence';
      deviceId: string;
      text: string;
      elapsedMs: number;
    }
  | {
      type: 'voice.transcript.final';
      deviceId: string;
      text: string;
      durationMs: number;
      firstPartialMs: number | null;
      asrMode: 'realtime' | 'batch_fallback';
    }
  | { type: 'voice.error'; deviceId?: string; message: string };

export function getApiBaseUrl() {
  return API_BASE_URL;
}

export async function initializeApiBaseUrl() {
  if (!API_SETTINGS_FILE) return API_BASE_URL;
  try {
    const raw = await FileSystem.readAsStringAsync(API_SETTINGS_FILE);
    const settings = JSON.parse(raw) as { apiBaseUrl?: string };
    API_BASE_URL = normalizeApiBaseUrl(settings.apiBaseUrl);
  } catch {
    API_BASE_URL = normalizeApiBaseUrl(DEFAULT_API_BASE_URL);
  }
  return API_BASE_URL;
}

export async function saveApiBaseUrl(value: string) {
  const normalized = normalizeApiBaseUrl(value);
  if (!API_SETTINGS_FILE) throw new Error('当前设备无法保存后端地址');
  await FileSystem.writeAsStringAsync(
    API_SETTINGS_FILE,
    JSON.stringify({ apiBaseUrl: normalized }),
  );
  API_BASE_URL = normalized;
  return normalized;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  let response: Response;
  try {
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    response = await fetch(url, {
      ...options,
      headers: {
        ...(!isFormData ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '网络不可达';
    throw new Error(`无法连接后端 ${API_BASE_URL}：${reason}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(payload.message)
      ? payload.message.join('，')
      : payload.message;
    throw new Error(message || `请求失败（${response.status}）`);
  }
  return payload as T;
}

function createConversationAbortError() {
  const error = new Error('流式对话已取消');
  error.name = 'AbortError';
  return error;
}

function conversationWebSocketUrl() {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/devices/messages/stream';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function voiceEventsWebSocketUrl() {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/devices/voice/events';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function subscribeDeviceVoiceRecognition(
  token: string,
  deviceId: string,
  onEvent: (event: DeviceVoiceEvent) => void,
) {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(voiceEventsWebSocketUrl());
    socket.onopen = () => {
      socket?.send(
        JSON.stringify({ type: 'voice.subscribe', token, deviceId }),
      );
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as
          | DeviceVoiceEvent
          | { type: 'voice.subscribed'; deviceId: string };
        if (event.type !== 'voice.subscribed') onEvent(event);
      } catch {
        onEvent({ type: 'voice.error', message: '实时识别状态无法解析' });
      }
    };
    socket.onclose = () => {
      socket = null;
      if (!stopped) reconnectTimer = setTimeout(connect, 2000);
    };
    socket.onerror = () => {
      // onclose performs a quiet reconnect; normal history loading still works.
    };
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
}

function streamConversationMessageOverWebSocket(
  token: string,
  deviceId: string,
  text: string,
  onEvent: (event: ConversationStreamEvent) => void,
  options?: {
    clientRequestId?: string;
    signal?: AbortSignal;
  },
) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(conversationWebSocketUrl());
    let opened = false;
    let completed = false;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener('abort', abortRequest);
      try {
        if (
          socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN
        ) {
          socket.close();
        }
      } catch {
        // The promise still settles even when an older Android WebSocket
        // implementation cannot close during the connecting state.
      }
      if (error) reject(error);
      else resolve();
    };
    const abortRequest = () => settle(createConversationAbortError());

    socket.onopen = () => {
      if (settled) {
        socket.close();
        return;
      }
      opened = true;
      socket.send(
        JSON.stringify({
          type: 'message.create',
          token,
          deviceId,
          text,
          clientRequestId: options?.clientRequestId,
        }),
      );
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as ConversationStreamEvent;
        onEvent(event);
        if (event.type === 'error') {
          settle(new Error(event.message));
        } else if (event.type === 'message.completed') {
          completed = true;
          settle();
        }
      } catch {
        settle(new Error('后端返回了无法解析的流式数据'));
      }
    };
    socket.onerror = () => {
      const error = new Error(
        opened
          ? 'WebSocket 流式连接异常'
          : 'WebSocket 流式连接不可用',
      );
      error.name = opened ? 'ConversationStreamError' : 'WebSocketUnavailable';
      settle(error);
    };
    socket.onclose = () => {
      if (completed || settled) return;
      const error = new Error('WebSocket 流式连接已断开');
      error.name = opened ? 'ConversationStreamError' : 'WebSocketUnavailable';
      settle(error);
    };

    options?.signal?.addEventListener('abort', abortRequest, { once: true });
    if (options?.signal?.aborted) abortRequest();
  });
}

function streamConversationMessageOverHttp(
  token: string,
  deviceId: string,
  text: string,
  onEvent: (event: ConversationStreamEvent) => void,
  options?: {
    clientRequestId?: string;
    signal?: AbortSignal;
  },
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumedLength = 0;
    let pending = '';
    let serverError = '';
    let settled = false;
    const abortRequest = () => {
      xhr.abort();
      settle(createConversationAbortError());
    };

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener('abort', abortRequest);
      if (error) reject(error);
      else resolve();
    };
    const consume = (final = false) => {
      const responseText = xhr.responseText ?? '';
      pending += responseText.slice(consumedLength);
      consumedLength = responseText.length;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (final && pending.trim()) {
        lines.push(pending);
        pending = '';
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ConversationStreamEvent;
          if (event.type === 'error') serverError = event.message;
          onEvent(event);
        } catch {
          serverError = '后端返回了无法解析的流式数据';
        }
      }
    };

    xhr.open(
      'POST',
      `${API_BASE_URL}/devices/${encodeURIComponent(deviceId)}/messages/stream`,
    );
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.setRequestHeader('accept', 'application/x-ndjson');
    xhr.onprogress = () => consume();
    xhr.onload = () => {
      consume(true);
      if (xhr.status < 200 || xhr.status >= 300) {
        settle(new Error(serverError || `请求失败（${xhr.status}）`));
      } else if (serverError) {
        settle(new Error(serverError));
      } else {
        settle();
      }
    };
    xhr.onerror = () =>
      settle(
        options?.signal?.aborted
          ? createConversationAbortError()
          : new Error(`无法连接后端 ${API_BASE_URL}：网络不可达`),
      );
    xhr.onabort = () => settle(createConversationAbortError());
    xhr.ontimeout = () => settle(new Error('流式对话超时，请稍后重试'));
    xhr.timeout = 70_000;
    options?.signal?.addEventListener('abort', abortRequest, { once: true });
    if (options?.signal?.aborted) {
      abortRequest();
      return;
    }
    xhr.send(
      JSON.stringify({
        text,
        clientRequestId: options?.clientRequestId,
      }),
    );
  });
}

async function streamConversationMessage(
  token: string,
  deviceId: string,
  text: string,
  onEvent: (event: ConversationStreamEvent) => void,
  options?: {
    clientRequestId?: string;
    signal?: AbortSignal;
  },
) {
  try {
    await streamConversationMessageOverWebSocket(
      token,
      deviceId,
      text,
      onEvent,
      options,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'WebSocketUnavailable' &&
      !options?.signal?.aborted
    ) {
      await streamConversationMessageOverHttp(
        token,
        deviceId,
        text,
        onEvent,
        options,
      );
      return;
    }
    throw error;
  }
}

export function isConversationStreamCancelled(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export const api = {
  loginDemo: () =>
    request<LoginResponse>('/auth/demo', {
      method: 'POST',
      body: '{}',
    }),

  listCharacters: (token: string) =>
    request<Character[]>('/characters', {}, token),

  updateCharacterPrompt: (token: string, characterId: string, prompt: string) =>
    request<Character>(
      `/characters/${characterId}/prompt`,
      { method: 'PATCH', body: JSON.stringify({ prompt }) },
      token,
    ),

  bindCharacterNfcTag: (token: string, characterId: string, uid: string) =>
    request<Character>(
      `/characters/${characterId}/nfc-tag`,
      { method: 'PUT', body: JSON.stringify({ uid }) },
      token,
    ),

  unbindCharacterNfcTag: (token: string, characterId: string) =>
    request<Character>(
      `/characters/${characterId}/nfc-tag`,
      { method: 'DELETE' },
      token,
    ),

  listDevices: (token: string) => request<Device[]>('/devices', {}, token),

  bindDevice: (
    token: string,
    body: { pairingCode: string; characterId?: string; name?: string },
  ) =>
    request<Device>(
      '/devices/bind',
      { method: 'POST', body: JSON.stringify(body) },
      token,
    ),

  unbindDevice: (token: string, deviceId: string) =>
    request<{ unbound: boolean; deviceId: string }>(
      `/devices/${deviceId}/binding`,
      { method: 'DELETE' },
      token,
    ),

  updateCharacter: (token: string, deviceId: string, characterId: string) =>
    request<Device>(
      `/devices/${deviceId}/character`,
      { method: 'PATCH', body: JSON.stringify({ characterId }) },
      token,
    ),

  updateDeviceName: (token: string, deviceId: string, name: string) =>
    request<Device>(
      `/devices/${deviceId}/name`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
      token,
    ),

  updateVolume: (token: string, deviceId: string, volume: number) =>
    request<Device>(
      `/devices/${deviceId}/volume`,
      { method: 'PATCH', body: JSON.stringify({ volume }) },
      token,
    ),

  speakText: (token: string, deviceId: string, text: string) =>
    request(
      `/devices/${deviceId}/speak`,
      { method: 'POST', body: JSON.stringify({ text }) },
      token,
    ),

  startListening: (token: string, deviceId: string) =>
    request<DeviceCommand>(
      `/devices/${deviceId}/listen`,
      { method: 'POST', body: '{}' },
      token,
    ),

  listDeviceCommands: (token: string, deviceId: string) =>
    request<DeviceCommand[]>(`/devices/${deviceId}/commands`, {}, token),

  listDeviceEvents: (token: string, deviceId: string) =>
    request<DeviceEvent[]>(`/devices/${deviceId}/events`, {}, token),

  getAlarmSyncStatus: (token: string, deviceId: string) =>
    request<AlarmSyncStatus>(`/devices/${deviceId}/alarm-sync`, {}, token),

  retryAlarmSync: (token: string, deviceId: string) =>
    request<AlarmSyncStatus>(
      `/devices/${deviceId}/alarm-sync`,
      { method: 'POST', body: '{}' },
      token,
    ),

  listConversationMessages: (
    token: string,
    deviceId: string,
    before?: string,
    limit = 30,
  ) => {
    const query = new URLSearchParams();
    if (before) query.set('before', before);
    query.set('limit', String(limit));
    return request<ConversationMessage[]>(
      `/devices/${deviceId}/messages?${query.toString()}`,
      {},
      token,
    );
  },

  streamConversationMessage,

  listReminders: (token: string, deviceId?: string) =>
    request<Reminder[]>(
      `/reminders${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`,
      {},
      token,
    ),

  createReminder: (
    token: string,
    body: {
      deviceId: string;
      title: string;
      scheduledAt: string;
      repeat: 'none' | 'daily';
      kind: 'reminder' | 'alarm';
    },
  ) =>
    request<Reminder>(
      '/reminders',
      { method: 'POST', body: JSON.stringify(body) },
      token,
    ),

  toggleReminder: (token: string, reminderId: string, enabled: boolean) =>
    request<Reminder>(
      `/reminders/${reminderId}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
      token,
    ),

  deleteReminder: (token: string, reminderId: string) =>
    request(
      `/reminders/${reminderId}`,
      { method: 'DELETE' },
      token,
    ),

  listAlarms: (token: string, deviceId: string) =>
    request<Alarm[]>(
      `/alarms?deviceId=${encodeURIComponent(deviceId)}`,
      {},
      token,
    ),

  createAlarm: (token: string, body: AlarmInput) =>
    request<Alarm>(
      '/alarms',
      { method: 'POST', body: JSON.stringify(body) },
      token,
    ),

  updateAlarm: (
    token: string,
    alarmId: string,
    body: Partial<Omit<AlarmInput, 'deviceId'>>,
  ) =>
    request<Alarm>(
      `/alarms/${alarmId}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      token,
    ),

  deleteAlarm: (token: string, alarmId: string) =>
    request<{ deleted: boolean; alarmId: string }>(
      `/alarms/${alarmId}`,
      { method: 'DELETE' },
      token,
    ),

  snoozeAlarm: (token: string, alarmId: string) =>
    request<Alarm>(
      `/alarms/${alarmId}/snooze`,
      { method: 'POST' },
      token,
    ),

  dismissAlarm: (token: string, alarmId: string) =>
    request<Alarm>(
      `/alarms/${alarmId}/dismiss`,
      { method: 'POST' },
      token,
    ),

  listAlarmSounds: (token: string) =>
    request<AlarmSound[]>('/alarm-sounds', {}, token),

  uploadAlarmSound: (
    token: string,
    file: { uri: string; name: string; type: string },
    title?: string,
  ) => {
    const body = new FormData();
    body.append('file', file as unknown as Blob);
    if (title) body.append('title', title);
    return request<AlarmSound>(
      '/alarm-sounds/upload',
      { method: 'POST', body },
      token,
    );
  },

  synthesizeAlarmSound: (
    token: string,
    sourceId: string,
    body: { title: string; text: string; backgroundMusicId?: string | null },
  ) =>
    request<AlarmSound>(
      `/alarm-sounds/${sourceId}/synthesize`,
      { method: 'POST', body: JSON.stringify(body) },
      token,
    ),

  deleteAlarmSound: (token: string, soundId: string) =>
    request<{ deleted: boolean; soundId: string; deletedAlarms: number }>(
      `/alarm-sounds/${soundId}`,
      { method: 'DELETE' },
      token,
    ),

  alarmSoundAudioUrl: (soundId: string) =>
    `${API_BASE_URL}/alarm-sounds/${encodeURIComponent(soundId)}/audio`,

  alarmSoundPlaybackUrl: (token: string, soundId: string) =>
    request<{ url: string; expiresAt: string }>(
      `/alarm-sounds/${encodeURIComponent(soundId)}/playback-url`,
      {},
      token,
    ),
};
