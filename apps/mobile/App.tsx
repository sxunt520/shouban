import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  API_BASE_URL,
  api,
  getApiBaseUrl,
  initializeApiBaseUrl,
  normalizeApiBaseUrl,
  saveApiBaseUrl,
} from './src/api';
import { FigureFlow } from './src/screens/FigureFlow';
import { palette } from './src/theme';
import {
  Character,
  ConversationMessage,
  Device,
  DeviceCommand,
  DeviceEvent,
  Reminder,
  User,
} from './src/types';

type RootTabParamList = {
  AI手办: undefined;
  设备: undefined;
  提醒: undefined;
};

const Tabs = createBottomTabNavigator<RootTabParamList>();
const tabIcons: Record<keyof RootTabParamList, string> = {
  AI手办: '◉',
  设备: '⌁',
  提醒: '◷',
};

export default function App() {
  const [token, setToken] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState(API_BASE_URL);

  const device = devices[0] ?? null;

  const refreshWithToken = useCallback(
    async (activeToken: string) => {
      if (!activeToken) return;
      const [nextCharacters, nextDevices, nextReminders] = await Promise.all([
        api.listCharacters(activeToken),
        api.listDevices(activeToken),
        api.listReminders(activeToken),
      ]);
      setCharacters(nextCharacters);
      setDevices(nextDevices);
      setReminders(nextReminders);

      const firstDevice = nextDevices[0] ?? null;
      if (firstDevice) {
        const [nextCommands, nextEvents, nextMessages] = await Promise.all([
          api.listDeviceCommands(activeToken, firstDevice.id),
          api.listDeviceEvents(activeToken, firstDevice.id),
          api.listConversationMessages(activeToken, firstDevice.id),
        ]);
        setCommands(nextCommands);
        setEvents(nextEvents);
        setMessages(nextMessages);
      } else {
        setCommands([]);
        setEvents([]);
        setMessages([]);
      }
    },
    [],
  );

  const refresh = useCallback(
    async (activeToken = token) => refreshWithToken(activeToken),
    [refreshWithToken, token],
  );

  const connectBackend = useCallback(async (loadSavedAddress = false) => {
    setBusy(true);
    setError('');
    try {
      if (loadSavedAddress) await initializeApiBaseUrl();
      setApiBaseUrl(getApiBaseUrl());
      const session = await api.loginDemo();
      setToken(session.accessToken);
      setUser(session.user);
      await refreshWithToken(session.accessToken);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '初始化失败';
      setError(message);
      throw caught;
    } finally {
      setBusy(false);
    }
  }, [refreshWithToken]);

  const handleBackendChanged = useCallback(
    () => connectBackend(false),
    [connectBackend],
  );

  useEffect(() => {
    void connectBackend(true).catch(() => undefined);
  }, [connectBackend]);

  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, token]);

  async function perform(action: () => Promise<unknown>, message?: string) {
    try {
      setBusy(true);
      setError('');
      await action();
      await refresh();
      if (message) Alert.alert('完成', message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  if (busy && !user) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator color={palette.primary} size="large" />
        <Text style={styles.loadingText}>正在连接屿宙AI手办服务…</Text>
      </SafeAreaView>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Tabs.Navigator
        initialRouteName="设备"
        screenOptions={({ route }) => {
          const hideTabBar = route.name === 'AI手办';
          return {
            headerShown: false,
            tabBarActiveTintColor: palette.primaryDark,
            tabBarInactiveTintColor: '#928B94',
            tabBarLabelStyle: { fontSize: 11, fontWeight: '700', marginBottom: 5 },
            tabBarStyle: hideTabBar
              ? { display: 'none' }
              : {
                  height: 68,
                  paddingTop: 7,
                  backgroundColor: palette.surface,
                  borderTopColor: palette.border,
                },
            tabBarIcon: ({ color }: { color: string }) => (
              <Text style={{ color, fontSize: 21, fontWeight: '800' }}>
                {tabIcons[route.name]}
              </Text>
            ),
          };
        }}
      >
        <Tabs.Screen name="AI手办">
          {({ navigation }) => (
            <FigureFlow
              device={device}
              messages={messages}
              token={token}
              onDeviceChanged={refresh}
              onExit={() => navigation.navigate('设备')}
            />
          )}
        </Tabs.Screen>
        <Tabs.Screen name="设备">
          {({ navigation }) => (
            <DebugScreenFrame
              title="设备调试"
              userName={user?.displayName}
              busy={busy}
              error={error}
              onClearError={() => setError('')}
            >
              <HomeScreen
                token={token}
                device={device}
                characters={characters}
                commands={commands}
                events={events}
                messages={messages}
                apiBaseUrl={apiBaseUrl}
                onBackendChanged={handleBackendChanged}
                onAction={perform}
                onNeedBind={() => navigation.navigate('AI手办')}
              />
            </DebugScreenFrame>
          )}
        </Tabs.Screen>
        <Tabs.Screen name="提醒">
          {() => (
            <DebugScreenFrame
              title="提醒调试"
              userName={user?.displayName}
              busy={busy}
              error={error}
              onClearError={() => setError('')}
            >
              <ReminderScreen
                token={token}
                device={device}
                reminders={reminders}
                onAction={perform}
              />
            </DebugScreenFrame>
          )}
        </Tabs.Screen>
      </Tabs.Navigator>
    </NavigationContainer>
  );
}

function DebugScreenFrame({
  title,
  userName,
  busy,
  error,
  onClearError,
  children,
}: {
  title: string;
  userName?: string;
  busy: boolean;
  error: string;
  onClearError: () => void;
  children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>屿宙AI手办 · 开发工具</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.headerUser}>你好，{userName ?? '朋友'}</Text>
        </View>
        {busy ? <ActivityIndicator color={palette.primary} /> : null}
      </View>
      {error ? (
        <Pressable style={styles.errorBanner} onPress={onClearError}>
          <Text style={styles.errorText}>{error}</Text>
        </Pressable>
      ) : null}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {children}
        <Text style={styles.endpoint}>API：{getApiBaseUrl()}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function HomeScreen({
  token,
  device,
  characters,
  commands,
  events,
  messages,
  apiBaseUrl,
  onBackendChanged,
  onAction,
  onNeedBind,
}: {
  token: string;
  device: Device | null;
  characters: Character[];
  commands: DeviceCommand[];
  events: DeviceEvent[];
  messages: ConversationMessage[];
  apiBaseUrl: string;
  onBackendChanged: () => Promise<void>;
  onAction: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  onNeedBind: () => void;
}) {
  const [speech, setSpeech] = useState('该起床啦，今天也要元气满满！');
  const [nameDraft, setNameDraft] = useState(device?.name ?? '');
  const [backendAddress, setBackendAddress] = useState(apiBaseUrl.replace(/\/v1$/, ''));
  const [savingBackend, setSavingBackend] = useState(false);
  const [nfcCharacterId, setNfcCharacterId] = useState(
    device?.characterId ?? characters[0]?.id ?? '',
  );
  const lastSeenText = formatLastSeen(device?.lastSeenAt ?? null);
  const latestSpeechEvent = events.find(
    (event) =>
      event.type === 'speech_recognized' || event.type === 'speech_empty',
  );
  const latestTranscript =
    latestSpeechEvent && typeof latestSpeechEvent.payload.text === 'string'
      ? latestSpeechEvent.payload.text
      : '';
  const latestNfcEvent = events.find((event) => event.type === 'nfc_tag_present');
  const latestNfcUid =
    device?.nfcTag?.uid ??
    (latestNfcEvent && typeof latestNfcEvent.payload.uid === 'string'
      ? latestNfcEvent.payload.uid
      : '');
  const latestNfcTime =
    device?.nfcTag?.lastSeenAt ??
    (latestNfcEvent ? latestNfcEvent.createdAt : '');
  const nfcCharacter =
    characters.find((character) => character.id === nfcCharacterId) ?? null;

  useEffect(() => {
    setNameDraft(device?.name ?? '');
  }, [device?.id, device?.name]);

  useEffect(() => {
    setBackendAddress(apiBaseUrl.replace(/\/v1$/, ''));
  }, [apiBaseUrl]);

  const saveBackendAddress = async () => {
    if (savingBackend) return;
    try {
      setSavingBackend(true);
      const normalized = normalizeApiBaseUrl(backendAddress);
      await saveApiBaseUrl(normalized);
      setBackendAddress(normalized.replace(/\/v1$/, ''));
      try {
        await onBackendChanged();
        Alert.alert('保存成功', 'APP 已切换到新后端地址；下次配网会自动同步给底座。');
      } catch (connectionError) {
        Alert.alert(
          '地址已保存，但暂时无法连接',
          connectionError instanceof Error ? connectionError.message : '请确认后端已启动',
        );
      }
    } catch (saveError) {
      Alert.alert('保存失败', saveError instanceof Error ? saveError.message : '地址格式不正确');
    } finally {
      setSavingBackend(false);
    }
  };

  useEffect(() => {
    if (!nfcCharacterId && characters[0]) {
      setNfcCharacterId(device?.characterId ?? characters[0].id);
    }
  }, [characters, device?.characterId, nfcCharacterId]);

  const connectionSettings = (
    <>
      <SectionTitle title="连接设置" subtitle="换网络时修改，配网会同步到智能底座" />
      <View style={styles.panel}>
        <FieldLabel label="后端服务地址" />
        <TextInput
          style={styles.input}
          value={backendAddress}
          onChangeText={setBackendAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://电脑IP:3000"
        />
        <Text style={styles.meta}>例如：http://192.168.31.157:3000</Text>
        <PrimaryButton
          label={savingBackend ? '正在保存并检测…' : '保存并检测连接'}
          disabled={savingBackend}
          onPress={() => void saveBackendAddress()}
        />
      </View>
    </>
  );

  if (!device) {
    return (
      <>
        {connectionSettings}
        <EmptyCard
          title="还没有绑定底座"
          body="硬件到达前可以使用模拟设备。测试绑定码是 FIGURE-0001。"
          action="开始绑定"
          onPress={onNeedBind}
        />
      </>
    );
  }

  return (
    <>
      {connectionSettings}

      <View style={styles.heroCard}>
        <View style={styles.rowBetween}>
          <View style={styles.deviceIcon}><Text style={styles.deviceIconText}>◉</Text></View>
          <View
            style={[
              styles.statusPill,
              device.status === 'online' ? styles.onlinePill : styles.offlinePill,
            ]}
          >
            <Text style={styles.statusText}>
              {device.status === 'online' ? '在线' : '离线'}
            </Text>
          </View>
        </View>
        <Text style={styles.cardTitle}>{device.name}</Text>
        <Text style={styles.cardBody}>
          {device.character
            ? `当前角色：${device.character.name} · 音量 ${device.volume}%`
            : '尚未选择角色'}
        </Text>
        <View style={styles.deviceFacts}>
          <Text style={styles.deviceFact}>硬件：{device.hardwareId}</Text>
          <Text style={styles.deviceFact}>固件：{device.firmwareVersion}</Text>
          <Text style={styles.deviceFact}>最近心跳：{lastSeenText}</Text>
        </View>
      </View>

      <SectionTitle title="设备设置" subtitle="先把 APP 控制链路跑顺" />
      <View style={styles.panel}>
        <FieldLabel label="设备名称" />
        <View style={styles.inlineForm}>
          <TextInput
            style={[styles.input, styles.inlineInput]}
            value={nameDraft}
            onChangeText={setNameDraft}
            placeholder="给底座起个名字"
          />
          <Pressable
            style={styles.compactButton}
            onPress={() =>
              void onAction(
                () => api.updateDeviceName(token, device.id, nameDraft.trim()),
                '设备名称已更新',
              )
            }
          >
            <Text style={styles.compactButtonText}>保存</Text>
          </Pressable>
        </View>
      </View>

      <SectionTitle title="切换角色" subtitle="选择后会生成一条同步指令发送给底座" />
      <View style={styles.stack}>
        {characters.map((character) => (
          <CharacterCard
            key={character.id}
            character={character}
            selected={device.characterId === character.id}
            onPress={() =>
              void onAction(() =>
                api.updateCharacter(token, device.id, character.id),
              )
            }
          />
        ))}
      </View>

      <SectionTitle
        title="NFC 手办身份"
        subtitle="刷卡后选择角色，UID 会保存到 MySQL"
      />
      <View style={styles.panel}>
        <View style={styles.nfcScanBox}>
          <Text style={styles.transcriptLabel}>底座最近读到的 UID</Text>
          <Text style={styles.nfcUidText}>
            {latestNfcUid || '等待刷卡…'}
          </Text>
          {device.nfcTag ? (
            <Text style={styles.meta}>
              {device.nfcTag.matched
                ? `已匹配角色：${device.nfcTag.characterName ?? '未知角色'}`
                : '这张卡还没有绑定角色'}
            </Text>
          ) : null}
          {latestNfcTime ? (
            <Text style={styles.meta}>
              {formatBeijingDateTime(latestNfcTime)}
            </Text>
          ) : null}
        </View>
        <Text style={styles.fieldLabel}>这张卡代表哪个角色？</Text>
        <View style={styles.chipRow}>
          {characters.map((character) => (
            <Chip
              key={character.id}
              label={character.name}
              selected={nfcCharacterId === character.id}
              onPress={() => setNfcCharacterId(character.id)}
            />
          ))}
        </View>
        <PrimaryButton
          label={nfcCharacter ? `绑定到「${nfcCharacter.name}」` : '选择角色'}
          disabled={!latestNfcUid || !nfcCharacter}
          onPress={() => {
            if (!nfcCharacter || !latestNfcUid) return;
            void onAction(
              () =>
                api.bindCharacterNfcTag(
                  token,
                  nfcCharacter.id,
                  latestNfcUid,
                ),
              `UID ${latestNfcUid} 已绑定到角色“${nfcCharacter.name}”`,
            );
          }}
        />
        <View style={styles.nfcBindings}>
          {characters.map((character) => (
            <View key={character.id} style={styles.nfcBindingRow}>
              <View style={styles.reminderContent}>
                <Text style={styles.reminderTitle}>{character.name}</Text>
                <Text style={styles.meta}>
                  {character.nfcTagUid ?? '尚未绑定标签'}
                </Text>
              </View>
              {character.nfcTagUid ? (
                <Pressable
                  style={styles.deleteButton}
                  onPress={() =>
                    Alert.alert(
                      '解除 NFC 标签',
                      `确定解除“${character.name}”与 ${character.nfcTagUid} 的绑定吗？`,
                      [
                        { text: '取消', style: 'cancel' },
                        {
                          text: '解除',
                          style: 'destructive',
                          onPress: () =>
                            void onAction(
                              () =>
                                api.unbindCharacterNfcTag(token, character.id),
                              'NFC 标签绑定已解除',
                            ),
                        },
                      ],
                    )
                  }
                >
                  <Text style={styles.deleteText}>解除</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      </View>

      <SectionTitle title="让角色说一句" subtitle="用于验证 APP → 后端 → 设备联动" />
      <View style={styles.panel}>
        <TextInput
          style={styles.input}
          value={speech}
          onChangeText={setSpeech}
          multiline
          placeholder="输入想让角色说的话"
        />
        <PrimaryButton
          label="发送到手办底座"
          disabled={!speech.trim()}
          onPress={() =>
            void onAction(
              () => api.speakText(token, device.id, speech.trim()),
              '播报指令已经进入设备队列',
            )
          }
        />
      </View>

      <SectionTitle title="音量" />
      <View style={[styles.panel, styles.volumeRow]}>
        <SecondaryButton
          label="－"
          onPress={() =>
            void onAction(() =>
              api.updateVolume(token, device.id, Math.max(0, device.volume - 10)),
            )
          }
        />
        <Text style={styles.volumeText}>{device.volume}%</Text>
        <SecondaryButton
          label="＋"
          onPress={() =>
            void onAction(() =>
              api.updateVolume(token, device.id, Math.min(100, device.volume + 10)),
            )
          }
        />
      </View>


      <SectionTitle
        title="最近对话"
        subtitle="当前角色最近 30 条记忆"
      />
      <View style={styles.chatPanel}>
        {messages.length === 0 ? (
          <Text style={styles.emptyText}>还没有对话，点击“开始说话”说一句吧。</Text>
        ) : (
          messages.slice(-10).map((message) => (
            <View
              key={message.id}
              style={[
                styles.chatBubble,
                message.role === 'user'
                  ? styles.userBubble
                  : styles.assistantBubble,
              ]}
            >
              <Text style={styles.chatRole}>
                {message.role === 'user'
                  ? '我'
                  : device.character?.name ?? '角色'}
              </Text>
              <Text style={styles.chatText}>{message.content}</Text>
              <Text style={styles.chatTime}>
                {formatBeijingTime(message.createdAt)}
              </Text>
            </View>
          ))
        )}
      </View>

      <SectionTitle
        title="和手办说话"
        subtitle="半双工：静音自动结束，最长 10 秒"
      />
      <View style={styles.panel}>
        <Text style={styles.formHelp}>
          点击后等待底座屏幕显示 LISTENING，再对着麦克风说话；说完安静约 1 秒会自动结束。
        </Text>
        <PrimaryButton
          label="开始说话"
          onPress={() =>
            void onAction(
              () => api.startListening(token, device.id),
              '指令已发送；看到底座显示 LISTENING 后开始说话',
            )
          }
        />
        <View style={styles.transcriptBox}>
          <Text style={styles.transcriptLabel}>最近识别结果</Text>
          <Text style={styles.transcriptText}>
            {latestSpeechEvent
              ? latestTranscript || '没有识别到有效语音，请靠近麦克风后重试。'
              : '还没有录音记录'}
          </Text>
          {latestSpeechEvent ? (
            <Text style={styles.meta}>
              {formatBeijingDateTime(latestSpeechEvent.createdAt)}
            </Text>
          ) : null}
        </View>
      </View>

      <SectionTitle
        title="设备指令队列"
        subtitle="最近 20 条，已完成代表 ESP32 已 ACK"
      />
      <View style={styles.stack}>
        {commands.length === 0 ? (
          <Text style={styles.emptyText}>暂无指令</Text>
        ) : (
          commands.slice(0, 6).map((command) => (
            <TimelineCard
              key={command.id}
              title={formatCommandType(command.type)}
              subtitle={`${formatCommandPayload(command.payload)} · ${formatBeijingTime(
                command.createdAt,
              )}`}
              status={command.acknowledgedAt ? '已完成' : '等待设备'}
              tone={command.acknowledgedAt ? 'success' : 'pending'}
            />
          ))
        )}
      </View>

      <SectionTitle title="最近设备事件" subtitle="ESP32 主动上报的日志" />
      <View style={styles.stack}>
        {events.length === 0 ? (
          <Text style={styles.emptyText}>暂无事件</Text>
        ) : (
          events.slice(0, 6).map((event) => (
            <TimelineCard
              key={event.id}
              title={event.type}
              subtitle={`${formatEventPayload(event.payload)} · ${formatBeijingTime(
                event.createdAt,
              )}`}
              status="已接收"
              tone="muted"
            />
          ))
        )}
      </View>
    </>
  );
}

function BindScreen({
  token,
  device,
  characters,
  onAction,
  onBound,
}: {
  token: string;
  device: Device | null;
  characters: Character[];
  onAction: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  onBound: () => void;
}) {
  const [pairingCode, setPairingCode] = useState('FIGURE-0001');
  const [name, setName] = useState('我的手办底座');
  const [characterId, setCharacterId] = useState(characters[0]?.id ?? '');

  useEffect(() => {
    if (!characterId && characters[0]) setCharacterId(characters[0].id);
  }, [characters, characterId]);

  if (device) {
    return (
      <EmptyCard
        title="设备已经绑定"
        body={`${device.name} 已属于当前账号。可在“AI手办 → 智能底座 → 设备管理”中解绑。`}
        action="查看设备"
        onPress={onBound}
      />
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.formTitle}>绑定手办底座</Text>
      <Text style={styles.formHelp}>
        正式硬件会在屏幕上显示短码。现在可以用预置模拟码完成测试。
      </Text>
      <FieldLabel label="绑定码" />
      <TextInput
        autoCapitalize="characters"
        style={styles.input}
        value={pairingCode}
        onChangeText={setPairingCode}
      />
      <FieldLabel label="设备名称" />
      <TextInput style={styles.input} value={name} onChangeText={setName} />
      <FieldLabel label="初始角色" />
      <View style={styles.stack}>
        {characters.map((character) => (
          <CharacterCard
            key={character.id}
            character={character}
            selected={characterId === character.id}
            onPress={() => setCharacterId(character.id)}
          />
        ))}
      </View>
      <PrimaryButton
        label="确认绑定"
        disabled={!pairingCode.trim() || !characterId}
        onPress={() =>
          void onAction(async () => {
            await api.bindDevice(token, {
              pairingCode: pairingCode.trim(),
              characterId,
              name: name.trim(),
            });
            onBound();
          }, '账号、设备和角色已经关联')
        }
      />
    </View>
  );
}

function ReminderScreen({
  token,
  device,
  reminders,
  onAction,
}: {
  token: string;
  device: Device | null;
  reminders: Reminder[];
  onAction: (action: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('喝水休息一下');
  const [delayMinutes, setDelayMinutes] = useState(1);
  const [repeat, setRepeat] = useState<'none' | 'daily'>('none');
  const [kind, setKind] = useState<'reminder' | 'alarm'>('reminder');
  const ordered = useMemo(
    () => [...reminders].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
    [reminders],
  );

  if (!device) {
    return (
      <EmptyCard
        title="请先绑定设备"
        body="提醒必须关联到一台手办底座。"
        action="暂无设备"
      />
    );
  }

  return (
    <>
      <View style={styles.panel}>
        <Text style={styles.formTitle}>创建语音提醒</Text>
        <FieldLabel label="类型" />
        <View style={styles.chipRow}>
          <Chip
            label="主动提醒"
            selected={kind === 'reminder'}
            onPress={() => setKind('reminder')}
          />
          <Chip
            label="闹钟"
            selected={kind === 'alarm'}
            onPress={() => setKind('alarm')}
          />
        </View>
        <FieldLabel label="提醒内容" />
        <TextInput style={styles.input} value={title} onChangeText={setTitle} />
        <FieldLabel label="测试触发时间" />
        <View style={styles.chipRow}>
          {[1, 5, 10].map((minutes) => (
            <Chip
              key={minutes}
              label={`${minutes} 分钟后`}
              selected={delayMinutes === minutes}
              onPress={() => setDelayMinutes(minutes)}
            />
          ))}
        </View>
        <FieldLabel label="重复" />
        <View style={styles.chipRow}>
          <Chip label="仅一次" selected={repeat === 'none'} onPress={() => setRepeat('none')} />
          <Chip label="每天" selected={repeat === 'daily'} onPress={() => setRepeat('daily')} />
        </View>
        <PrimaryButton
          label="保存提醒"
          disabled={!title.trim()}
          onPress={() =>
            void onAction(
              () =>
                api.createReminder(token, {
                  deviceId: device.id,
                  title: title.trim(),
                  scheduledAt: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
                  repeat,
                  kind,
                }),
              '提醒已经创建',
            )
          }
        />
      </View>

      <SectionTitle title="提醒列表" subtitle={`${ordered.length} 条`} />
      <View style={styles.stack}>
        {ordered.length === 0 ? (
          <Text style={styles.emptyText}>还没有提醒</Text>
        ) : (
          ordered.map((reminder) => (
            <View key={reminder.id} style={styles.reminderCard}>
              <View style={styles.reminderContent}>
                <Text style={styles.reminderTitle}>
                  {reminder.kind === 'alarm' ? '闹钟' : '提醒'} · {reminder.title}
                </Text>
                <Text style={styles.meta}>
                  {formatBeijingDateTime(reminder.scheduledAt)} ·{' '}
                  {reminder.repeat === 'daily' ? '每天' : '单次'}
                </Text>
              </View>
              <Pressable
                style={[styles.smallButton, !reminder.enabled && styles.smallButtonMuted]}
                onPress={() =>
                  void onAction(() =>
                    api.toggleReminder(token, reminder.id, !reminder.enabled),
                  )
                }
              >
                <Text style={styles.smallButtonText}>{reminder.enabled ? '暂停' : '启用'}</Text>
              </Pressable>
              <Pressable
                style={styles.deleteButton}
                onPress={() =>
                  Alert.alert('删除提醒', `确定删除“${reminder.title}”吗？`, [
                    { text: '取消', style: 'cancel' },
                    {
                      text: '删除',
                      style: 'destructive',
                      onPress: () =>
                        void onAction(() => api.deleteReminder(token, reminder.id)),
                    },
                  ])
                }
              >
                <Text style={styles.deleteText}>删除</Text>
              </Pressable>
            </View>
          ))
        )}
      </View>
    </>
  );
}

function CharacterCard({
  character,
  selected,
  onPress,
}: {
  character: Character;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.characterCard, selected && styles.characterCardSelected]}
    >
      <View style={[styles.avatar, { backgroundColor: character.accentColor }]}>
        <Text style={styles.avatarText}>{character.name.slice(0, 1)}</Text>
      </View>
      <View style={styles.characterContent}>
        <View style={styles.rowBetween}>
          <Text style={styles.characterName}>{character.name}</Text>
          {selected ? <Text style={styles.selectedMark}>已选择</Text> : null}
        </View>
        <Text style={styles.characterDescription}>{character.description}</Text>
      </View>
    </Pressable>
  );
}

function EmptyCard({
  title,
  body,
  action,
  onPress,
}: {
  title: string;
  body: string;
  action: string;
  onPress?: () => void;
}) {
  return (
    <View style={styles.emptyCard}>
      <Text style={styles.emptySymbol}>⌁</Text>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={[styles.cardBody, styles.emptyBody]}>{body}</Text>
      {onPress ? <PrimaryButton label={action} onPress={onPress} /> : null}
    </View>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function FieldLabel({ label }: { label: string }) {
  return <Text style={styles.fieldLabel}>{label}</Text>;
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[styles.primaryButton, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.secondaryButton}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function TabButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tabButton}>
      <View style={[styles.tabDot, active && styles.tabDotActive]} />
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function TimelineCard({
  title,
  subtitle,
  status,
  tone,
}: {
  title: string;
  subtitle: string;
  status: string;
  tone: 'success' | 'pending' | 'muted';
}) {
  return (
    <View style={styles.timelineCard}>
      <View style={styles.reminderContent}>
        <Text style={styles.reminderTitle}>{title}</Text>
        <Text style={styles.meta}>{subtitle}</Text>
      </View>
      <View
        style={[
          styles.stateBadge,
          tone === 'success' && styles.stateBadgeSuccess,
          tone === 'pending' && styles.stateBadgePending,
        ]}
      >
        <Text
          style={[
            styles.stateBadgeText,
            tone === 'success' && styles.stateBadgeTextSuccess,
            tone === 'pending' && styles.stateBadgeTextPending,
          ]}
        >
          {status}
        </Text>
      </View>
    </View>
  );
}

function formatLastSeen(value: string | null) {
  if (!value) return '暂无';
  const seenAt = new Date(value).getTime();
  if (Number.isNaN(seenAt)) return '时间未知';
  const seconds = Math.max(0, Math.round((Date.now() - seenAt) / 1000));
  if (seconds < 3) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return formatBeijingDateTime(value);
}

function formatBeijingDateTime(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatBeijingTime(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatCommandType(type: DeviceCommand['type']) {
  const labels: Record<DeviceCommand['type'], string> = {
    sync_character: '同步角色',
    sync_alarms: '同步离线闹钟',
    control_alarm: '控制闹钟',
    play_reminder: '播放提醒',
    speak_text: '测试播报',
    start_listening: '录音并识别',
    set_volume: '设置音量',
  };
  return labels[type] ?? type;
}

function formatCommandPayload(payload: Record<string, unknown>) {
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.title === 'string') return payload.title;
  if (typeof payload.volume === 'number') return `音量 ${payload.volume}%`;
  if (typeof payload.durationMs === 'number') {
    return `录音 ${Math.round(payload.durationMs / 1000)} 秒`;
  }
  if (
    payload.character &&
    typeof payload.character === 'object' &&
    'name' in payload.character &&
    typeof payload.character.name === 'string'
  ) {
    return `角色 ${payload.character.name}`;
  }
  return '无附加内容';
}

function formatEventPayload(payload: Record<string, unknown>) {
  const keys = Object.keys(payload);
  if (keys.length === 0) return '无附加内容';
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.text === 'string') return payload.text || '未识别到有效语音';
  if (typeof payload.reason === 'string') return payload.reason;
  if (typeof payload.uid === 'string') {
    if (typeof payload.characterName === 'string') {
      return `${payload.uid} → ${payload.characterName}${
        payload.switched ? '（已切换）' : ''
      }`;
    }
    return `${payload.uid}（未绑定角色）`;
  }
  return keys.slice(0, 3).join(' / ');
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.canvas },
  loadingText: { color: palette.muted, marginTop: 14 },
  header: { paddingHorizontal: 22, paddingTop: 16, paddingBottom: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { color: palette.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 4 },
  headerUser: { color: palette.muted, fontSize: 12, marginTop: 4 },
  errorBanner: { marginHorizontal: 18, marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: '#FDECEC' },
  errorText: { color: palette.red, fontSize: 13 },
  content: { paddingHorizontal: 18, paddingBottom: 26 },
  heroCard: { backgroundColor: palette.ink, borderRadius: 24, padding: 20, marginTop: 6 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  deviceIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: '#3A304B', alignItems: 'center', justifyContent: 'center' },
  deviceIconText: { color: '#C9B9FF', fontSize: 25 },
  statusPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  onlinePill: { backgroundColor: palette.green },
  offlinePill: { backgroundColor: '#625A6D' },
  statusText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  cardTitle: { color: palette.ink, fontSize: 21, fontWeight: '800', marginTop: 18 },
  cardBody: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 7 },
  meta: { color: palette.muted, fontSize: 12, marginTop: 6 },
  deviceFacts: { borderTopWidth: 1, borderTopColor: '#3A304B', gap: 5, marginTop: 14, paddingTop: 12 },
  deviceFact: { color: '#CFC7DA', fontSize: 12, lineHeight: 17 },
  sectionHeader: { marginTop: 26, marginBottom: 11, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  sectionTitle: { color: palette.ink, fontSize: 18, fontWeight: '800' },
  sectionSubtitle: { color: palette.muted, fontSize: 12, flexShrink: 1, marginLeft: 10, textAlign: 'right' },
  stack: { gap: 10 },
  characterCard: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'center' },
  characterCardSelected: { borderColor: palette.primary, backgroundColor: palette.primarySoft },
  avatar: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  characterContent: { marginLeft: 12, flex: 1 },
  characterName: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  characterDescription: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  selectedMark: { color: palette.primary, fontSize: 11, fontWeight: '700' },
  panel: { backgroundColor: palette.surface, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: palette.border, gap: 12 },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inlineInput: { flex: 1 },
  compactButton: { minHeight: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.ink, paddingHorizontal: 16 },
  compactButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  input: { backgroundColor: '#FAF9FD', borderWidth: 1, borderColor: palette.border, borderRadius: 13, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, color: palette.ink, fontSize: 15 },
  primaryButton: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.primary, paddingHorizontal: 16, marginTop: 4 },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  buttonDisabled: { opacity: 0.42 },
  secondaryButton: { width: 48, height: 44, borderRadius: 13, backgroundColor: palette.primarySoft, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { color: palette.primary, fontSize: 23, fontWeight: '700' },
  volumeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  volumeText: { color: palette.ink, fontSize: 22, fontWeight: '800' },
  formTitle: { color: palette.ink, fontSize: 22, fontWeight: '800' },
  formHelp: { color: palette.muted, fontSize: 13, lineHeight: 20, marginBottom: 4 },
  transcriptBox: { backgroundColor: palette.primarySoft, borderRadius: 14, padding: 14 },
  transcriptLabel: { color: palette.primary, fontSize: 11, fontWeight: '800' },
  transcriptText: { color: palette.ink, fontSize: 16, fontWeight: '700', lineHeight: 24, marginTop: 6 },
  nfcScanBox: { backgroundColor: palette.primarySoft, borderRadius: 14, padding: 14 },
  nfcUidText: { color: palette.ink, fontSize: 20, fontWeight: '800', letterSpacing: 1.2, marginTop: 6 },
  nfcBindings: { borderTopWidth: 1, borderTopColor: palette.border, marginTop: 2 },
  nfcBindingRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: palette.border, paddingVertical: 9 },
  chatPanel: { backgroundColor: palette.surface, borderRadius: 20, padding: 14, borderWidth: 1, borderColor: palette.border, gap: 10 },
  chatBubble: { maxWidth: '88%', borderRadius: 15, paddingHorizontal: 13, paddingVertical: 10 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: palette.primarySoft },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: '#F2EFF6' },
  chatRole: { color: palette.primary, fontSize: 11, fontWeight: '800', marginBottom: 4 },
  chatText: { color: palette.ink, fontSize: 14, lineHeight: 21 },
  chatTime: { color: palette.muted, fontSize: 10, marginTop: 4 },
  fieldLabel: { color: palette.ink, fontSize: 13, fontWeight: '700', marginTop: 5 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 999, backgroundColor: '#F2EFF6' },
  chipSelected: { backgroundColor: palette.primary },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  chipTextSelected: { color: '#FFFFFF' },
  reminderCard: { backgroundColor: palette.surface, borderRadius: 16, borderWidth: 1, borderColor: palette.border, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  timelineCard: { backgroundColor: palette.surface, borderRadius: 16, borderWidth: 1, borderColor: palette.border, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  reminderContent: { flex: 1 },
  reminderTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  stateBadge: { backgroundColor: '#F0EEF2', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 6 },
  stateBadgeSuccess: { backgroundColor: '#E7F8EF' },
  stateBadgePending: { backgroundColor: '#FFF3D8' },
  stateBadgeText: { color: palette.muted, fontSize: 11, fontWeight: '800' },
  stateBadgeTextSuccess: { color: palette.green },
  stateBadgeTextPending: { color: '#B26A00' },
  smallButton: { backgroundColor: palette.primarySoft, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 },
  smallButtonMuted: { backgroundColor: '#F0EEF2' },
  smallButtonText: { color: palette.primary, fontSize: 11, fontWeight: '700' },
  deleteButton: { paddingHorizontal: 4, paddingVertical: 8 },
  deleteText: { color: palette.red, fontSize: 11, fontWeight: '700' },
  emptyCard: { marginTop: 16, backgroundColor: palette.surface, borderRadius: 24, borderWidth: 1, borderColor: palette.border, padding: 24, alignItems: 'center' },
  emptySymbol: { color: palette.primary, fontSize: 46 },
  emptyBody: { textAlign: 'center', marginBottom: 14 },
  emptyText: { color: palette.muted, textAlign: 'center', paddingVertical: 24 },
  endpoint: { color: '#A19AAA', textAlign: 'center', fontSize: 10, marginTop: 28 },
  tabBar: { height: 68, backgroundColor: palette.surface, borderTopWidth: 1, borderTopColor: palette.border, flexDirection: 'row', justifyContent: 'space-around', paddingTop: 8 },
  tabButton: { width: 88, alignItems: 'center', gap: 5 },
  tabDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#D8D3DD' },
  tabDotActive: { backgroundColor: palette.primary },
  tabLabel: { color: palette.muted, fontSize: 12, fontWeight: '600' },
  tabLabelActive: { color: palette.primary, fontWeight: '800' },
});
