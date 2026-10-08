import {
  NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageBackground,
  ImageSourcePropType,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import { api, AlarmInput } from '../api';
import { Alarm, AlarmSound, AlarmSyncStatus, Device } from '../types';

const colors = {
  canvas: '#FFFFFF',
  cream: '#F6F0E3',
  creamDeep: '#E9DCC2',
  sand: '#D3BD93',
  lime: '#A7C63B',
  ink: '#111111',
  charcoal: '#3D3D3D',
  muted: '#969696',
  line: '#E7E2D8',
  danger: '#C95B56',
  green: '#68BE58',
};

const sukiMorning = require('../../assets/alarm/suki-morning.png') as ImageSourcePropType;

type AlarmTheme = {
  id: string;
  title: string;
  soundTitle: string;
  image?: ImageSourcePropType;
  tint: string;
};

type AlarmItem = Alarm;

type AlarmDraft = {
  id?: string;
  hour: number;
  minute: number;
  days: number[];
  snoozeEnabled: boolean;
  snoozeMinutes: number;
  snoozeCount: number;
  themeId: string;
  useThemeSound: boolean;
  soundTitle: string;
  soundId: string | null;
};

type AlarmStackParamList = {
  AlarmHome: undefined;
  AlarmEditor: undefined;
  AlarmFrequency: undefined;
  ThemePicker: undefined;
  AlarmPreview: { themeId: string; soundTitle: string; soundId?: string | null };
  CustomSounds: undefined;
  RecordSound: undefined;
  SoundCopy: { sourceId: string; sourceName: string; sourceKind: 'recording' | 'file' };
  Synthesizing: { soundId: string };
};

const Stack = createNativeStackNavigator<AlarmStackParamList>();
const weekLabels = ['日', '一', '二', '三', '四', '五', '六'];

const themes: AlarmTheme[] = [
  {
    id: 'suki-morning',
    title: 'Suki叫你起床了',
    soundTitle: 'Wake up · Suki晨间问候',
    image: sukiMorning,
    tint: '#DFCFB6',
  },
  {
    id: 'suki-soft',
    title: 'Suki温柔早安',
    soundTitle: '自定义 · 温柔唤醒',
    image: sukiMorning,
    tint: '#E5D5D0',
  },
  {
    id: 'suki-sun',
    title: 'Suki海边晨光',
    soundTitle: 'Wake up · 活力清晨',
    image: sukiMorning,
    tint: '#D7E5E6',
  },
];

function createDraft(): AlarmDraft {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  const roundedMinutes = Math.ceil(next.getMinutes() / 5) * 5;
  if (roundedMinutes >= 60) {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  } else {
    next.setMinutes(roundedMinutes, 0, 0);
  }
  return {
    hour: next.getHours(),
    minute: next.getMinutes(),
    days: [0, 1, 2, 3, 4, 5, 6],
    snoozeEnabled: true,
    snoozeMinutes: 5,
    snoozeCount: 3,
    themeId: 'suki-morning',
    useThemeSound: true,
    soundTitle: 'Suki叫你起床了',
    soundId: null,
  };
}

export function AlarmFlow({ token, device }: { token: string; device: Device | null }) {
  const [alarms, setAlarms] = useState<AlarmItem[]>([]);
  const [draft, setDraft] = useState<AlarmDraft>(createDraft);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [customSounds, setCustomSounds] = useState<AlarmSound[]>([]);
  const [alarmSync, setAlarmSync] = useState<AlarmSyncStatus | null>(null);

  const loadAlarms = useCallback(async () => {
    if (!token || !device) {
      setAlarms([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setAlarms(await api.listAlarms(token, device.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '闹钟加载失败');
    } finally {
      setLoading(false);
    }
  }, [device?.id, token]);

  useEffect(() => {
    void loadAlarms();
  }, [loadAlarms]);

  const loadAlarmSync = useCallback(async () => {
    if (!token || !device) {
      setAlarmSync(null);
      return;
    }
    try {
      setAlarmSync(await api.getAlarmSyncStatus(token, device.id));
    } catch {
      // Alarm list errors remain the primary connection error surface.
    }
  }, [device?.id, token]);

  useEffect(() => {
    void loadAlarmSync();
    if (!token || !device) return;
    const timer = setInterval(() => void loadAlarmSync(), 2500);
    return () => clearInterval(timer);
  }, [device?.id, loadAlarmSync, token]);

  const markAlarmSyncPending = () => {
    setAlarmSync((current) => ({
      state: 'pending',
      revision: current?.revision ?? null,
      commandId: current?.commandId ?? null,
      totalEnabled: current?.totalEnabled ?? alarms.filter((alarm) => alarm.enabled).length,
      cachedCount: current?.cachedCount ?? 0,
      message: '闹钟变更正在发送到底座',
      updatedAt: new Date().toISOString(),
    }));
  };

  const loadSounds = useCallback(async () => {
    if (!token) {
      setCustomSounds([]);
      return;
    }
    try {
      setCustomSounds(await api.listAlarmSounds(token));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '自定义铃声加载失败');
    }
  }, [token]);

  useEffect(() => {
    void loadSounds();
  }, [loadSounds]);

  useEffect(() => {
    if (!token || !customSounds.some((sound) => sound.status === 'processing')) return;
    const timer = setInterval(() => void loadSounds(), 3000);
    return () => clearInterval(timer);
  }, [customSounds, loadSounds, token]);

  const uploadAlarmSound = async (file: { uri: string; name: string; type: string }) => {
    const sound = await api.uploadAlarmSound(token, file);
    setCustomSounds((current) => [sound, ...current.filter((item) => item.id !== sound.id)]);
    return sound;
  };

  const removeAlarmSound = async (soundId: string) => {
    const result = await api.deleteAlarmSound(token, soundId);
    setCustomSounds((current) => current.filter((sound) => sound.id !== soundId));
    setAlarms((current) => current.filter((alarm) => alarm.soundId !== soundId));
    return result;
  };

  const synthesizeAlarmSound = async (
    sourceId: string,
    input: { title: string; text: string; backgroundMusicId?: string | null },
  ) => {
    const sound = await api.synthesizeAlarmSound(token, sourceId, input);
    setCustomSounds((current) => [sound, ...current]);
    return sound;
  };

  useEffect(() => {
    if (!token || !device) return;

    let active = true;
    const timer = setInterval(() => {
      void api.listAlarms(token, device.id).then((latest) => {
        if (active) setAlarms(latest);
      }).catch(() => {
        // The normal load/retry UI owns connection errors. Background syncing stays quiet.
      });
    }, 5000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [device?.id, token]);

  const beginNewAlarm = () => {
    if (!device) {
      Alert.alert('还没有底座', '请先绑定智能底座，再添加闹钟。');
      return false;
    }
    setDraft(createDraft());
    return true;
  };
  const editAlarm = (alarm: AlarmItem) => setDraft({ ...alarm });
  const saveAlarm = async () => {
    if (!token || !device) return false;
    setSaving(true);
    setError('');
    markAlarmSyncPending();
    try {
      const input: AlarmInput = {
        deviceId: device.id,
        hour: draft.hour,
        minute: draft.minute,
        days: draft.days,
        enabled: true,
        snoozeEnabled: draft.snoozeEnabled,
        snoozeMinutes: draft.snoozeMinutes,
        snoozeCount: draft.snoozeCount,
        themeId: draft.themeId,
        useThemeSound: draft.useThemeSound,
        soundTitle: draft.soundTitle,
        soundId: draft.soundId,
        timezone: 'Asia/Shanghai',
      };
      const { deviceId: _deviceId, ...update } = input;
      const saved = draft.id
        ? await api.updateAlarm(token, draft.id, update)
        : await api.createAlarm(token, input);
      setAlarms((current) => {
        const exists = current.some((alarm) => alarm.id === saved.id);
        return exists
          ? current.map((alarm) => alarm.id === saved.id ? saved : alarm)
          : [...current, saved];
      });
      setDraft({ ...saved });
      void loadAlarmSync();
      return true;
    } catch (caught) {
      void loadAlarmSync();
      const message = caught instanceof Error ? caught.message : '闹钟保存失败';
      setError(message);
      Alert.alert('保存失败', message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggleAlarm = async (alarmId: string, enabled: boolean) => {
    if (!token) return;
    const before = alarms;
    markAlarmSyncPending();
    setAlarms((current) => current.map((alarm) => alarm.id === alarmId ? { ...alarm, enabled } : alarm));
    try {
      const updated = await api.updateAlarm(token, alarmId, { enabled });
      setAlarms((current) => current.map((alarm) => alarm.id === alarmId ? updated : alarm));
      void loadAlarmSync();
    } catch (caught) {
      setAlarms(before);
      void loadAlarmSync();
      const message = caught instanceof Error ? caught.message : '闹钟状态更新失败';
      setError(message);
      Alert.alert('操作失败', message);
    }
  };

  const deleteAlarm = async (alarmId: string) => {
    if (!token) return false;
    try {
      markAlarmSyncPending();
      await api.deleteAlarm(token, alarmId);
      setAlarms((current) => current.filter((alarm) => alarm.id !== alarmId));
      void loadAlarmSync();
      return true;
    } catch (caught) {
      void loadAlarmSync();
      const message = caught instanceof Error ? caught.message : '闹钟删除失败';
      setError(message);
      Alert.alert('删除失败', message);
      return false;
    }
  };

  const retryAlarmSync = async () => {
    if (!token || !device) return;
    markAlarmSyncPending();
    try {
      setAlarmSync(await api.retryAlarmSync(token, device.id));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '重新同步失败';
      setError(message);
      Alert.alert('重新同步失败', message);
    }
  };

  const snoozeAlarm = async (alarmId: string) => {
    if (!token) return;
    try {
      const updated = await api.snoozeAlarm(token, alarmId);
      setAlarms((current) => current.map((alarm) => alarm.id === alarmId ? updated : alarm));
    } catch (caught) {
      Alert.alert('稍后提醒失败', caught instanceof Error ? caught.message : '请稍后重试');
    }
  };

  const dismissAlarm = async (alarmId: string) => {
    if (!token) return;
    try {
      const updated = await api.dismissAlarm(token, alarmId);
      setAlarms((current) => current.map((alarm) => alarm.id === alarmId ? updated : alarm));
    } catch (caught) {
      Alert.alert('停止闹钟失败', caught instanceof Error ? caught.message : '请稍后重试');
    }
  };

  return (
    <Stack.Navigator
      initialRouteName="AlarmHome"
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        gestureEnabled: true,
        fullScreenGestureEnabled: false,
        contentStyle: { backgroundColor: colors.canvas },
      }}
    >
      <Stack.Screen name="AlarmHome">
        {(props) => (
          <AlarmHomeScreen
            {...props}
            alarms={alarms}
            loading={loading}
            error={error}
            alarmSync={alarmSync}
            onNew={beginNewAlarm}
            onEdit={editAlarm}
            onToggle={toggleAlarm}
            onDelete={deleteAlarm}
            onRetry={loadAlarms}
            onRetrySync={retryAlarmSync}
            onSnooze={snoozeAlarm}
            onDismiss={dismissAlarm}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="AlarmEditor">
        {(props) => (
          <AlarmEditorScreen
            {...props}
            draft={draft}
            setDraft={setDraft}
            onSave={saveAlarm}
            saving={saving}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="AlarmFrequency">
        {(props) => <AlarmFrequencyScreen {...props} draft={draft} setDraft={setDraft} />}
      </Stack.Screen>
      <Stack.Screen name="ThemePicker">
        {(props) => <ThemePickerScreen {...props} draft={draft} setDraft={setDraft} />}
      </Stack.Screen>
      <Stack.Screen name="AlarmPreview">
        {(props) => <AlarmPreviewScreen {...props} token={token} />}
      </Stack.Screen>
      <Stack.Screen name="CustomSounds">
        {(props) => (
          <CustomSoundsScreen
            {...props}
            sounds={customSounds}
            onUpload={uploadAlarmSound}
            onDelete={removeAlarmSound}
            onSelect={(sound) =>
              setDraft((current) => ({
                ...current,
                useThemeSound: false,
                soundTitle: sound.title,
                soundId: sound.id,
              }))
            }
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="RecordSound">
        {(props) => <RecordSoundScreen {...props} onUpload={uploadAlarmSound} />}
      </Stack.Screen>
      <Stack.Screen name="SoundCopy">
        {(props) => (
          <SoundCopyScreen
            {...props}
            onDirectUse={(soundId, title) => {
              setDraft((current) => ({
                ...current,
                useThemeSound: false,
                soundId,
                soundTitle: title,
              }));
            }}
            onSynthesize={synthesizeAlarmSound}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Synthesizing">
        {(props) => (
          <SynthesizingScreen
            {...props}
            token={token}
            onComplete={(sound) => {
              setCustomSounds((current) => [sound, ...current.filter((item) => item.id !== sound.id)]);
              setDraft((current) => ({
                ...current,
                useThemeSound: false,
                soundTitle: sound.title,
                soundId: sound.id,
              }));
            }}
          />
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

function AlarmHomeScreen({
  navigation,
  alarms,
  loading,
  error,
  alarmSync,
  onNew,
  onEdit,
  onToggle,
  onDelete,
  onRetry,
  onRetrySync,
  onSnooze,
  onDismiss,
}: NativeStackScreenProps<AlarmStackParamList, 'AlarmHome'> & {
  alarms: AlarmItem[];
  loading: boolean;
  error: string;
  alarmSync: AlarmSyncStatus | null;
  onNew: () => boolean;
  onEdit: (alarm: AlarmItem) => void;
  onToggle: (alarmId: string, enabled: boolean) => Promise<void>;
  onDelete: (alarmId: string) => Promise<boolean>;
  onRetry: () => Promise<void>;
  onRetrySync: () => Promise<void>;
  onSnooze: (alarmId: string) => Promise<void>;
  onDismiss: (alarmId: string) => Promise<void>;
}) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const next = useMemo(
    () =>
      alarms
        .filter((alarm) => alarm.enabled)
        .map((alarm) => {
          const regularAt = alarm.nextTriggeredAt
            ? new Date(alarm.nextTriggeredAt)
            : nextAlarmAt(alarm, new Date(now));
          const snoozeAt = alarm.snoozeScheduledAt
            ? new Date(alarm.snoozeScheduledAt)
            : null;
          const snoozing = !!snoozeAt
            && Number.isFinite(snoozeAt.getTime())
            && snoozeAt.getTime() <= regularAt.getTime();
          return { alarm, at: snoozing ? snoozeAt : regularAt, snoozing };
        })
        .filter((item) => Number.isFinite(item.at.getTime()))
        .sort((a, b) => a.at.getTime() - b.at.getTime())[0],
    [alarms, now],
  );
  const ringingAlarm = alarms.find(
    (alarm) => alarm.enabled && alarm.lifecycleStatus === 'ringing',
  );
  const remaining = next ? formatCountdown(next.at.getTime() - now) : null;
  const deleting = alarms.find((alarm) => alarm.id === deleteId);

  return (
    <Page scroll onSwipeBack={navigation.goBack}>
      <ScreenHeader title="AI闹钟" onBack={navigation.goBack} />
      <View style={styles.countdownRow}>
        {ringingAlarm ? (
          <View style={styles.ringingBanner}>
            <Text style={styles.ringingIcon}>⏰</Text>
            <View style={styles.flex}>
              <Text style={styles.ringingTitle}>闹钟正在响铃</Text>
              <Text numberOfLines={1} style={styles.ringingSubtitle}>
                {pad(ringingAlarm.hour)}:{pad(ringingAlarm.minute)} · {ringingAlarm.soundTitle}
              </Text>
              <View style={styles.ringingActions}>
                {ringingAlarm.snoozeEnabled ? (
                  <Pressable
                    style={styles.ringingSecondaryButton}
                    onPress={() => void onSnooze(ringingAlarm.id)}
                  >
                    <Text style={styles.ringingSecondaryText}>稍后提醒</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.ringingPrimaryButton}
                  onPress={() => void onDismiss(ringingAlarm.id)}
                >
                  <Text style={styles.ringingPrimaryText}>停止</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : remaining ? (
          <>
            <Text style={styles.countdownHint}>{next?.snoozing ? '稍后提醒将在' : '闹钟将在'}</Text>
            <CountNumber value={remaining.days} unit="天" />
            <CountNumber value={remaining.hours} unit="小时" />
            <CountNumber value={remaining.minutes} unit="分钟后响起" />
          </>
        ) : (
          <Text style={styles.noAlarmText}>打开一个闹钟，开始新的清晨</Text>
        )}
      </View>

      {loading ? (
        <View style={styles.alarmStatusRow}>
          <ActivityIndicator color={colors.lime} />
          <Text style={styles.alarmStatusText}>正在加载闹钟…</Text>
        </View>
      ) : error ? (
        <Pressable style={styles.alarmErrorRow} onPress={() => void onRetry()}>
          <Text numberOfLines={2} style={styles.alarmErrorText}>{error}</Text>
          <Text style={styles.alarmRetryText}>点击重试</Text>
        </Pressable>
      ) : null}

      {alarmSync && (
        alarms.length > 0
        || alarmSync.state === 'pending'
        || alarmSync.state === 'syncing'
        || alarmSync.state === 'failed'
      ) ? (
        <AlarmSyncBanner status={alarmSync} onRetry={onRetrySync} />
      ) : null}

      <View style={styles.alarmList}>
        {alarms.map((alarm, index) => {
          const theme = themeById(alarm.themeId);
          return (
            <Pressable
              key={alarm.id}
              style={[
                styles.alarmCard,
                menuId === alarm.id && styles.alarmCardMenuOpen,
              ]}
              onPress={() => {
                onEdit(alarm);
                navigation.navigate('AlarmEditor');
              }}
            >
              {index === 0 ? (
                <View style={styles.alarmIconCircle}><Text style={styles.alarmIcon}>⏰</Text></View>
              ) : (
                <Image
                  source={theme.image}
                  style={styles.alarmAvatar}
                  resizeMode="cover"
                />
              )}
              <View style={styles.alarmMain}>
                <Text numberOfLines={1} adjustsFontSizeToFit style={styles.alarmDays}>{formatDays(alarm.days)}</Text>
                <Text style={styles.alarmTime}>{pad(alarm.hour)}:{pad(alarm.minute)}</Text>
                {alarm.lifecycleStatus === 'ringing' ? (
                  <Text style={[styles.lifecycleText, styles.lifecycleRinging]}>● 正在响铃</Text>
                ) : alarm.lifecycleStatus === 'snoozing' && alarm.snoozeScheduledAt ? (
                  <Text style={[styles.lifecycleText, styles.lifecycleSnoozing]}>
                    ◷ 已小睡，{formatClock(alarm.snoozeScheduledAt)} 再响
                  </Text>
                ) : null}
              </View>
              <View style={styles.alarmActions}>
                <Switch
                  value={alarm.enabled}
                  onValueChange={(enabled) => void onToggle(alarm.id, enabled)}
                  trackColor={{ false: '#D8D8DC', true: '#EEE7D9' }}
                  thumbColor={alarm.enabled ? colors.sand : '#FFFFFF'}
                />
                <Pressable
                  hitSlop={12}
                  onPress={(event) => {
                    event.stopPropagation();
                    setMenuId(menuId === alarm.id ? null : alarm.id);
                  }}
                >
                  <Text style={styles.moreText}>⋮</Text>
                </Pressable>
              </View>
              {menuId === alarm.id ? (
                <View style={styles.cardMenu}>
                  <Pressable
                    style={styles.menuRow}
                    onPress={(event) => {
                      event.stopPropagation();
                      setMenuId(null);
                      setDeleteId(alarm.id);
                    }}
                  >
                    <Text style={styles.menuLabel}>删除</Text><Text style={styles.menuIcon}>⌫</Text>
                  </Pressable>
                  <View style={styles.menuDivider} />
                  <Pressable
                    style={styles.menuRow}
                    onPress={(event) => {
                      event.stopPropagation();
                      setMenuId(null);
                      navigation.navigate('AlarmPreview', {
                        themeId: alarm.themeId,
                        soundTitle: alarm.soundTitle,
                        soundId: alarm.soundId,
                      });
                    }}
                  >
                    <Text style={styles.menuLabel}>预览闹钟</Text><Text style={styles.menuIcon}>◉</Text>
                  </Pressable>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.bottomButtonWrap}>
        <PillButton
          label="＋  添加新闹钟"
          tone="cream"
          onPress={() => {
            if (onNew()) navigation.navigate('AlarmEditor');
          }}
        />
      </View>

      <ConfirmModal
        visible={!!deleteId}
        title="删除闹钟"
        body={`确定删除 ${deleting ? `${pad(deleting.hour)}:${pad(deleting.minute)}` : '这个闹钟'} 吗？删除后无法恢复。`}
        confirmText="确认删除"
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (!deleteId) return;
          void onDelete(deleteId).then((deleted) => {
            if (deleted) setDeleteId(null);
          });
        }}
      />
    </Page>
  );
}

function AlarmSyncBanner({
  status,
  onRetry,
}: {
  status: AlarmSyncStatus;
  onRetry: () => Promise<void>;
}) {
  if (status.state === 'idle') {
    return (
      <View style={styles.syncBanner}>
        <Text style={styles.syncIdleIcon}>○</Text>
        <Text style={styles.syncBannerText}>闹钟尚未同步到底座</Text>
        <Pressable onPress={() => void onRetry()}>
          <Text style={styles.syncRetryText}>立即同步</Text>
        </Pressable>
      </View>
    );
  }
  if (status.state === 'pending' || status.state === 'syncing') {
    return (
      <View style={styles.syncBanner}>
        <ActivityIndicator size="small" color={colors.sand} />
        <View style={styles.flex}>
          <Text style={styles.syncBannerText}>
            {status.state === 'syncing' ? '底座正在缓存铃声…' : '等待底座同步…'}
          </Text>
          <Text style={styles.syncBannerHint}>同步完成后可离线响铃</Text>
        </View>
      </View>
    );
  }
  if (status.state === 'failed') {
    return (
      <View style={[styles.syncBanner, styles.syncBannerFailed]}>
        <Text style={styles.syncFailedIcon}>×</Text>
        <View style={styles.flex}>
          <Text style={styles.syncFailedText}>同步失败</Text>
          <Text numberOfLines={1} style={styles.syncBannerHint}>
            {status.message || '请检查底座网络后重试'}
          </Text>
        </View>
        <Pressable onPress={() => void onRetry()}>
          <Text style={styles.syncRetryText}>重新同步</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={[styles.syncBanner, styles.syncBannerReady]}>
      <Text style={styles.syncReadyIcon}>✓</Text>
      <View style={styles.flex}>
        <Text style={styles.syncReadyText}>已同步到底座</Text>
        <Text style={styles.syncBannerHint}>
          已安全保存 {status.cachedCount} 个闹钟，可离线响铃
        </Text>
      </View>
    </View>
  );
}

function AlarmEditorScreen({
  navigation,
  draft,
  setDraft,
  onSave,
  saving,
}: NativeStackScreenProps<AlarmStackParamList, 'AlarmEditor'> & {
  draft: AlarmDraft;
  setDraft: React.Dispatch<React.SetStateAction<AlarmDraft>>;
  onSave: () => Promise<boolean>;
  saving: boolean;
}) {
  const selectedTheme = themeById(draft.themeId);
  const updateTime = (field: 'hour' | 'minute', change: number) => {
    setDraft((current) => ({
      ...current,
      [field]: field === 'hour'
        ? (current.hour + change + 24) % 24
        : (current.minute + change + 60) % 60,
    }));
  };

  return (
    <Page scroll onSwipeBack={navigation.goBack}>
      <ScreenHeader title="设置闹钟" onBack={navigation.goBack} />
      <View style={styles.timePanel}>
        <Text style={styles.ringAfter}>闹钟会在 {formatDelay(draft.hour, draft.minute)} 后响铃</Text>
        <View style={styles.timeWheelRow}>
          <TimeWheel value={draft.hour} max={24} onUp={() => updateTime('hour', -1)} onDown={() => updateTime('hour', 1)} />
          <Text style={styles.timeColon}>:</Text>
          <TimeWheel value={draft.minute} max={60} onUp={() => updateTime('minute', -1)} onDown={() => updateTime('minute', 1)} />
        </View>
      </View>

      <View style={styles.frequencySummary}>
        <View style={styles.frequencyTitleRow}>
          <Text style={styles.sectionText}>{draft.days.length === 7 ? '每天' : '指定日期'}</Text>
          <Text style={styles.checkText}>✓  {draft.days.length === 7 ? '每天' : formatDays(draft.days)}</Text>
        </View>
        <View style={styles.weekRow}>
          {weekLabels.map((label, day) => (
            <Pressable
              key={label}
              style={[styles.dayChip, draft.days.includes(day) && styles.dayChipActive]}
              onPress={() =>
                setDraft((current) => ({
                  ...current,
                  days: current.days.includes(day)
                    ? current.days.filter((value) => value !== day)
                    : [...current.days, day].sort(),
                }))
              }
            >
              <Text style={[styles.dayChipText, draft.days.includes(day) && styles.dayChipTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={styles.inlineLinkRow} onPress={() => navigation.navigate('AlarmFrequency')}>
          <Text style={styles.sectionText}>闹钟频次</Text>
          <View style={styles.frequencyPill}>
            <Text style={styles.frequencyPillText}>
              {draft.snoozeEnabled ? `${draft.snoozeMinutes}分钟，${draft.snoozeCount === 0 ? '不限' : `${draft.snoozeCount}次`}` : '关闭'}  ›
            </Text>
          </View>
        </Pressable>
      </View>

      <Text style={styles.centerSectionTitle}>闹钟铃声</Text>
      <View style={styles.soundPanel}>
        <Pressable style={styles.soundPanelHeader} onPress={() => navigation.navigate('ThemePicker')}>
          <Text style={styles.sectionText}>快速选择</Text><Text style={styles.moreLink}>更多  ›</Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.themeStrip}>
          {themes.map((theme) => (
            <ThemeMiniCard
              key={theme.id}
              theme={theme}
              selected={theme.id === draft.themeId}
              onPress={() => setDraft((current) => ({
                ...current,
                themeId: theme.id,
                useThemeSound: true,
                soundTitle: theme.title,
              }))}
            />
          ))}
        </ScrollView>
        <Pressable style={styles.customSoundLink} onPress={() => navigation.navigate('CustomSounds')}>
          <Text style={styles.sectionText}>自定义音效</Text><Text style={styles.moreLink}>›</Text>
        </Pressable>
        <Pressable
          style={styles.selectedSoundBar}
          onPress={() => navigation.navigate('AlarmPreview', {
            themeId: draft.themeId,
            soundTitle: draft.soundTitle,
            soundId: draft.soundId,
          })}
        >
          <Text style={styles.playCircle}>▶</Text>
          <View style={styles.flex}>
            <Text numberOfLines={1} style={styles.selectedSoundText}>{draft.soundTitle}</Text>
            <Text style={styles.selectedSoundMeta}>
              {draft.useThemeSound ? `官方主题音 · ${selectedTheme.title}` : '我的自定义铃声'}
            </Text>
          </View>
        </Pressable>
      </View>

      <View style={styles.saveWrap}>
        <PillButton
          label={saving ? '保存中…' : '保存闹钟'}
          disabled={saving}
          onPress={async () => {
            if (draft.days.length === 0) {
              Alert.alert('请选择日期', '至少选择一周中的一天。');
              return;
            }
            if (await onSave()) navigation.navigate('AlarmHome');
          }}
        />
      </View>
    </Page>
  );
}

function AlarmFrequencyScreen({
  navigation,
  draft,
  setDraft,
}: NativeStackScreenProps<AlarmStackParamList, 'AlarmFrequency'> & {
  draft: AlarmDraft;
  setDraft: React.Dispatch<React.SetStateAction<AlarmDraft>>;
}) {
  return (
    <Page scroll onSwipeBack={navigation.goBack}>
      <ScreenHeader title="闹钟频次" onBack={navigation.goBack} />
      <View style={styles.settingCard}>
        <View style={styles.switchTitleRow}>
          <Text style={styles.settingTitle}>重复响铃</Text>
          <Switch
            value={draft.snoozeEnabled}
            onValueChange={(snoozeEnabled) => setDraft((current) => ({ ...current, snoozeEnabled }))}
            trackColor={{ false: '#D8D8DC', true: '#EEE7D9' }}
            thumbColor={draft.snoozeEnabled ? colors.sand : '#FFFFFF'}
          />
        </View>
      </View>
      <View style={[styles.settingCard, !draft.snoozeEnabled && styles.disabledCard]}>
        <View style={styles.switchTitleRow}>
          <Text style={styles.settingTitle}>间隔</Text><Text style={styles.settingValue}>{draft.snoozeMinutes}分钟</Text>
        </View>
        {[1, 3, 5, 10].map((minutes) => (
          <RadioRow
            key={minutes}
            label={`${minutes}分钟`}
            selected={draft.snoozeMinutes === minutes}
            onPress={() => setDraft((current) => ({ ...current, snoozeMinutes: minutes }))}
          />
        ))}
      </View>
      <View style={[styles.settingCard, !draft.snoozeEnabled && styles.disabledCard]}>
        <View style={styles.switchTitleRow}>
          <Text style={styles.settingTitle}>设置“小睡”次数</Text>
          <Text style={styles.settingValue}>{draft.snoozeCount === 0 ? '不限' : `${draft.snoozeCount}次`}</Text>
        </View>
        {[0, 1, 2, 3, 5].map((count) => (
          <RadioRow
            key={count}
            label={count === 0 ? '不限' : `${count}次`}
            selected={draft.snoozeCount === count}
            onPress={() => setDraft((current) => ({ ...current, snoozeCount: count }))}
          />
        ))}
      </View>
      <View style={styles.saveWrap}>
        <PillButton label="保存设置" onPress={navigation.goBack} />
      </View>
    </Page>
  );
}

function ThemePickerScreen({
  navigation,
  draft,
  setDraft,
}: NativeStackScreenProps<AlarmStackParamList, 'ThemePicker'> & {
  draft: AlarmDraft;
  setDraft: React.Dispatch<React.SetStateAction<AlarmDraft>>;
}) {
  const [index, setIndex] = useState(Math.max(0, themes.findIndex((item) => item.id === draft.themeId)));
  const theme = themes[index];
  const [includeAudio, setIncludeAudio] = useState(draft.useThemeSound);
  return (
    <Page scroll onSwipeBack={navigation.goBack}>
      <ScreenHeader title="音效" onBack={navigation.goBack} />
      <View style={styles.themePickerWrap}>
        <ThemeHero theme={theme} showSound={includeAudio} />
        <View style={styles.pagerDots}>
          {themes.map((item, itemIndex) => (
            <Pressable
              key={item.id}
              onPress={() => setIndex(itemIndex)}
              style={[styles.pagerDot, itemIndex === index && styles.pagerDotActive]}
            />
          ))}
        </View>
        <View style={styles.themePickerTitleRow}>
          <Text style={styles.previewCaption}>#{theme.title}</Text>
          <Text style={styles.waveText}>▂▅▃▇▂▆▃▅▂</Text>
        </View>
        <Pressable style={styles.audioToggleRow} onPress={() => setIncludeAudio((value) => !value)}>
          <View style={[styles.audioToggle, !includeAudio && styles.audioToggleOff]}>
            <Text style={styles.audioToggleText}>{includeAudio ? '♪' : '×'}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.audioToggleTitle}>{includeAudio ? '使用官方提示音' : '仅使用主题皮肤'}</Text>
            <Text style={styles.audioToggleHint}>{includeAudio ? theme.soundTitle : '保存后可在下方选择自定义铃声'}</Text>
          </View>
        </Pressable>
      </View>
      <View style={styles.saveWrap}>
        <PillButton
          label="选择"
          onPress={() => {
            setDraft((current) => ({
              ...current,
              themeId: theme.id,
              useThemeSound: includeAudio,
              soundTitle: includeAudio ? theme.title : current.soundTitle,
            }));
            navigation.goBack();
          }}
        />
      </View>
    </Page>
  );
}

function AlarmPreviewScreen({
  navigation,
  route,
  token,
}: NativeStackScreenProps<AlarmStackParamList, 'AlarmPreview'> & { token: string }) {
  const theme = themeById(route.params.themeId);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const customSoundId = route.params.soundId;

  const stopPreview = useCallback(async () => {
    const sound = soundRef.current;
    if (!sound) {
      setPlaying(false);
      return;
    }
    await sound.stopAsync().catch(() => undefined);
    await sound.unloadAsync().catch(() => undefined);
    soundRef.current = null;
    setPlaying(false);
  }, []);

  const startPreview = useCallback(async () => {
    if (!customSoundId) {
      setPlaying(true);
      return;
    }
    setLoading(true);
    try {
      if (soundRef.current) await soundRef.current.unloadAsync().catch(() => undefined);
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const playback = await api.alarmSoundPlaybackUrl(token, customSoundId);
      const created = await Audio.Sound.createAsync(
        { uri: playback.url },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded && status.didJustFinish) setPlaying(false);
        },
      );
      soundRef.current = created.sound;
      setPlaying(true);
    } catch (caught) {
      Alert.alert('预览失败', caught instanceof Error ? caught.message : '无法播放这个铃声');
      setPlaying(false);
    } finally {
      setLoading(false);
    }
  }, [customSoundId, token]);

  useEffect(() => {
    void startPreview();
    return () => {
      if (soundRef.current) void soundRef.current.unloadAsync().catch(() => undefined);
      soundRef.current = null;
    };
    // Only start automatically when this preview page is first opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exitPreview = async () => {
    await stopPreview();
    navigation.goBack();
  };

  return (
    <Page scroll onSwipeBack={navigation.goBack}>
      <ScreenHeader title="预览闹钟" onBack={navigation.goBack} />
      <View style={styles.previewWrap}>
        <ThemeHero theme={theme} showSound />
        <View style={styles.themePickerTitleRow}>
          <Text style={styles.previewCaption}>#{route.params.soundTitle}</Text>
          <View style={styles.animatedWave}>
            {[10, 22, 14, 30, 18, 34, 13, 26, 16, 31, 12].map((height, index) => (
              <View
                key={`${height}-${index}`}
                style={[styles.waveBar, { height: playing ? height : 6 }]}
              />
            ))}
          </View>
        </View>
        <Text style={styles.previewHint}>
          {loading
            ? '正在加载铃声…'
            : playing
              ? customSoundId ? '正在播放自定义铃声' : '正在预览官方主题'
              : '预览已停止'}
        </Text>
      </View>
      <View style={styles.saveWrap}>
        <PillButton
          label={playing ? '退出预览' : loading ? '加载中…' : '重新预览'}
          disabled={loading}
          onPress={() => playing ? void exitPreview() : void startPreview()}
        />
        {playing ? (
          <Pressable style={styles.pauseLink} onPress={() => void stopPreview()}>
            <Text style={styles.pauseLinkText}>停止预览</Text>
          </Pressable>
        ) : null}
      </View>
    </Page>
  );
}

function CustomSoundsScreen({
  navigation,
  sounds,
  onUpload,
  onDelete,
  onSelect,
}: NativeStackScreenProps<AlarmStackParamList, 'CustomSounds'> & {
  sounds: AlarmSound[];
  onUpload: (file: { uri: string; name: string; type: string }) => Promise<AlarmSound>;
  onDelete: (soundId: string) => Promise<{ deleted: boolean; deletedAlarms: number }>;
  onSelect: (sound: AlarmSound) => void;
}) {
  const [tab, setTab] = useState<'recording' | 'diy'>('recording');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [addVisible, setAddVisible] = useState(false);
  const [uploading, setUploading] = useState(false);
  const filtered = sounds.filter((sound) => sound.kind === tab);
  const deleting = sounds.find((sound) => sound.id === deleteId);
  return (
    <Page onSwipeBack={navigation.goBack}>
      <ScreenHeader title="自定义闹铃" onBack={navigation.goBack} />
      <View style={styles.soundTabs}>
        <SegmentButton label="♩  录音" active={tab === 'recording'} onPress={() => setTab('recording')} />
        <SegmentButton label="▣  DIY" active={tab === 'diy'} onPress={() => setTab('diy')} />
      </View>
      <View style={styles.customList}>
        {filtered.length ? filtered.map((sound) => (
          <Pressable
            key={sound.id}
            style={styles.customSoundRow}
            onPress={() => {
              if (sound.status !== 'ready') {
                Alert.alert(
                  sound.status === 'failed' ? '生成失败' : '正在生成',
                  sound.errorMessage || '请等待铃声生成完成。',
                );
                return;
              }
              onSelect(sound);
              navigation.navigate('AlarmEditor');
            }}
          >
            <View style={[styles.listPlay, sound.kind === 'diy' && styles.listPlaySelected]}>
              {sound.status === 'processing' ? (
                <ActivityIndicator size="small" color={colors.ink} />
              ) : (
                <Text style={styles.listPlayText}>{sound.status === 'failed' ? '!' : sound.kind === 'diy' ? '✓' : '▶'}</Text>
              )}
            </View>
            <View style={styles.flex}>
              <Text style={styles.customSoundTitle}>{sound.title}</Text>
              <Text style={styles.selectedSoundMeta}>
                {sound.status === 'processing' ? '正在复刻音色并合成…' : sound.status === 'failed' ? '生成失败，点击查看' : sound.kind === 'diy' ? 'AI DIY 铃声' : '原音频铃声'}
              </Text>
            </View>
            <Pressable
              hitSlop={12}
              onPress={(event) => {
                event.stopPropagation();
                setMenuId(menuId === sound.id ? null : sound.id);
              }}
            >
              <Text style={styles.moreText}>⋮</Text>
            </Pressable>
            {menuId === sound.id ? (
              <Pressable
                style={styles.soundDeleteMenu}
                onPress={() => {
                  setMenuId(null);
                  setDeleteId(sound.id);
                }}
              >
                <Text style={styles.soundDeleteText}>删除　⌫</Text>
              </Pressable>
            ) : null}
          </Pressable>
        )) : (
          <View style={styles.emptySounds}>
            <Text style={styles.emptySoundsIcon}>♩</Text>
            <Text style={styles.emptySoundsText}>这里还没有{tab === 'recording' ? '录音' : 'AI DIY'}铃声</Text>
          </View>
        )}
      </View>
      <View style={styles.bottomButtonWrap}>
        <PillButton label="＋  添加新闹铃" onPress={() => setAddVisible(true)} />
      </View>

      <Modal transparent animationType="slide" visible={addVisible} onRequestClose={() => setAddVisible(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setAddVisible(false)}>
          <Pressable style={styles.actionSheet} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>添加我自己的</Text>
            <Pressable
              style={styles.sourceRow}
              onPress={async () => {
                try {
                  setAddVisible(false);
                  const result = await DocumentPicker.getDocumentAsync({
                    type: 'audio/*',
                    copyToCacheDirectory: true,
                    multiple: false,
                  });
                  if (result.canceled) return;
                  const asset = result.assets[0];
                  setUploading(true);
                  const sound = await onUpload({
                    uri: asset.uri,
                    name: asset.name || '导入音频.m4a',
                    type: asset.mimeType || 'audio/mp4',
                  });
                  navigation.navigate('SoundCopy', {
                    sourceId: sound.id,
                    sourceName: sound.sourceName,
                    sourceKind: 'file',
                  });
                } catch (caught) {
                  Alert.alert('导入失败', caught instanceof Error ? caught.message : '无法导入这个音频');
                } finally {
                  setUploading(false);
                }
              }}
            >
              <Text style={styles.sourceIcon}>▰</Text>
              <View style={styles.flex}><Text style={styles.sourceTitle}>{uploading ? '正在上传…' : '从文件导入'}</Text><Text style={styles.sourceHint}>支持 WAV、MP3、M4A，最大 12MB</Text></View>
              <Text style={styles.sourceArrow}>›</Text>
            </Pressable>
            <Pressable
              style={styles.sourceRow}
              onPress={() => {
                setAddVisible(false);
                navigation.navigate('RecordSound');
              }}
            >
              <Text style={styles.sourceIcon}>◉</Text>
              <View style={styles.flex}><Text style={styles.sourceTitle}>录制</Text><Text style={styles.sourceHint}>录一段清晰的人声样本</Text></View>
              <Text style={styles.sourceArrow}>›</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <ConfirmModal
        visible={!!deleteId}
        title="删除铃声"
        body={`您有待执行的闹铃可能使用了“${deleting?.title ?? '当前铃声'}”。删除后，使用此铃声的闹钟也会一起删除。`}
        confirmText="确认删除"
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (!deleteId) return;
          void onDelete(deleteId).then((result) => {
            setDeleteId(null);
            if (result.deletedAlarms) {
              Alert.alert('已删除', `铃声和引用它的 ${result.deletedAlarms} 个闹钟已删除。`);
            }
          }).catch((caught) => {
            Alert.alert('删除失败', caught instanceof Error ? caught.message : '请稍后重试');
          });
        }}
      />
    </Page>
  );
}

function RecordSoundScreen({
  navigation,
  onUpload,
}: NativeStackScreenProps<AlarmStackParamList, 'RecordSound'> & {
  onUpload: (file: { uri: string; name: string; type: string }) => Promise<AlarmSound>;
}) {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const start = async () => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('需要麦克风权限', '请允许屿宙AI手办使用麦克风后再录制。');
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const created = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      setSeconds(0);
      setRecording(created.recording);
    } catch (caught) {
      Alert.alert('无法开始录音', caught instanceof Error ? caught.message : '请稍后重试');
    }
  };

  const stop = async (allowShort = false) => {
    if (!recording) return;
    if (seconds < 10 && !allowShort) {
      Alert.alert(
        '录音不足 10 秒',
        `目前录了 ${seconds} 秒，可以继续录满 10 秒用于音色复刻，或仅保存为普通闹铃。`,
        [
          { text: '继续录制', style: 'cancel' },
          { text: '仅保存原音频', onPress: () => void stop(true) },
        ],
      );
      return;
    }
    const current = recording;
    setRecording(null);
    setUploading(true);
    try {
      await current.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = current.getURI();
      if (!uri) throw new Error('没有取得录音文件');
      const sound = await onUpload({
        uri,
        name: `我的录音_${Date.now()}.m4a`,
        type: 'audio/mp4',
      });
      navigation.navigate('SoundCopy', {
        sourceId: sound.id,
        sourceName: `我的录音 ${formatSeconds(seconds)}`,
        sourceKind: 'recording',
      });
    } catch (caught) {
      Alert.alert('录音上传失败', caught instanceof Error ? caught.message : '请稍后重试');
    } finally {
      setUploading(false);
    }
  };
  const leaveRecording = () => {
    if (recording) {
      void recording.stopAndUnloadAsync();
      setRecording(null);
      void Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    }
    navigation.goBack();
  };
  return (
    <Page onSwipeBack={leaveRecording}>
      <ScreenHeader title="录制铃声" onBack={leaveRecording} />
      <View style={styles.recordingCard}>
        <Text style={styles.recordingTitle}>{uploading ? '正在上传' : recording ? '正在录制' : '准备录制'}</Text>
        <Text style={styles.recordingHint}>建议录制 10～20 秒连续、清晰、无背景音乐的人声</Text>
        <View style={styles.recordWave}>
          {Array.from({ length: 35 }).map((_, index) => (
            <View
              key={index}
              style={[styles.recordWaveBar, { height: recording ? 12 + ((index * 13) % 44) : 8 }]}
            />
          ))}
        </View>
        <Text style={styles.recordTime}>{formatSeconds(seconds)}</Text>
        <Pressable
          style={styles.recordButton}
          disabled={uploading}
          onPress={() => recording ? void stop() : void start()}
        >
          <View style={recording ? styles.stopSquare : styles.recordDot} />
        </Pressable>
        <Text style={styles.recordAction}>{uploading ? '正在上传腾讯 COS…' : recording ? '点击停止并使用' : '点击开始录制'}</Text>
      </View>
    </Page>
  );
}

function SoundCopyScreen({
  navigation,
  route,
  onDirectUse,
  onSynthesize,
}: NativeStackScreenProps<AlarmStackParamList, 'SoundCopy'> & {
  onDirectUse: (soundId: string, title: string) => void;
  onSynthesize: (
    sourceId: string,
    input: { title: string; text: string; backgroundMusicId?: string | null },
  ) => Promise<AlarmSound>;
}) {
  const [copy, setCopy] = useState('');
  const [name, setName] = useState('DIY闹铃');
  const [backgroundMusicId, setBackgroundMusicId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  return (
    <Page scroll onSwipeBack={navigation.goBack}>
      <ScreenHeader title="编辑闹钟文案" onBack={navigation.goBack} />
      <View style={styles.sourceBadge}>
        <Text style={styles.sourceBadgeLabel}>{route.params.sourceKind === 'file' ? '已导入文件' : '已完成录音'}</Text>
        <Text style={styles.sourceBadgeName}>{route.params.sourceName}</Text>
      </View>
      <View style={styles.copyBox}>
        <TextInput
          value={copy}
          onChangeText={(value) => setCopy(value.slice(0, 50))}
          placeholder="请输入您想要的闹铃文案"
          placeholderTextColor={colors.muted}
          multiline
          style={styles.copyInput}
        />
        <Text style={styles.copyCount}>{copy.length}/50</Text>
      </View>
      <Text style={styles.nameLabel}>设置铃声名称</Text>
      <TextInput value={name} onChangeText={setName} style={styles.nameInput} placeholder="给铃声起个名字" />
      <Text style={styles.nameLabel}>背景音乐（可选）</Text>
      <View style={styles.settingCard}>
        {[
          { id: null, label: '不添加背景音乐' },
          { id: 'morning-chime', label: '清晨轻铃' },
          { id: 'soft-light', label: '柔和晨光' },
        ].map((item) => (
          <RadioRow
            key={item.id || 'none'}
            label={item.label}
            selected={backgroundMusicId === item.id}
            onPress={() => setBackgroundMusicId(item.id)}
          />
        ))}
      </View>
      <View style={styles.processNote}>
        <Text style={styles.processNoteTitle}>接下来会做什么？</Text>
        <Text style={styles.processNoteBody}>音频已上传腾讯 COS。选择合成后将复刻音色 → 根据文案生成语音 → 混合可选背景音乐。</Text>
      </View>
      <View style={styles.saveWrap}>
        <PillButton
          label={submitting ? '正在创建任务…' : '合成闹铃'}
          disabled={submitting || !copy.trim() || !name.trim()}
          onPress={async () => {
            setSubmitting(true);
            try {
              const sound = await onSynthesize(route.params.sourceId, {
                title: name.trim(),
                text: copy.trim(),
                backgroundMusicId,
              });
              navigation.navigate('Synthesizing', { soundId: sound.id });
            } catch (caught) {
              Alert.alert('创建失败', caught instanceof Error ? caught.message : '请稍后重试');
            } finally {
              setSubmitting(false);
            }
          }}
        />
        <Pressable
          disabled={submitting}
          style={styles.pauseLink}
          onPress={() => {
            const title = name.trim() || route.params.sourceName;
            onDirectUse(route.params.sourceId, title);
            navigation.navigate('AlarmEditor');
          }}
        >
          <Text style={styles.pauseLinkText}>直接使用原音频，不复刻</Text>
        </Pressable>
      </View>
    </Page>
  );
}

function SynthesizingScreen({
  navigation,
  route,
  token,
  onComplete,
}: NativeStackScreenProps<AlarmStackParamList, 'Synthesizing'> & {
  token: string;
  onComplete: (sound: AlarmSound) => void;
}) {
  const [progress, setProgress] = useState(1);
  const [sound, setSound] = useState<AlarmSound | null>(null);
  const [completed, setCompleted] = useState(false);
  const done = sound?.status === 'ready';
  const failed = sound?.status === 'failed';
  useEffect(() => {
    const timer = setInterval(() => setProgress((value) => Math.min(3, value + 1)), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const sounds = await api.listAlarmSounds(token);
        const current = sounds.find((item) => item.id === route.params.soundId);
        if (active && current) setSound(current);
      } catch {
        // Keep polling; a temporary network interruption should not cancel cloud synthesis.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [route.params.soundId, token]);
  useEffect(() => {
    if (done && sound && !completed) {
      onComplete(sound);
      setCompleted(true);
    }
  }, [completed, done, onComplete, sound]);
  const labels = ['正在准备音色复刻', '正在生成专属音色', '正在合成闹铃语音', '正在制作最终铃声'];
  return (
    <Page onSwipeBack={navigation.goBack}>
      <ScreenHeader title="DIY闹铃合成" onBack={navigation.goBack} />
      <View style={styles.synthCenter}>
        {done ? <Text style={styles.doneIcon}>✓</Text> : failed ? <Text style={[styles.doneIcon, { color: colors.danger }]}>!</Text> : <ActivityIndicator size="large" color={colors.lime} />}
        <Text style={styles.synthTitle}>{done ? '铃声生成完成' : failed ? '铃声生成失败' : '您的铃声正在合成中，请稍等'}</Text>
        <Text style={styles.synthSub}>{done ? `“${sound?.title}”已经加入 DIY 铃声库` : failed ? sound?.errorMessage : labels[Math.min(progress, labels.length - 1)]}</Text>
        <View style={styles.progressTrack}><View style={[styles.progressValue, { width: `${done ? 100 : Math.min(88, progress * 24)}%` }]} /></View>
        <Text style={styles.stageHint}>{failed ? '原始录音仍保留在“录音”列表，可重试或直接使用。' : '可以离开此页面，云端任务仍会继续执行。'}</Text>
      </View>
      <View style={styles.bottomButtonWrap}>
        <PillButton
          label={done ? '使用这个铃声' : failed ? '返回修改' : '生成中'}
          disabled={!done && !failed}
          onPress={() => done ? navigation.navigate('AlarmEditor') : navigation.goBack()}
        />
      </View>
    </Page>
  );
}

function Page({
  children,
  scroll = false,
  onSwipeBack,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  onSwipeBack?: () => void;
}) {
  return (
    <SafeAreaView style={styles.safeArea}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollPage} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={styles.page}>{children}</View>
      )}
      {Platform.OS === 'android' && onSwipeBack ? <EdgeSwipeBack onBack={onSwipeBack} /> : null}
    </SafeAreaView>
  );
}

function EdgeSwipeBack({ onBack }: { onBack: () => void }) {
  const [dragDistance, setDragDistance] = useState(0);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const responder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        gesture.dx > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.35,
      onPanResponderMove: (_event, gesture) => {
        setDragDistance(Math.max(0, Math.min(96, gesture.dx)));
      },
      onPanResponderRelease: (_event, gesture) => {
        const shouldGoBack = gesture.dx >= 68 || (gesture.dx >= 34 && gesture.vx >= 0.55);
        setDragDistance(0);
        if (shouldGoBack) onBackRef.current();
      },
      onPanResponderTerminate: () => setDragDistance(0),
      onPanResponderTerminationRequest: () => false,
    }),
    [],
  );
  return (
    <View style={styles.edgeSwipeZone} {...responder.panHandlers}>
      <View
        pointerEvents="none"
        style={[
          styles.edgeSwipeHint,
          {
            opacity: Math.min(1, dragDistance / 36),
            transform: [{ translateX: Math.min(32, dragDistance * 0.35) }],
          },
        ]}
      >
        <Text style={styles.edgeSwipeHintText}>‹</Text>
      </View>
    </View>
  );
}

function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View style={styles.screenHeader}>
      <Pressable style={styles.backSlot} onPress={onBack} disabled={!onBack} hitSlop={12}>
        <Text style={styles.backText}>{onBack ? '‹' : ''}</Text>
      </Pressable>
      <Text style={styles.screenTitle}>{title}</Text>
      <View style={styles.backSlot} />
    </View>
  );
}

function CountNumber({ value, unit }: { value: number; unit: string }) {
  return <View style={styles.countItem}><Text style={styles.countValue}>{pad(value)}</Text><Text style={styles.countUnit}>{unit}</Text></View>;
}

function TimeWheel({ value, max, onUp, onDown }: { value: number; max: number; onUp: () => void; onDown: () => void }) {
  return (
    <View style={styles.timeWheel}>
      <Pressable onPress={onUp}><Text style={styles.wheelFaded}>{pad((value - 1 + max) % max)}</Text></Pressable>
      <Text style={styles.wheelSelected}>{pad(value)}</Text>
      <Pressable onPress={onDown}><Text style={styles.wheelFaded}>{pad((value + 1) % max)}</Text></Pressable>
    </View>
  );
}

function ThemeMiniCard({ theme, selected, onPress }: { theme: AlarmTheme; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.themeMiniCard, { backgroundColor: theme.tint }]}>
      {theme.image ? <ImageBackground source={theme.image} style={styles.themeMiniImage} imageStyle={styles.themeMiniImageRadius} /> : null}
      <View style={styles.themeMiniShade} />
      {selected ? <View style={styles.miniCheck}><Text style={styles.miniCheckText}>✓</Text></View> : null}
      <Text numberOfLines={2} style={styles.themeMiniTitle}>{theme.title}</Text>
      <Text numberOfLines={1} style={styles.themeMiniSound}>♩ {theme.soundTitle}</Text>
    </Pressable>
  );
}

function ThemeHero({ theme, showSound }: { theme: AlarmTheme; showSound: boolean }) {
  const { width, height } = useWindowDimensions();
  const heroHeight = Math.min((width - 36) * 1.24, height * 0.46);
  return (
    <ImageBackground source={theme.image} style={[styles.themeHero, { height: heroHeight }]} imageStyle={styles.themeHeroImage}>
      <View style={styles.themeHeroShade} />
      <Text style={styles.themeHeroSound}>♩　{showSound ? '自定义铃声' : '仅主题皮肤'}</Text>
    </ImageBackground>
  );
}

function RadioRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.radioRow} onPress={onPress}>
      <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>{selected ? <View style={styles.radioInner} /> : null}</View>
      <Text style={styles.radioLabel}>{label}</Text>
    </Pressable>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.segment, active && styles.segmentActive]}>
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function PillButton({ label, onPress, tone = 'green', disabled = false }: { label: string; onPress: () => void; tone?: 'green' | 'cream'; disabled?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.pillButton, tone === 'cream' && styles.pillButtonCream, disabled && styles.pillDisabled]}>
      <Text style={[styles.pillButtonText, tone === 'cream' && styles.pillButtonCreamText]}>{label}</Text>
    </Pressable>
  );
}

function ConfirmModal({ visible, title, body, confirmText, onClose, onConfirm }: { visible: boolean; title: string; body: string; confirmText: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.confirmCard}>
          <Pressable style={styles.modalClose} onPress={onClose}><Text style={styles.modalCloseText}>×</Text></Pressable>
          <Text style={styles.confirmTitle}>{title}</Text>
          <Text style={styles.confirmBody}>{body}</Text>
          <PillButton label={confirmText} onPress={onConfirm} />
        </View>
      </View>
    </Modal>
  );
}

function themeById(id: string) {
  return themes.find((theme) => theme.id === id) ?? themes[0];
}

function nextAlarmAt(alarm: AlarmItem, now: Date) {
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(alarm.hour, alarm.minute, 0, 0);
    if (alarm.days.includes(candidate.getDay()) && candidate.getTime() > now.getTime()) return candidate;
  }
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
}

function formatCountdown(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60000));
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

function formatDelay(hour: number, minute: number) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  const totalMinutes = Math.ceil((target.getTime() - now.getTime()) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}小时${minutes}分钟`;
}

function formatDays(days: number[]) {
  if (days.length === 7) return '每天';
  if (days.length === 0) return '未选择';
  return days.map((day) => weekLabels[day]).join('　');
}

function formatSeconds(seconds: number) {
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function formatClock(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : '--:--';
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.canvas },
  page: { flex: 1, paddingHorizontal: 18 },
  scrollPage: { flexGrow: 1, paddingHorizontal: 18, paddingBottom: 28 },
  edgeSwipeZone: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 26, zIndex: 1000, justifyContent: 'center' },
  edgeSwipeHint: { width: 44, height: 44, marginLeft: -22, borderRadius: 22, backgroundColor: 'rgba(17, 17, 17, 0.72)', alignItems: 'flex-end', justifyContent: 'center', paddingRight: 7 },
  edgeSwipeHintText: { color: '#FFFFFF', fontSize: 35, lineHeight: 38, fontWeight: '300' },
  flex: { flex: 1 },
  screenHeader: { height: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backSlot: { width: 42, height: 42, alignItems: 'flex-start', justifyContent: 'center' },
  backText: { color: colors.ink, fontSize: 42, lineHeight: 42, fontWeight: '300' },
  screenTitle: { color: colors.ink, fontSize: 21, fontWeight: '500' },
  countdownRow: { minHeight: 82, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  countdownHint: { color: colors.muted, fontSize: 15 },
  ringingBanner: { width: '100%', minHeight: 94, borderRadius: 16, backgroundColor: '#FFF2F0', paddingHorizontal: 15, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  ringingIcon: { fontSize: 28 },
  ringingTitle: { color: colors.danger, fontSize: 17, fontWeight: '800' },
  ringingSubtitle: { color: '#8E625F', fontSize: 12, marginTop: 3 },
  ringingActions: { flexDirection: 'row', gap: 8, marginTop: 9 },
  ringingSecondaryButton: { minWidth: 74, height: 30, borderRadius: 15, borderWidth: 1, borderColor: '#DDA7A2', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  ringingSecondaryText: { color: '#A85750', fontSize: 12, fontWeight: '700' },
  ringingPrimaryButton: { minWidth: 62, height: 30, borderRadius: 15, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  ringingPrimaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  countItem: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  countValue: { color: colors.ink, fontSize: 26, lineHeight: 32, borderBottomWidth: 2, borderBottomColor: colors.ink, fontWeight: '600' },
  countUnit: { color: colors.muted, fontSize: 15, marginBottom: 3 },
  noAlarmText: { color: colors.muted, fontSize: 15 },
  alarmStatusRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  alarmStatusText: { color: colors.muted, fontSize: 13 },
  alarmErrorRow: { minHeight: 48, borderRadius: 10, backgroundColor: '#FFF2F0', paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  alarmErrorText: { flex: 1, color: colors.danger, fontSize: 12 },
  alarmRetryText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  syncBanner: { minHeight: 54, borderRadius: 13, backgroundColor: '#F8F4EA', paddingHorizontal: 13, paddingVertical: 9, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  syncBannerReady: { backgroundColor: '#F1F8E9' },
  syncBannerFailed: { backgroundColor: '#FFF2F0' },
  syncBannerText: { color: '#675C47', fontSize: 13, fontWeight: '700' },
  syncBannerHint: { color: colors.muted, fontSize: 11, marginTop: 2 },
  syncIdleIcon: { color: colors.sand, fontSize: 22, fontWeight: '700' },
  syncReadyIcon: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.green, color: '#FFFFFF', textAlign: 'center', lineHeight: 24, fontSize: 15, fontWeight: '800' },
  syncReadyText: { color: '#4C8F42', fontSize: 13, fontWeight: '800' },
  syncFailedIcon: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.danger, color: '#FFFFFF', textAlign: 'center', lineHeight: 23, fontSize: 19, fontWeight: '700' },
  syncFailedText: { color: colors.danger, fontSize: 13, fontWeight: '800' },
  syncRetryText: { color: '#8C7447', fontSize: 12, fontWeight: '800' },
  alarmList: { gap: 16, marginTop: 5, overflow: 'visible' },
  alarmCard: { minHeight: 120, backgroundColor: colors.cream, borderRadius: 17, padding: 16, flexDirection: 'row', alignItems: 'center', overflow: 'visible', zIndex: 1 },
  alarmCardMenuOpen: { zIndex: 30, elevation: 30 },
  alarmIconCircle: { width: 66, height: 66, borderRadius: 33, backgroundColor: colors.sand, alignItems: 'center', justifyContent: 'center' },
  alarmIcon: { fontSize: 31 },
  alarmAvatar: { width: 66, height: 66, borderRadius: 33 },
  alarmMain: { flex: 1, marginLeft: 18 },
  alarmDays: { color: colors.ink, fontSize: 14, letterSpacing: 0.2 },
  alarmTime: { color: colors.ink, fontSize: 34, fontWeight: '800', marginTop: 2 },
  lifecycleText: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  lifecycleRinging: { color: colors.danger },
  lifecycleSnoozing: { color: '#927A4B' },
  alarmActions: { alignSelf: 'stretch', justifyContent: 'space-between', alignItems: 'flex-end' },
  moreText: { color: '#8E8E8E', fontSize: 33, lineHeight: 34 },
  cardMenu: { position: 'absolute', zIndex: 40, right: 42, top: 75, width: 145, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#FFFFFF', borderRadius: 12, shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 40 },
  menuRow: { height: 39, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  menuLabel: { color: colors.muted, fontSize: 16 },
  menuIcon: { color: colors.muted, fontSize: 19 },
  menuDivider: { height: 1, backgroundColor: colors.line },
  bottomButtonWrap: { marginTop: 'auto', paddingHorizontal: 48, paddingBottom: 22, paddingTop: 20 },
  pillButton: { height: 58, backgroundColor: colors.lime, borderRadius: 30, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  pillButtonCream: { backgroundColor: colors.cream },
  pillButtonText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  pillButtonCreamText: { color: colors.ink },
  pillDisabled: { opacity: 0.42 },
  timePanel: { backgroundColor: colors.cream, borderRadius: 14, overflow: 'hidden' },
  ringAfter: { textAlign: 'center', color: colors.ink, fontSize: 15, paddingTop: 14 },
  timeWheelRow: { height: 177, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream },
  timeWheel: { width: 105, alignItems: 'center', gap: 3 },
  wheelFaded: { color: '#B9B5AC', fontSize: 24, paddingVertical: 4 },
  wheelSelected: { color: '#FFFFFF', backgroundColor: '#999999', fontSize: 31, width: 105, textAlign: 'center', paddingVertical: 7 },
  timeColon: { fontSize: 30, color: colors.ink, marginHorizontal: 4 },
  frequencySummary: { backgroundColor: colors.cream, borderRadius: 14, padding: 15, marginTop: 16 },
  frequencyTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionText: { color: colors.ink, fontSize: 17, fontWeight: '500' },
  checkText: { color: colors.danger, fontSize: 14 },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 18 },
  dayChip: { width: 39, height: 39, borderRadius: 9, backgroundColor: colors.sand, alignItems: 'center', justifyContent: 'center' },
  dayChipActive: { backgroundColor: colors.charcoal },
  dayChipText: { color: '#FFFFFF', fontSize: 15 },
  dayChipTextActive: { fontWeight: '800' },
  inlineLinkRow: { minHeight: 48, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  frequencyPill: { backgroundColor: colors.charcoal, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  frequencyPillText: { color: '#FFFFFF', fontSize: 13 },
  centerSectionTitle: { textAlign: 'center', color: colors.ink, fontSize: 17, marginTop: 22, marginBottom: 10 },
  soundPanel: { backgroundColor: colors.cream, borderRadius: 14, padding: 14 },
  soundPanelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  moreLink: { color: colors.ink, fontSize: 15 },
  themeStrip: { gap: 10, paddingVertical: 14 },
  themeMiniCard: { width: 116, height: 150, borderRadius: 11, overflow: 'hidden', justifyContent: 'flex-end', padding: 9 },
  themeMiniImage: { ...StyleSheet.absoluteFillObject },
  themeMiniImageRadius: { borderRadius: 11 },
  themeMiniShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.22)' },
  miniCheck: { position: 'absolute', right: 7, top: 7, width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  miniCheckText: { color: colors.danger, fontWeight: '900' },
  themeMiniTitle: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  themeMiniSound: { color: '#FFFFFF', fontSize: 11, marginTop: 5 },
  customSoundLink: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  selectedSoundBar: { minHeight: 66, borderRadius: 9, backgroundColor: colors.charcoal, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, gap: 10 },
  playCircle: { color: '#FFFFFF', backgroundColor: '#767676', width: 32, height: 32, borderRadius: 16, textAlign: 'center', lineHeight: 32, fontSize: 13 },
  selectedSoundText: { color: '#FFFFFF', fontSize: 15 },
  selectedSoundMeta: { color: '#C5C5C5', fontSize: 10, marginTop: 3 },
  saveWrap: { marginTop: 28, paddingHorizontal: 48, paddingBottom: 4 },
  settingCard: { backgroundColor: colors.cream, borderRadius: 15, padding: 20, marginBottom: 16 },
  disabledCard: { opacity: 0.45 },
  switchTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  settingTitle: { color: colors.ink, fontSize: 21, fontWeight: '500' },
  settingValue: { color: colors.ink, fontSize: 18 },
  radioRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 13 },
  radioOuter: { width: 30, height: 30, borderRadius: 15, borderWidth: 1.5, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  radioOuterSelected: { borderWidth: 7, borderColor: '#D2D3D5' },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#FFFFFF' },
  radioLabel: { color: colors.ink, fontSize: 18 },
  themePickerWrap: { flex: 1 },
  themeHero: { width: '100%', borderRadius: 14, overflow: 'hidden', justifyContent: 'flex-end', padding: 20 },
  themeHeroImage: { borderRadius: 14 },
  themeHeroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.08)' },
  themeHeroSound: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  pagerDots: { height: 28, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 },
  pagerDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#D8D8D8' },
  pagerDotActive: { width: 19, backgroundColor: colors.lime },
  themePickerTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  previewCaption: { color: colors.ink, fontSize: 20, fontWeight: '800', flex: 1 },
  waveText: { color: colors.ink, fontSize: 18, letterSpacing: -2 },
  audioToggleRow: { marginTop: 18, padding: 13, borderRadius: 13, backgroundColor: colors.cream, flexDirection: 'row', alignItems: 'center', gap: 12 },
  audioToggle: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center' },
  audioToggleOff: { backgroundColor: colors.charcoal },
  audioToggleText: { color: '#FFFFFF', fontSize: 21, fontWeight: '800' },
  audioToggleTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  audioToggleHint: { color: colors.muted, fontSize: 11, marginTop: 3 },
  previewWrap: { flex: 1 },
  animatedWave: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 3 },
  waveBar: { width: 3, borderRadius: 2, backgroundColor: colors.ink },
  previewHint: { color: colors.muted, textAlign: 'center', fontSize: 12, marginTop: 18 },
  pauseLink: { alignItems: 'center', padding: 12 },
  pauseLinkText: { color: colors.muted, fontSize: 13 },
  soundTabs: { flexDirection: 'row', gap: 24, paddingVertical: 12 },
  segment: { height: 44, minWidth: 108, paddingHorizontal: 17, borderRadius: 23, backgroundColor: '#AAAAAA', alignItems: 'center', justifyContent: 'center' },
  segmentActive: { backgroundColor: colors.charcoal },
  segmentText: { color: '#E1E1E1', fontSize: 18 },
  segmentTextActive: { color: '#FFFFFF', fontWeight: '700' },
  customList: { gap: 12, marginTop: 8 },
  customSoundRow: { minHeight: 58, backgroundColor: colors.cream, borderRadius: 12, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },
  listPlay: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.sand, alignItems: 'center', justifyContent: 'center' },
  listPlaySelected: { backgroundColor: colors.green },
  listPlayText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  customSoundTitle: { flex: 1, color: colors.ink, fontSize: 17 },
  soundDeleteMenu: { position: 'absolute', zIndex: 5, right: 10, top: 52, width: 144, height: 48, borderRadius: 10, backgroundColor: '#666666', alignItems: 'center', justifyContent: 'center', elevation: 7 },
  soundDeleteText: { color: '#FFFFFF', fontSize: 16 },
  emptySounds: { alignItems: 'center', paddingTop: 60 },
  emptySoundsIcon: { color: colors.sand, fontSize: 56 },
  emptySoundsText: { color: colors.muted, fontSize: 14, marginTop: 10 },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  actionSheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, gap: 14 },
  sheetHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: '#D2D2D2', alignSelf: 'center' },
  sheetTitle: { color: colors.ink, fontSize: 21, fontWeight: '700', marginBottom: 12 },
  sourceRow: { minHeight: 82, backgroundColor: '#EFEFEF', borderRadius: 13, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 14 },
  sourceIcon: { color: '#777777', fontSize: 28 },
  sourceTitle: { color: '#555555', fontSize: 17, fontWeight: '600' },
  sourceHint: { color: colors.muted, fontSize: 11, marginTop: 3 },
  sourceArrow: { color: '#777777', fontSize: 35 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 28 },
  confirmCard: { borderRadius: 17, backgroundColor: '#FFFFFF', padding: 26, paddingTop: 38 },
  modalClose: { position: 'absolute', right: 15, top: 10, width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  modalCloseText: { color: colors.ink, fontSize: 34 },
  confirmTitle: { color: colors.ink, fontSize: 26, fontWeight: '800' },
  confirmBody: { color: colors.ink, fontSize: 17, lineHeight: 25, marginVertical: 14 },
  recordingCard: { alignItems: 'center', paddingTop: 50 },
  recordingTitle: { color: colors.ink, fontSize: 24, fontWeight: '700' },
  recordingHint: { color: colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', paddingHorizontal: 25, marginTop: 10 },
  recordWave: { height: 110, width: '100%', backgroundColor: colors.charcoal, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 12, marginTop: 35 },
  recordWaveBar: { width: 3, borderRadius: 2, backgroundColor: '#FFFFFF' },
  recordTime: { color: colors.ink, fontSize: 26, fontVariant: ['tabular-nums'], marginTop: 24 },
  recordButton: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', marginTop: 30 },
  recordDot: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.danger },
  stopSquare: { width: 28, height: 28, borderRadius: 5, backgroundColor: '#FFFFFF' },
  recordAction: { color: colors.muted, fontSize: 13, marginTop: 13 },
  sourceBadge: { backgroundColor: colors.cream, borderRadius: 12, padding: 14, marginBottom: 14 },
  sourceBadgeLabel: { color: colors.muted, fontSize: 11 },
  sourceBadgeName: { color: colors.ink, fontSize: 15, fontWeight: '700', marginTop: 4 },
  copyBox: { height: 210, borderRadius: 12, backgroundColor: '#E9E9E9', padding: 15 },
  copyInput: { flex: 1, color: colors.ink, fontSize: 18, textAlignVertical: 'top' },
  copyCount: { color: colors.muted, textAlign: 'right', fontSize: 16 },
  nameLabel: { color: colors.ink, fontSize: 21, fontWeight: '700', marginTop: 22 },
  nameInput: { minHeight: 54, color: colors.ink, fontSize: 17, borderBottomWidth: 1, borderBottomColor: '#CFCFCF' },
  processNote: { backgroundColor: colors.cream, borderRadius: 12, padding: 15, marginTop: 24 },
  processNoteTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  processNoteBody: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  synthCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 25 },
  doneIcon: { color: '#FFFFFF', backgroundColor: colors.green, width: 68, height: 68, borderRadius: 34, textAlign: 'center', lineHeight: 68, fontSize: 39, fontWeight: '800' },
  synthTitle: { color: colors.ink, fontSize: 19, textAlign: 'center', marginTop: 24 },
  synthSub: { color: colors.muted, fontSize: 13, textAlign: 'center', marginTop: 10 },
  progressTrack: { width: '80%', height: 6, borderRadius: 3, backgroundColor: '#E7E7E7', overflow: 'hidden', marginTop: 28 },
  progressValue: { height: 6, borderRadius: 3, backgroundColor: colors.lime },
  stageHint: { color: '#B0B0B0', fontSize: 10, textAlign: 'center', marginTop: 12 },
});
