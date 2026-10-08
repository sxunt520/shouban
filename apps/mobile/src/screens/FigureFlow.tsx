import {
  NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useIsFocused } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Clipboard,
  ImageBackground,
  ImageSourcePropType,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ConversationMessage, Device } from '../types';
import {
  api,
  getApiBaseUrl,
  isConversationStreamCancelled,
  normalizeApiBaseUrl,
  saveApiBaseUrl,
  subscribeDeviceVoiceRecognition,
} from '../api';
import { palette } from '../theme';
import { AlarmFlow } from './AlarmFlow';
import {
  DEVELOPMENT_DESCRIPTOR,
  ProvisioningEnvironment,
  ProvisioningDescriptor,
  ProvisioningDevice,
  ProvisioningWifi,
  parseProvisioningQr,
  provisioning,
  requestProvisioningPermissions,
} from '../provisioning';

type SetupMode = 'add' | 'wifi';

type FigureStackParamList = {
  FigureHome: undefined;
  DeviceHome: undefined;
  AlarmCenter: undefined;
  ConversationHistory: undefined;
  MoodDiary: undefined;
  BasePreparation: undefined;
  EnvironmentCheck: undefined;
  AddIntro: undefined;
  ScanQr: undefined;
  PrepareDevice: { mode: SetupMode; descriptor?: ProvisioningDescriptor };
  Scanning: { mode: SetupMode; descriptor: ProvisioningDescriptor };
  SelectDevice: { mode: SetupMode; descriptor: ProvisioningDescriptor; devices: ProvisioningDevice[] };
  SelectWifi: { mode: SetupMode; descriptor: ProvisioningDescriptor; device: ProvisioningDevice };
  Provisioning: { mode: SetupMode; descriptor: ProvisioningDescriptor; ssid: string; password: string };
  SetupSuccess: { mode: SetupMode };
  Dashboard: undefined;
  DeviceDetail: undefined;
  DeviceManagement: undefined;
};

const Stack = createNativeStackNavigator<FigureStackParamList>();
const sukiMorningImage = require('../../assets/alarm/suki-morning.png');
const niannianHomeImage = require('../../assets/figure/niannian-home.png');
const suRuanruanHomeImage = require('../../assets/figure/su-ruanruan-home.png');

export function FigureFlow({
  device,
  messages,
  token,
  onDeviceChanged,
  onExit,
}: {
  device: Device | null;
  messages: ConversationMessage[];
  token: string;
  onDeviceChanged: () => Promise<void>;
  onExit: () => void;
}) {
  return (
    <FigureStack
      initialRouteName="FigureHome"
      device={device}
      messages={messages}
      token={token}
      onDeviceChanged={onDeviceChanged}
      onExit={onExit}
    />
  );
}

export function DeviceFlow({
  device,
  token,
  apiBaseUrl,
  onBackendChanged,
  onDeviceChanged,
}: {
  device: Device | null;
  token: string;
  apiBaseUrl: string;
  onBackendChanged: () => Promise<void>;
  onDeviceChanged: () => Promise<void>;
}) {
  return (
    <FigureStack
      initialRouteName="DeviceHome"
      device={device}
      messages={[]}
      token={token}
      apiBaseUrl={apiBaseUrl}
      onBackendChanged={onBackendChanged}
      onDeviceChanged={onDeviceChanged}
      onExit={() => undefined}
    />
  );
}

function FigureStack({
  initialRouteName,
  device,
  messages,
  token,
  apiBaseUrl = getApiBaseUrl(),
  onBackendChanged,
  onDeviceChanged,
  onExit,
}: {
  initialRouteName: 'FigureHome' | 'DeviceHome';
  device: Device | null;
  messages: ConversationMessage[];
  token: string;
  apiBaseUrl?: string;
  onBackendChanged?: () => Promise<void>;
  onDeviceChanged: () => Promise<void>;
  onExit: () => void;
}) {
  const claimDevice = useCallback(
    async (pairingCode?: string) => {
      if (!pairingCode) throw new Error('二维码缺少设备认领码，请重新扫描底座二维码');
      await api.bindDevice(token, { pairingCode });
      await onDeviceChanged();
    },
    [onDeviceChanged, token],
  );

  return (
    <Stack.Navigator
      initialRouteName={initialRouteName}
      screenOptions={{
        headerShadowVisible: false,
        headerTintColor: palette.ink,
        headerStyle: { backgroundColor: palette.canvas },
        headerTitleStyle: { fontSize: 17, fontWeight: '700' },
        contentStyle: { backgroundColor: palette.canvas },
      }}
    >
      <Stack.Screen name="FigureHome" options={{ headerShown: false }}>
        {(props) => <FigureHomeScreen {...props} device={device} onExit={onExit} />}
      </Stack.Screen>
      <Stack.Screen name="DeviceHome" options={{ title: '我的设备' }}>
        {(props) => (
          <DeviceHomeScreen
            {...props}
            device={device}
            apiBaseUrl={apiBaseUrl}
            onBackendChanged={onBackendChanged}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="AlarmCenter" options={{ headerShown: false }}>
        {() => <AlarmFlow token={token} device={device} />}
      </Stack.Screen>
      <Stack.Screen name="ConversationHistory" options={{ headerShown: false }}>
        {(props) => (
          <ConversationHistoryScreen
            {...props}
            device={device}
            messages={messages}
            token={token}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="MoodDiary" options={{ title: '心情日记' }}>
        {(props) => <MoodDiaryScreen {...props} />}
      </Stack.Screen>
      <Stack.Screen name="BasePreparation" component={BasePreparationScreen} options={{ title: '准备智能底座' }} />
      <Stack.Screen name="EnvironmentCheck" component={EnvironmentCheckScreen} options={{ title: '检查手机环境' }} />
      <Stack.Screen name="AddIntro" component={AddIntroScreen} options={{ title: '添加智能底座' }} />
      <Stack.Screen name="ScanQr" component={ScanQrScreen} options={{ title: '扫描底座二维码' }} />
      <Stack.Screen name="PrepareDevice" component={PrepareDeviceScreen} options={{ title: '准备智能底座' }} />
      <Stack.Screen name="Scanning" component={ScanningScreen} options={{ title: '搜索附近设备' }} />
      <Stack.Screen name="SelectDevice" component={SelectDeviceScreen} options={{ title: '选择设备' }} />
      <Stack.Screen name="SelectWifi" component={SelectWifiScreen} options={{ title: '配置网络' }} />
      <Stack.Screen name="Provisioning" options={{ title: '正在配置' }}>
        {(props) => <ProvisioningScreen {...props} onClaimDevice={claimDevice} />}
      </Stack.Screen>
      <Stack.Screen name="SetupSuccess" component={SetupSuccessScreen} options={{ title: '' }} />
      <Stack.Screen name="Dashboard" options={{ title: '智能底座' }}>
        {(props) => <DashboardScreen {...props} device={device} />}
      </Stack.Screen>
      <Stack.Screen name="DeviceDetail" options={{ title: '设备详情' }}>
        {(props) => <DeviceDetailScreen {...props} device={device} />}
      </Stack.Screen>
      <Stack.Screen name="DeviceManagement" options={{ title: '设备管理' }}>
        {(props) => <DeviceManagementScreen {...props} device={device} token={token} onDeviceChanged={onDeviceChanged} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

function FigureHomeScreen({
  navigation,
  device,
  onExit,
}: NativeStackScreenProps<FigureStackParamList, 'FigureHome'> & {
  device: Device | null;
  onExit: () => void;
}) {
  const isFocused = useIsFocused();
  const characterName = device?.nfcTag?.matched && device.nfcTag.characterName
    ? device.nfcTag.characterName
    : device?.character?.name ?? 'Suki';
  const characterTheme = getCharacterHomeTheme(
    characterName,
    device?.character?.accentColor,
    device?.character?.backgroundImageUrl,
  );
  return (
    <ImageBackground
      key={characterName}
      source={characterTheme.image}
      style={styles.figureHome}
      resizeMode="cover"
    >
      <StatusBar style={isFocused ? 'light' : 'dark'} />
      <View style={[styles.figureHomeVeil, { backgroundColor: characterTheme.overlay }]} />
      <SafeAreaView style={styles.figureHomeSafe}>
        <View style={styles.figureHomeTop}>
          <Pressable style={styles.roundBackButton} onPress={onExit}>
            <Text style={styles.roundBackText}>‹</Text>
          </Pressable>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.72}
            numberOfLines={1}
            style={styles.figureSignature}
          >
            {characterName} ♥ {characterTheme.slogan}
          </Text>
        </View>

        <View style={styles.homeSideActions}>
          <HomeIconButton icon="▰" label="历史对话" onPress={() => navigation.navigate('ConversationHistory')} />
          <HomeIconButton icon="▣" label="我的设备" onPress={() => navigation.navigate(device ? 'Dashboard' : 'BasePreparation')} />
        </View>

        <View style={styles.homeBottomActions}>
          <HomeEntryButton icon="▣" label="心情日记" onPress={() => navigation.navigate('MoodDiary')} />
          <HomeEntryButton icon="◷" label="AI闹钟" onPress={() => navigation.navigate('AlarmCenter')} />
        </View>
      </SafeAreaView>
    </ImageBackground>
  );
}

function DeviceHomeScreen({
  navigation,
  device,
  apiBaseUrl,
  onBackendChanged,
}: NativeStackScreenProps<FigureStackParamList, 'DeviceHome'> & {
  device: Device | null;
  apiBaseUrl: string;
  onBackendChanged?: () => Promise<void>;
}) {
  const [backendAddress, setBackendAddress] = useState(apiBaseUrl.replace(/\/v1$/, ''));
  const [savingBackend, setSavingBackend] = useState(false);
  const figureLabel = device?.nfcTag
    ? device.nfcTag.matched
      ? `当前角色：${device.nfcTag.characterName}`
      : `未绑定标签：${device.nfcTag.uid}`
    : device?.character?.name
      ? `当前角色：${device.character.name}`
      : '尚未放置角色';

  useEffect(() => {
    setBackendAddress(apiBaseUrl.replace(/\/v1$/, ''));
  }, [apiBaseUrl]);

  const saveBackend = async () => {
    if (savingBackend) return;
    try {
      setSavingBackend(true);
      const normalized = normalizeApiBaseUrl(backendAddress);
      await saveApiBaseUrl(normalized);
      setBackendAddress(normalized.replace(/\/v1$/, ''));
      await onBackendChanged?.();
      Alert.alert('保存成功', 'APP 已切换到新后端地址，下次配网也会同步给底座。');
    } catch (saveError) {
      Alert.alert(
        '地址已保存或连接失败',
        saveError instanceof Error ? saveError.message : '请确认后端服务已启动',
      );
    } finally {
      setSavingBackend(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {device ? (
        <Pressable style={styles.deviceCard} onPress={() => navigation.navigate('Dashboard')}>
          <View style={[styles.figureAvatar, { backgroundColor: device.character?.accentColor ?? palette.primary }]}>
            <Text style={styles.figureAvatarText}>{device.character?.name?.slice(0, 1) ?? '屿'}</Text>
          </View>
          <View style={styles.flex}>
            <View style={styles.rowBetween}>
              <Text style={styles.deviceName}>{device.name}</Text>
              <Text style={[styles.status, device.status === 'online' ? styles.online : styles.offline]}>
                {device.status === 'online' ? '在线' : '离线'}
              </Text>
            </View>
            <Text style={styles.muted}>{figureLabel} · 音量 {device.volume}%</Text>
            <Text style={styles.linkText}>进入设备管理  →</Text>
          </View>
        </Pressable>
      ) : (
        <View style={styles.emptyCard}>
          <View style={styles.emptyOrb}><Text style={styles.emptyOrbText}>AI</Text></View>
          <Text style={styles.emptyTitle}>还没有连接 AI 手办</Text>
          <Text style={styles.centerMuted}>添加智能底座，开启你们的故事。</Text>
        </View>
      )}

      <PrimaryButton label="＋ 添加智能底座" onPress={() => navigation.navigate('BasePreparation')} />

      <Text style={styles.sectionTitle}>连接设置</Text>
      <View style={[styles.listCard, styles.deviceConnectionCard]}>
        <Text style={styles.settingTitle}>后端服务地址</Text>
        <Text style={styles.muted}>换网络时修改；下次配网会自动写入底座</Text>
        <TextInput
          style={styles.deviceAddressInput}
          value={backendAddress}
          onChangeText={setBackendAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://电脑IP:3000"
        />
        <PrimaryButton
          label={savingBackend ? '正在保存并检测…' : '保存并检测连接'}
          disabled={savingBackend}
          onPress={() => void saveBackend()}
        />
      </View>
    </ScrollView>
  );
}

function getCharacterHomeTheme(
  name: string,
  accentColor?: string,
  backgroundImageUrl?: string | null,
) {
  const themes: Record<string, { slogan: string; image: ImageSourcePropType; overlay: string }> = {
    Suki: { slogan: '无暇孤独', image: sukiMorningImage, overlay: 'rgba(0, 0, 0, 0.13)' },
    念念: { slogan: '温柔相伴', image: niannianHomeImage, overlay: 'rgba(49, 24, 79, 0.10)' },
    苏软软: { slogan: '软软治愈', image: suRuanruanHomeImage, overlay: 'rgba(89, 48, 18, 0.08)' },
  };
  const theme = themes[name] ?? {
    slogan: '一直陪着你',
    image: sukiMorningImage,
    overlay: hexToRgba(accentColor ?? '#000000', 0.2),
  };
  const cloudImageUrl = backgroundImageUrl?.trim();
  return cloudImageUrl ? { ...theme, image: { uri: cloudImageUrl } } : theme;
}

function hexToRgba(hex: string, alpha: number) {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${alpha})`;
}

function HomeIconButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.homeIconButton} onPress={onPress}>
      <Text style={styles.homeIcon}>{icon}</Text>
      <Text style={styles.homeIconLabel}>{label}</Text>
    </Pressable>
  );
}

function HomeEntryButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.homeEntryButton} onPress={onPress}>
      <Text style={styles.homeEntryIcon}>{icon}</Text>
      <Text style={styles.homeEntryLabel}>{label}</Text>
    </Pressable>
  );
}

function MoodDiaryScreen({ navigation }: NativeStackScreenProps<FigureStackParamList, 'MoodDiary'>) {
  return (
    <View style={styles.centerPage}>
      <View style={styles.emptyOrb}><Text style={styles.emptyOrbText}>♡</Text></View>
      <Text style={styles.centerTitle}>心情日记</Text>
      <Text style={styles.centerMuted}>这个入口先放在首页里，后面我们再做日记记录和情绪陪伴。</Text>
      <PrimaryButton label="返回 AI手办" onPress={() => navigation.goBack()} />
    </View>
  );
}

function mergeConversationMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
) {
  const persistedRequestKeys = new Set(
    incoming
      .filter(
        (message) =>
          message.source.startsWith('app:') &&
          !message.id.startsWith('local-') &&
          !message.id.startsWith('stream-'),
      )
      .map((message) => `${message.source}:${message.role}`),
  );
  const byId = new Map(
    current
      .filter(
        (message) =>
          !(
            (message.id.startsWith('local-') || message.id.startsWith('stream-')) &&
            persistedRequestKeys.has(`${message.source}:${message.role}`)
          ),
      )
      .map((message) => [message.id, message]),
  );
  incoming.forEach((message) => byId.set(message.id, message));
  return Array.from(byId.values()).sort(
    (left, right) => {
      if (
        left.source.startsWith('app:') &&
        left.source === right.source &&
        left.role !== right.role
      ) {
        return left.role === 'user' ? -1 : 1;
      }
      return (
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
      );
    },
  );
}

const CONVERSATION_PAGE_SIZE = 30;

function createConversationRequestId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface FailedConversationRequest {
  text: string;
  clientRequestId: string;
}

function ConversationHistoryScreen({
  navigation,
  device,
  messages,
  token,
}: NativeStackScreenProps<FigureStackParamList, 'ConversationHistory'> & {
  device: Device | null;
  messages: ConversationMessage[];
  token: string;
}) {
  const characterId =
    device?.nfcTag?.matched && device.nfcTag.characterId
      ? device.nfcTag.characterId
      : device?.characterId ?? '';
  const [localMessages, setLocalMessages] = useState(messages);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');
  const [failedRequest, setFailedRequest] = useState<FailedConversationRequest | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [voiceRecognition, setVoiceRecognition] = useState<{
    phase: 'listening' | 'recognizing' | 'final' | 'error';
    text: string;
  } | null>(null);
  const [hasOlder, setHasOlder] = useState(
    messages.filter((message) => !characterId || message.characterId === characterId).length >=
      CONVERSATION_PAGE_SIZE,
  );
  const scrollRef = useRef<ScrollView>(null);
  const stickToBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const characterIdRef = useRef(characterId);
  const loadingOlderRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeStreamRef = useRef<FailedConversationRequest | null>(null);
  const voiceClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      activeStreamRef.current = null;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      if (voiceClearTimerRef.current) clearTimeout(voiceClearTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!device?.id || !token) return undefined;
    const stop = subscribeDeviceVoiceRecognition(token, device.id, (event) => {
      if (voiceClearTimerRef.current) {
        clearTimeout(voiceClearTimerRef.current);
        voiceClearTimerRef.current = null;
      }
      stickToBottomRef.current = true;
      if (event.type === 'voice.listening') {
        setVoiceRecognition({ phase: 'listening', text: '正在聆听…' });
      } else if (
        event.type === 'voice.transcript.partial' ||
        event.type === 'voice.transcript.sentence'
      ) {
        setVoiceRecognition({ phase: 'recognizing', text: event.text });
      } else if (event.type === 'voice.transcript.final') {
        setVoiceRecognition({
          phase: 'final',
          text: event.text || '没有听清，请再说一次',
        });
        voiceClearTimerRef.current = setTimeout(
          () => setVoiceRecognition(null),
          5000,
        );
      } else if (event.type === 'voice.error') {
        setVoiceRecognition({ phase: 'error', text: event.message });
        voiceClearTimerRef.current = setTimeout(
          () => setVoiceRecognition(null),
          3500,
        );
      }
    });
    return () => {
      stop();
      if (voiceClearTimerRef.current) clearTimeout(voiceClearTimerRef.current);
      voiceClearTimerRef.current = null;
    };
  }, [device?.id, token]);

  useEffect(() => {
    const currentCharacterMessages = characterId
      ? messages.filter((message) => message.characterId === characterId)
      : messages;
    if (characterIdRef.current !== characterId) {
      activeStreamRef.current = null;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      characterIdRef.current = characterId;
      setLocalMessages(currentCharacterMessages);
      setHiddenIds([]);
      setSelectedIds([]);
      setSelecting(false);
      setSending(false);
      setStreamingMessageId(null);
      setSendError('');
      setFailedRequest(null);
      setHasOlder(currentCharacterMessages.length >= CONVERSATION_PAGE_SIZE);
      initialScrollDoneRef.current = false;
      stickToBottomRef.current = true;
      return;
    }
    setLocalMessages((current) =>
      mergeConversationMessages(
        current.filter(
          (message) =>
            message.id.startsWith('stream-') ||
            message.id.startsWith('local-') ||
            !characterId ||
            message.characterId === characterId,
        ),
        currentCharacterMessages,
      ),
    );
  }, [characterId, messages]);

  useEffect(() => {
    setHiddenIds((current) => current.filter((id) => localMessages.some((message) => message.id === id)));
    setSelectedIds((current) => current.filter((id) => localMessages.some((message) => message.id === id)));
  }, [localMessages]);

  const visibleMessages = useMemo(
    () => localMessages.filter((message) => !hiddenIds.includes(message.id)),
    [hiddenIds, localMessages],
  );
  const selectedMessages = visibleMessages.filter((message) => selectedIds.includes(message.id));
  const characterName =
    device?.nfcTag?.matched && device.nfcTag.characterName
      ? device.nfcTag.characterName
      : device?.character?.name ?? 'Suki';
  const latestMessageContent = visibleMessages[visibleMessages.length - 1]?.content ?? '';

  const scrollToLatest = (animated: boolean) => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated }));
  };

  useEffect(() => {
    if (stickToBottomRef.current) scrollToLatest(initialScrollDoneRef.current);
  }, [latestMessageContent, visibleMessages.length, voiceRecognition?.text]);

  const loadOlderMessages = async () => {
    if (
      !device ||
      !hasOlder ||
      loadingOlderRef.current ||
      !initialScrollDoneRef.current
    ) {
      return;
    }
    const oldestMessage = visibleMessages.find(
      (message) =>
        !message.id.startsWith('local-') && !message.id.startsWith('stream-'),
    );
    if (!oldestMessage) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const olderMessages = await api.listConversationMessages(
        token,
        device.id,
        oldestMessage.createdAt,
        CONVERSATION_PAGE_SIZE,
      );
      setLocalMessages((current) =>
        mergeConversationMessages(current, olderMessages),
      );
      setHasOlder(olderMessages.length >= CONVERSATION_PAGE_SIZE);
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : '更早的对话加载失败',
      );
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const handleHistoryScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stickToBottomRef.current =
      contentSize.height - layoutMeasurement.height - contentOffset.y < 100;
    if (contentOffset.y < 80) void loadOlderMessages();
  };

  const stopStreamingMessage = () => {
    const activeRequest = activeStreamRef.current;
    if (!activeRequest) return;
    activeStreamRef.current = null;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setSending(false);
    setStreamingMessageId(null);
    setFailedRequest(activeRequest);
    setSendError('已停止生成，可以重新发送这条消息');
    setLocalMessages((current) =>
      current.filter(
        (message) =>
          message.id !== `stream-assistant-${activeRequest.clientRequestId}`,
      ),
    );
  };

  const sendStreamingMessage = async (retryRequest?: FailedConversationRequest) => {
    const text = retryRequest?.text ?? draft.trim();
    if (!text || !device || !characterId || sending) return;

    const clientRequestId =
      retryRequest?.clientRequestId ?? createConversationRequestId();
    const request = { text, clientRequestId };
    const localUserId = `local-user-${clientRequestId}`;
    const placeholderId = `stream-assistant-${clientRequestId}`;
    const createdAt = new Date().toISOString();
    let userMessageCreated = false;
    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;
    activeStreamRef.current = request;
    setDraft('');
    setSendError('');
    setFailedRequest(null);
    setSending(true);
    setStreamingMessageId(placeholderId);
    stickToBottomRef.current = true;
    setLocalMessages((current) => {
      const source = `app:${clientRequestId}`;
      const hasExistingUser = current.some(
        (message) => message.role === 'user' && message.source === source,
      );
      return mergeConversationMessages(current, [
        ...(hasExistingUser
          ? []
          : [
              {
                id: localUserId,
                deviceId: device.id,
                characterId,
                role: 'user' as const,
                content: text,
                source,
                createdAt,
              },
            ]),
        {
          id: placeholderId,
          deviceId: device.id,
          characterId,
          role: 'assistant',
          content: '',
          source,
          createdAt,
        },
      ]);
    });

    try {
      await api.streamConversationMessage(
        token,
        device.id,
        text,
        (event) => {
          if (activeStreamRef.current?.clientRequestId !== clientRequestId) return;
          if (event.type === 'message.created') {
            userMessageCreated = true;
            setLocalMessages((current) =>
              mergeConversationMessages(
                current.filter((message) => message.id !== localUserId),
                [event.message],
              ),
            );
          } else if (event.type === 'message.delta') {
            setLocalMessages((current) =>
              current.map((message) =>
                message.id === placeholderId
                  ? { ...message, content: message.content + event.delta }
                  : message,
              ),
            );
          } else if (event.type === 'message.completed') {
            setLocalMessages((current) =>
              mergeConversationMessages(
                current.filter((message) => message.id !== placeholderId),
                [event.message],
              ),
            );
          } else if (event.type === 'error') {
            setSendError(event.message);
          }
        },
        { clientRequestId, signal: controller.signal },
      );
    } catch (error) {
      if (
        activeStreamRef.current?.clientRequestId !== clientRequestId ||
        isConversationStreamCancelled(error)
      ) {
        return;
      }
      setSendError(error instanceof Error ? error.message : '发送失败，请稍后重试');
      setFailedRequest(request);
      setLocalMessages((current) =>
        current.filter(
          (message) =>
            message.id !== placeholderId &&
            (userMessageCreated || message.id !== localUserId),
        ),
      );
    } finally {
      if (activeStreamRef.current?.clientRequestId === clientRequestId) {
        activeStreamRef.current = null;
        streamAbortRef.current = null;
        setSending(false);
        setStreamingMessageId(null);
      }
    }
  };

  const deleteMessages = (ids: string[]) => {
    setHiddenIds((current) => Array.from(new Set([...current, ...ids])));
    setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
    setMenuMessageId(null);
    if (ids.length === selectedIds.length) setSelecting(false);
  };

  const enterSelecting = (messageId: string) => {
    setSelecting(true);
    setSelectedIds([messageId]);
    setMenuMessageId(null);
  };

  const toggleSelected = (messageId: string) => {
    setSelectedIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  };

  const copySelected = () => {
    if (!selectedMessages.length) return;
    Clipboard.setString(selectedMessages.map((message) => message.content).join('\n'));
    Alert.alert('已复制', `已复制 ${selectedMessages.length} 条对话`);
  };

  return (
    <SafeAreaView style={styles.historySafe}>
      <View style={styles.historyHeader}>
        <Pressable style={styles.historyBack} onPress={() => selecting ? (setSelecting(false), setSelectedIds([])) : navigation.goBack()}>
          <Text style={styles.historyBackText}>‹</Text>
        </Pressable>
        <Text style={styles.historyTitle}>与{characterName}的对话记录</Text>
        <View style={styles.historyBack} />
      </View>
      <KeyboardAvoidingView
        style={styles.historyBody}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.historyScroll}
          contentContainerStyle={[styles.historyContent, selecting && styles.historyContentSelecting]}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          scrollEventThrottle={32}
          onScroll={handleHistoryScroll}
          onContentSizeChange={() => {
            if (!initialScrollDoneRef.current || stickToBottomRef.current) {
              scrollToLatest(initialScrollDoneRef.current);
              initialScrollDoneRef.current = true;
            }
          }}
        >
          {loadingOlder ? (
            <View style={styles.historyOlderLoading}>
              <ActivityIndicator size="small" color="#777777" />
              <Text style={styles.historyOlderLoadingText}>正在加载更早的对话…</Text>
            </View>
          ) : null}
          {visibleMessages.length ? (
            visibleMessages.map((message, index) => {
              const previous = visibleMessages[index - 1];
              const showTime = !previous || formatHistoryBucket(previous.createdAt) !== formatHistoryBucket(message.createdAt);
              return (
                <View key={message.id}>
                  {showTime ? <Text style={styles.historyTime}>{formatHistoryBucket(message.createdAt)}</Text> : null}
                  <ConversationBubble
                    message={message}
                    streaming={streamingMessageId === message.id}
                    selecting={selecting}
                    selected={selectedIds.includes(message.id)}
                    menuVisible={menuMessageId === message.id}
                    onToggle={() => toggleSelected(message.id)}
                    onLongPress={() => setMenuMessageId(message.id)}
                    onDelete={() => deleteMessages([message.id])}
                    onSelect={() => enterSelecting(message.id)}
                  />
                </View>
              );
            })
          ) : (
            <View style={styles.historyEmpty}>
              <Text style={styles.centerTitle}>还没有对话记录</Text>
              <Text style={styles.centerMuted}>在下面输入文字，就可以开始和角色聊天。</Text>
            </View>
          )}
          {voiceRecognition ? (
            <View
              style={[
                styles.voiceRecognitionCard,
                voiceRecognition.phase === 'error' &&
                  styles.voiceRecognitionCardError,
              ]}
            >
              {voiceRecognition.phase === 'listening' ||
              voiceRecognition.phase === 'recognizing' ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.voiceRecognitionIcon}>
                  {voiceRecognition.phase === 'error' ? '!' : '✓'}
                </Text>
              )}
              <View style={styles.flex}>
                <Text style={styles.voiceRecognitionLabel}>
                  {voiceRecognition.phase === 'listening'
                    ? '底座正在聆听'
                    : voiceRecognition.phase === 'recognizing'
                      ? '正在识别'
                      : voiceRecognition.phase === 'final'
                        ? '已识别'
                        : '语音识别异常'}
                </Text>
                <Text style={styles.voiceRecognitionText}>
                  {voiceRecognition.text}
                </Text>
              </View>
            </View>
          ) : null}
          <Text style={styles.historyHint}>长按对话气泡可进行更多操作</Text>
        </ScrollView>
        {selecting ? (
          <View style={styles.historyBulkBar}>
            <Pressable style={styles.historyBulkAction} disabled={!selectedMessages.length} onPress={copySelected}>
              <Text style={styles.historyBulkIcon}>▣</Text>
            </Pressable>
            <Pressable
              style={styles.historyBulkAction}
              disabled={!selectedMessages.length}
              onPress={() => Alert.alert('删除消息', `确定删除选中的 ${selectedMessages.length} 条消息吗？`, [
                { text: '取消', style: 'cancel' },
                { text: '删除', style: 'destructive', onPress: () => deleteMessages(selectedIds) },
              ])}
            >
              <Text style={styles.historyBulkIcon}>⌫</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.historyComposerArea}>
            {sendError ? (
              <View style={styles.historySendErrorRow}>
                <Text style={styles.historySendError}>{sendError}</Text>
                {failedRequest && !sending ? (
                  <Pressable
                    style={styles.historyRetryButton}
                    onPress={() => void sendStreamingMessage(failedRequest)}
                  >
                    <Text style={styles.historyRetryButtonText}>重试</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            <View style={styles.historyComposer}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                style={styles.historyComposerInput}
                placeholder={`和${characterName}说点什么…`}
                placeholderTextColor="#999999"
                multiline
                maxLength={2000}
                editable={!sending && Boolean(device && characterId)}
                returnKeyType="send"
                blurOnSubmit={false}
                onSubmitEditing={() => {
                  if (!sending) void sendStreamingMessage();
                }}
              />
              <Pressable
                style={[
                  styles.historySendButton,
                  !sending &&
                    (!draft.trim() || !device || !characterId) &&
                    styles.historySendButtonDisabled,
                  sending && styles.historyStopButton,
                ]}
                disabled={!sending && (!draft.trim() || !device || !characterId)}
                onPress={() =>
                  sending
                    ? stopStreamingMessage()
                    : void sendStreamingMessage()
                }
              >
                <Text style={styles.historySendButtonText}>
                  {sending ? '停止' : '发送'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ConversationBubble({
  message,
  streaming,
  selecting,
  selected,
  menuVisible,
  onToggle,
  onLongPress,
  onDelete,
  onSelect,
}: {
  message: ConversationMessage;
  streaming: boolean;
  selecting: boolean;
  selected: boolean;
  menuVisible: boolean;
  onToggle: () => void;
  onLongPress: () => void;
  onDelete: () => void;
  onSelect: () => void;
}) {
  const mine = message.role === 'user';
  return (
    <View style={[styles.messageLine, mine && styles.messageLineMine]}>
      {selecting ? (
        <Pressable style={[styles.messageCheck, selected && styles.messageCheckSelected]} onPress={onToggle}>
          <Text style={styles.messageCheckText}>{selected ? '✓' : ''}</Text>
        </Pressable>
      ) : null}
      <View style={[styles.messageWrap, mine && styles.messageWrapMine]}>
        {menuVisible && !selecting ? (
          <View style={styles.messageMenu}>
            <Pressable style={styles.messageMenuItem} onPress={onDelete}>
              <Text style={styles.messageMenuIcon}>⌫</Text>
              <Text style={styles.messageMenuText}>删除</Text>
            </Pressable>
            <Pressable style={styles.messageMenuItem} onPress={onSelect}>
              <Text style={styles.messageMenuIcon}>☷</Text>
              <Text style={styles.messageMenuText}>多选</Text>
            </Pressable>
            <View style={styles.messageMenuArrow} />
          </View>
        ) : null}
        <Pressable
          onPress={selecting && !streaming ? onToggle : undefined}
          onLongPress={streaming ? undefined : onLongPress}
          delayLongPress={350}
          style={[styles.messageBubble, mine ? styles.messageBubbleMine : styles.messageBubbleAssistant]}
        >
          <Text style={[styles.messageText, mine && styles.messageTextMine]}>
            {message.content || (streaming ? '正在回复…' : '')}{streaming && message.content ? ' ▍' : ''}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function BasePreparationScreen({ navigation }: NativeStackScreenProps<FigureStackParamList, 'BasePreparation'>) {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <StepHeader
        step="01"
        title="让底座进入配网模式"
        body="开始连接前，请先完成下面两步。底座进入配网模式后，屏幕会显示 SETUP。"
      />
      <InstructionCard
        number="1"
        title="长按底座电源键开机"
        body="正式底座长按电源键开机；当前开发板接通 USB 电源即视为已经开机。"
        icon="⏻"
      />
      <InstructionCard
        number="2"
        title="长按 BOOT 约 5 秒"
        body="看到屏幕显示 SETUP 后松开。请不要在按住 BOOT 时重新上电。"
        icon="5s"
      />
      <View style={styles.setupPreview}>
        <Text style={styles.setupPreviewLabel}>底座屏幕应显示</Text>
        <Text style={styles.setupPreviewText}>SETUP</Text>
        <View style={styles.setupPreviewLight} />
      </View>
      <PrimaryButton label="我已看到 SETUP" onPress={() => navigation.navigate('EnvironmentCheck')} />
    </ScrollView>
  );
}

function EnvironmentCheckScreen({ navigation }: NativeStackScreenProps<FigureStackParamList, 'EnvironmentCheck'>) {
  const [environment, setEnvironment] = useState<ProvisioningEnvironment | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');

  const refreshEnvironment = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      setEnvironment(await provisioning.getEnvironmentStatus());
    } catch (environmentError) {
      setError(environmentError instanceof Error ? environmentError.message : '手机环境检测失败');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshEnvironment();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshEnvironment();
    });
    return () => subscription.remove();
  }, [refreshEnvironment]);

  const requestPermissions = async () => {
    try {
      await requestProvisioningPermissions();
    } catch (permissionError) {
      setError(permissionError instanceof Error ? permissionError.message : '权限未授权');
    } finally {
      await refreshEnvironment();
    }
  };
  const openSettings = async (section: 'network' | 'bluetooth' | 'location' | 'app') => {
    try {
      await provisioning.openSystemSettings(section);
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : '无法打开系统设置');
    }
  };

  const networkLabel = environment?.networkType === 'wifi'
    ? 'Wi‑Fi 网络可用'
    : environment?.networkType === 'cellular'
      ? '移动网络可用'
      : environment?.networkConnected
        ? '网络连接正常'
        : '手机当前无法访问网络';
  const locationReady = !environment?.locationRequired || (
    environment.locationEnabled && environment.locationPermission
  );
  const allReady = !!environment && environment.networkConnected &&
    environment.bluetoothEnabled && environment.bluetoothPermission && locationReady;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <StepHeader
        step="02"
        title="检查手机连接环境"
        body="配网需要网络和蓝牙。Android 11 及以下还需要开启定位服务才能搜索附近蓝牙设备。"
      />
      <View style={styles.environmentCard}>
        <EnvironmentRow
          label="网络连接"
          detail={networkLabel}
          ready={environment?.networkConnected === true}
          loading={!environment}
          actionLabel="去开启"
          onAction={() => void openSettings('network')}
        />
        <EnvironmentRow
          label="蓝牙"
          detail={environment?.bluetoothEnabled ? '蓝牙已开启' : '请开启手机蓝牙'}
          ready={environment?.bluetoothEnabled === true}
          loading={!environment}
          actionLabel="去开启"
          onAction={() => void openSettings('bluetooth')}
        />
        <EnvironmentRow
          label="附近设备权限"
          detail={environment?.bluetoothPermission ? '权限已授权' : '需要授权才能发现底座'}
          ready={environment?.bluetoothPermission === true}
          loading={!environment}
          actionLabel="去授权"
          onAction={() => void requestPermissions()}
          last={!environment?.locationRequired}
        />
        {environment?.locationRequired ? (
          <EnvironmentRow
            label="定位服务"
            detail={!environment.locationPermission ? '需要定位权限才能扫描蓝牙' : environment.locationEnabled ? '定位服务已开启' : '请开启手机定位服务'}
            ready={locationReady}
            loading={!environment}
            actionLabel={!environment.locationPermission ? '去授权' : '去开启'}
            onAction={() => environment.locationPermission ? void openSettings('location') : void requestPermissions()}
            last
          />
        ) : null}
      </View>
      {checking ? <View style={styles.inlineStatus}><ActivityIndicator color={palette.primaryDark} /><Text style={styles.muted}>正在检测…</Text></View> : null}
      {error ? <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View> : null}
      <SecondaryButton label="重新检测" onPress={() => void refreshEnvironment()} />
      <PrimaryButton label="开始添加" disabled={!allReady || checking} onPress={() => navigation.navigate('AddIntro')} />
      <Text style={styles.demoHint}>从系统设置返回后会自动重新检测；相机权限将在扫码时单独申请。</Text>
    </ScrollView>
  );
}

function AddIntroScreen({ navigation }: NativeStackScreenProps<FigureStackParamList, 'AddIntro'>) {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <StepHeader step="03" title="找到底座二维码" body="二维码位于智能底座底部，用来识别设备并完成安全校验。" />
      <View style={styles.illustration}><Text style={styles.illustrationIcon}>⌗</Text><Text style={styles.illustrationText}>底座二维码</Text></View>
      <View style={styles.notice}><Text style={styles.noticeTitle}>准备工作</Text><Text style={styles.noticeText}>请接通底座电源，并让手机靠近底座。配网过程中不要断电。</Text></View>
      <PrimaryButton label="扫描二维码" onPress={() => navigation.navigate('ScanQr')} />
      <SecondaryButton label="无法扫码？搜索附近底座" onPress={() => navigation.navigate('Scanning', { mode: 'add', descriptor: DEVELOPMENT_DESCRIPTOR })} />
    </ScrollView>
  );
}

function ScanQrScreen({ navigation }: NativeStackScreenProps<FigureStackParamList, 'ScanQr'>) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const onBarcodeScanned = ({ data }: BarcodeScanningResult) => {
    if (scanned) return;
    setScanned(true);
    try {
      const descriptor = parseProvisioningQr(data);
      // The QR already identifies one exact base and carries its security
      // material, so continue straight into discovery. The generic setup
      // instructions and device picker are only needed for manual discovery.
      navigation.replace('Scanning', { mode: 'add', descriptor });
    } catch (error) {
      Alert.alert('无法识别二维码', error instanceof Error ? error.message : '请扫描底座底部的二维码', [
        { text: '重新扫描', onPress: () => setScanned(false) },
      ]);
    }
  };

  if (!permission) {
    return <View style={styles.scannerPage}><ActivityIndicator color="#BAD472" size="large" /></View>;
  }
  if (!permission.granted) {
    return (
      <View style={styles.scannerPage}>
        <Text style={styles.scannerTitle}>需要相机权限</Text>
        <Text style={styles.scannerSubtitle}>相机只用于读取底座二维码，不会保存照片。</Text>
        <PrimaryButton label="允许使用相机" onPress={() => void requestPermission()} />
        <SecondaryButton label="改为搜索附近底座" onPress={() => navigation.replace('Scanning', { mode: 'add', descriptor: DEVELOPMENT_DESCRIPTOR })} />
      </View>
    );
  }

  return (
    <View style={styles.scannerPage}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : onBarcodeScanned}
      />
      <View style={styles.scannerShade} />
      <Text style={styles.scannerTitle}>将底座二维码放入框内</Text>
      <Text style={styles.scannerSubtitle}>二维码仅用于识别设备，不会保存 Wi‑Fi 密码</Text>
      <View style={styles.scanFrame}><View style={styles.scanLine} /></View>
      <SecondaryButton label="无法扫码？搜索附近底座" onPress={() => navigation.replace('Scanning', { mode: 'add', descriptor: DEVELOPMENT_DESCRIPTOR })} />
    </View>
  );
}

function PrepareDeviceScreen({ navigation, route }: NativeStackScreenProps<FigureStackParamList, 'PrepareDevice'>) {
  const isWifiChange = route.params.mode === 'wifi';
  const descriptor = route.params.descriptor ?? DEVELOPMENT_DESCRIPTOR;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <StepHeader step={isWifiChange ? 'Wi‑Fi' : '02'} title={isWifiChange ? '让底座进入换网模式' : '让底座进入配网模式'} body="长按底座按键约 5 秒，听到提示音并看到屏幕显示 SETUP 后松开。" />
      <View style={styles.baseIllustration}><View style={styles.baseTop}><Text style={styles.baseScreen}>SETUP</Text></View><View style={styles.baseLight} /></View>
      <View style={styles.checkCard}><Text style={styles.checkIcon}>✓</Text><View style={styles.flex}><Text style={styles.checkTitle}>我已看到 SETUP</Text><Text style={styles.muted}>请保持手机与底座在 1–2 米内</Text></View></View>
      <PrimaryButton label="继续搜索" onPress={() => navigation.navigate('Scanning', { mode: route.params.mode, descriptor })} />
    </ScrollView>
  );
}

function ScanningScreen({ navigation, route }: NativeStackScreenProps<FigureStackParamList, 'Scanning'>) {
  const [devices, setDevices] = useState<ProvisioningDevice[]>([]);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const isQrTarget = !route.params.descriptor.name.endsWith('_');
  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    setError('');
    setDevices([]);
    void (async () => {
      try {
        await requestProvisioningPermissions();
        const found = await provisioning.scanDevices(route.params.descriptor.name);
        if (cancelled) return;
        if (isQrTarget) {
          const target = found.find(
            (item) => item.name === route.params.descriptor.name,
          );
          if (!target) {
            setDevices([]);
            setError('未找到二维码对应的底座。请确认底座屏幕显示 SETUP。');
            return;
          }
          navigation.replace('SelectWifi', {
            mode: route.params.mode,
            descriptor: route.params.descriptor,
            device: target,
          });
          return;
        }
        setDevices(found);
      } catch (scanError) {
        if (!cancelled) setError(scanError instanceof Error ? scanError.message : '搜索智能底座失败');
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
      void provisioning.stopScan().catch(() => undefined);
    };
  }, [attempt, isQrTarget, navigation, route.params.descriptor, route.params.mode]);
  const found = devices.length > 0;
  return (
    <View style={styles.centerPage}>
      <View style={[styles.radar, found && styles.radarFound]}>{scanning ? <ActivityIndicator color={palette.primary} size="large" /> : <Text style={styles.radarText}>{found ? '✓' : '!'}</Text>}</View>
      <Text style={styles.centerTitle}>{scanning ? (isQrTarget ? '正在连接二维码对应的底座…' : '正在搜索附近底座…') : found ? `发现 ${devices.length} 台智能底座` : (isQrTarget ? '没有找到这台底座' : '没有发现智能底座')}</Text>
      <Text style={styles.centerMuted}>{error || (found ? devices.map((item) => item.name).join('、') : '请确认底座屏幕显示 SETUP，并让手机靠近底座')}</Text>
      {found && !isQrTarget ? <PrimaryButton label="查看设备" onPress={() => navigation.replace('SelectDevice', { ...route.params, devices })} /> : null}
      {!scanning && !found ? <PrimaryButton label="重新搜索" onPress={() => setAttempt((value) => value + 1)} /> : null}
      {!scanning && !found && isQrTarget ? <SecondaryButton label="查看如何进入配网模式" onPress={() => navigation.replace('PrepareDevice', route.params)} /> : null}
    </View>
  );
}

function SelectDeviceScreen({ navigation, route }: NativeStackScreenProps<FigureStackParamList, 'SelectDevice'>) {
  return (
    <View style={styles.page}>
      <StepHeader step="03" title="选择要连接的底座" body="请核对底座屏幕末四位，避免连接到附近其他设备。" />
      {route.params.devices.map((device) => (
        <Pressable key={device.id} style={styles.selectCard} onPress={() => navigation.navigate('SelectWifi', { mode: route.params.mode, descriptor: route.params.descriptor, device })}>
          <View style={styles.bluetoothIcon}><Text style={styles.bluetoothText}>ᛒ</Text></View>
          <View style={styles.flex}><Text style={styles.deviceName}>{device.name}</Text><Text style={styles.muted}>{device.rssi > -65 ? '信号良好' : '信号较弱'} · {device.rssi} dBm</Text></View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}
    </View>
  );
}

function SelectWifiScreen({ navigation, route }: NativeStackScreenProps<FigureStackParamList, 'SelectWifi'>) {
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [networks, setNetworks] = useState<ProvisioningWifi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await provisioning.connect(route.params.device.id, route.params.descriptor.pop, route.params.descriptor.security);
        const foundNetworks = await provisioning.scanWifiNetworks();
        if (!cancelled) {
          setNetworks(foundNetworks);
          if (foundNetworks[0]) setSsid(foundNetworks[0].ssid);
        }
      } catch (connectionError) {
        if (!cancelled) setError(connectionError instanceof Error ? connectionError.message : '连接智能底座失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [route.params.descriptor.pop, route.params.descriptor.security, route.params.device.id]);

  const selectedNetwork = networks.find((network) => network.ssid === ssid);
  const needsPassword = !selectedNetwork || selectedNetwork.security !== 0;
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <StepHeader step={route.params.mode === 'wifi' ? '换网' : '04'} title="选择 2.4GHz Wi‑Fi" body="ESP32-S3 仅支持 2.4GHz。双频路由器使用同名网络通常也可以。" />
      {loading ? <View style={styles.loadingCard}><ActivityIndicator color={palette.primary} /><Text style={styles.muted}>正在建立加密连接并读取附近 Wi‑Fi…</Text></View> : null}
      {error ? <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text><Text style={styles.muted}>请返回并确认底座仍显示 SETUP。</Text></View> : null}
      {!loading && !error && networks.length > 0 ? <View style={styles.listCard}>
        {networks.map((network) => (
          <Pressable key={network.ssid} style={styles.networkRow} onPress={() => setSsid(network.ssid)}>
            <Text style={styles.networkIcon}>⌁</Text><View style={styles.flex}><Text style={styles.networkName}>{network.ssid}</Text><Text style={styles.muted}>{network.rssi} dBm{network.security === 0 ? ' · 开放网络' : ' · 已加密'}</Text></View>
            <View style={[styles.radio, ssid === network.ssid && styles.radioSelected]} />
          </Pressable>
        ))}
      </View> : null}
      <Text style={styles.label}>Wi‑Fi 名称</Text>
      <TextInput style={styles.input} value={ssid} onChangeText={setSsid} autoCapitalize="none" placeholder="输入 2.4GHz Wi‑Fi 名称" />
      <Text style={styles.label}>Wi‑Fi 密码</Text>
      <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" placeholder="仅通过加密蓝牙发送给底座" />
      <PrimaryButton label={route.params.mode === 'wifi' ? '更新网络' : '连接并绑定'} disabled={loading || !!error || !ssid.trim() || (needsPassword && !password)} onPress={() => navigation.navigate('Provisioning', { mode: route.params.mode, descriptor: route.params.descriptor, ssid: ssid.trim(), password })} />
    </ScrollView>
  );
}

function ProvisioningScreen({
  navigation,
  route,
  onClaimDevice,
}: NativeStackScreenProps<FigureStackParamList, 'Provisioning'> & {
  onClaimDevice: (pairingCode?: string) => Promise<void>;
}) {
  const labels = route.params.mode === 'wifi'
    ? ['发送新网络', '底座连接 Wi‑Fi', '确认网络更新']
    : ['发送网络信息', '底座连接 Wi‑Fi', '绑定当前账号'];
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [networkReady, setNetworkReady] = useState(false);

  const claimAndFinish = useCallback(async () => {
    setError('');
    setActive(labels.length - 1);
    try {
      await onClaimDevice(route.params.descriptor.pairingCode);
      setActive(labels.length);
      navigation.replace('SetupSuccess', { mode: route.params.mode });
    } catch (claimError) {
      setError(`Wi‑Fi 已配置成功，但账号绑定失败：${claimError instanceof Error ? claimError.message : '请稍后重试'}`);
    }
  }, [labels.length, navigation, onClaimDevice, route.params.descriptor.pairingCode, route.params.mode]);

  useEffect(() => {
    let cancelled = false;
    setActive(0);
    setError('');
    setNetworkReady(false);
    void (async () => {
      try {
        setActive(1);
        await provisioning.provision(
          route.params.ssid,
          route.params.password,
          getApiBaseUrl(),
        );
        if (cancelled) return;
        await provisioning.disconnect();
        setNetworkReady(true);
        if (route.params.mode === 'add') {
          await claimAndFinish();
        } else {
          setActive(labels.length);
          navigation.replace('SetupSuccess', { mode: route.params.mode });
        }
      } catch (provisionError) {
        void provisioning.disconnect().catch(() => undefined);
        if (!cancelled) setError(provisionError instanceof Error ? provisionError.message : '底座联网失败');
      }
    })();
    return () => { cancelled = true; };
  }, [attempt, claimAndFinish, labels.length, navigation, route.params.mode, route.params.password, route.params.ssid]);
  return (
    <View style={styles.page}>
      <StepHeader step="05" title={route.params.mode === 'wifi' ? '正在更新网络' : '正在连接底座'} body={`目标网络：${route.params.ssid}。请勿关闭 APP 或断开底座电源。`} />
      <View style={styles.progressCard}>
        {labels.map((label, index) => {
          const complete = index < active;
          const current = index === active;
          return <View key={label} style={styles.progressRow}><View style={[styles.progressDot, complete && styles.progressComplete, current && styles.progressCurrent]}><Text style={styles.progressDotText}>{complete ? '✓' : index + 1}</Text></View><Text style={[styles.progressText, (complete || current) && styles.progressTextActive]}>{label}</Text><Text style={styles.progressState}>{complete ? '完成' : current ? '进行中' : ''}</Text></View>;
        })}
      </View>
      {error ? <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text><Text style={styles.muted}>{networkReady ? '底座已经联网，只需重新绑定账号，无需再次发送 Wi‑Fi 密码。' : '请检查 Wi‑Fi 密码和 2.4GHz 网络后重试。'}</Text></View> : null}
      {error ? <PrimaryButton label={networkReady ? '重新绑定账号' : '重新发送'} onPress={() => networkReady ? void claimAndFinish() : setAttempt((value) => value + 1)} /> : null}
    </View>
  );
}

function SetupSuccessScreen({ navigation, route }: NativeStackScreenProps<FigureStackParamList, 'SetupSuccess'>) {
  const changedWifi = route.params.mode === 'wifi';
  return (
    <View style={styles.successPage}>
      <View style={styles.successIcon}><Text style={styles.successIconText}>✓</Text></View>
      <Text style={styles.successTitle}>{changedWifi ? '网络更新成功' : '智能底座配置成功'}</Text>
      <Text style={styles.successBody}>{changedWifi ? '账号、角色与聊天记忆均保持不变。' : '将 AI 手办放在底座上，即可开始聊天。NFC 接入前可在 APP 中选择角色。'}</Text>
      <View style={styles.successBase}><Text style={styles.successBaseText}>屿宙AI手办</Text></View>
      <PrimaryButton label="完成" onPress={() => navigation.popToTop()} />
    </View>
  );
}

function DashboardScreen({ navigation, device }: NativeStackScreenProps<FigureStackParamList, 'Dashboard'> & { device: Device | null }) {
  const name = device?.name ?? '屿宙AI手办底座';
  const nfcState = device?.nfcTag
    ? device.nfcTag.matched
      ? device.nfcTag.characterName ?? '已识别'
      : '待绑定'
    : '未放置';
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.dashboardHero}>
        <View style={styles.largeAvatar}><Text style={styles.largeAvatarText}>{device?.character?.name?.slice(0, 1) ?? '屿'}</Text></View>
        <View style={styles.flex}><Text style={styles.dashboardName}>{name}</Text><Text style={styles.onlineLine}>● {device?.status === 'offline' ? '离线' : '在线'}　{device?.character?.name ?? '等待角色'}</Text></View>
      </View>
      <View style={styles.statRow}><Stat label="音量" value={`${device?.volume ?? 55}%`} /><Stat label="手办" value={nfcState} /><Stat label="连接" value={device?.status === 'online' ? '正常' : '离线'} /></View>
      <View style={styles.listCard}>
        <DetailRow label="当前标签" value={device?.nfcTag?.uid ?? '未检测到 NFC 标签'} />
        <DetailRow label="标签角色" value={device?.nfcTag?.matched ? device.nfcTag.characterName ?? '已匹配' : device?.nfcTag ? '未绑定，请到设备调试页绑定角色' : '等待放置手办'} last />
      </View>
      <Text style={styles.sectionTitle}>设备设置</Text>
      <View style={styles.listCard}>
        <SettingsRow label="设备详情" value={device?.hardwareId ?? 'FIGURE-6055'} onPress={() => navigation.navigate('DeviceDetail')} />
        <SettingsRow label="更换 Wi‑Fi" value="保留账号与记忆" onPress={() => navigation.navigate('PrepareDevice', { mode: 'wifi' })} />
        <SettingsRow label="设备管理" value="睡眠与解绑" onPress={() => navigation.navigate('DeviceManagement')} last />
      </View>
      <Text style={styles.demoHint}>换网使用底座的加密蓝牙配网模式；账号和角色数据不会被清除。</Text>
    </ScrollView>
  );
}

function DeviceDetailScreen({ device }: NativeStackScreenProps<FigureStackParamList, 'DeviceDetail'> & { device: Device | null }) {
  return <View style={styles.page}><View style={styles.listCard}><DetailRow label="设备编号" value={device?.hardwareId ?? 'FIGURE-6055'} /><DetailRow label="硬件版本" value="ESP32-S3 N16R8" /><DetailRow label="固件版本" value={device?.firmwareVersion ?? '开发版'} /><DetailRow label="联网方式" value="Wi‑Fi 2.4GHz" /><DetailRow label="当前角色" value={device?.character?.name ?? '等待 NFC 手办'} /><DetailRow label="NFC 标签" value={device?.nfcTag?.uid ?? '未检测到'} /><DetailRow label="NFC 匹配" value={device?.nfcTag?.matched ? device.nfcTag.characterName ?? '已匹配' : device?.nfcTag ? '未绑定' : '无标签'} last /></View></View>;
}

function DeviceManagementScreen({
  navigation,
  device,
  token,
  onDeviceChanged,
}: NativeStackScreenProps<FigureStackParamList, 'DeviceManagement'> & {
  device: Device | null;
  token: string;
  onDeviceChanged: () => Promise<void>;
}) {
  const [sleep, setSleep] = useState(false);
  const [unbinding, setUnbinding] = useState(false);

  const unbind = async () => {
    if (!device || unbinding) return;
    try {
      setUnbinding(true);
      await api.unbindDevice(token, device.id);
      await onDeviceChanged();
      navigation.popToTop();
      Alert.alert('解绑成功', '底座已从当前账号移除。需要交给其他人时，请再让底座进入配网模式。');
    } catch (unbindError) {
      Alert.alert('解绑失败', unbindError instanceof Error ? unbindError.message : '请稍后重试');
    } finally {
      setUnbinding(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.settingCard}><View style={styles.flex}><Text style={styles.settingTitle}>睡眠模式</Text><Text style={styles.muted}>降低音量和灯光亮度</Text></View><Switch value={sleep} onValueChange={setSleep} trackColor={{ true: palette.primary }} /></View>
      <View style={styles.notice}><Text style={styles.noticeTitle}>解除绑定</Text><Text style={styles.noticeText}>解绑会停止该底座的提醒并清除待执行指令，但不会删除当前账号的聊天记忆，也不会自动清除 Wi‑Fi。</Text></View>
      <Pressable
        disabled={!device || unbinding}
        style={[styles.dangerButton, (!device || unbinding) && styles.disabled]}
        onPress={() => Alert.alert('确认解除绑定？', '解绑后其他账号可以使用底座认领码重新绑定。', [
          { text: '取消', style: 'cancel' },
          { text: '解除绑定', style: 'destructive', onPress: () => void unbind() },
        ])}
      ><Text style={styles.dangerText}>{unbinding ? '正在解绑…' : '解除当前账号绑定'}</Text></Pressable>
    </ScrollView>
  );
}

function StepHeader({ step, title, body }: { step: string; title: string; body: string }) {
  return <View><Text style={styles.step}>{step}</Text><Text style={styles.pageTitle}>{title}</Text><Text style={styles.pageBody}>{body}</Text></View>;
}

function PrimaryButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={[styles.primaryButton, disabled && styles.disabled]}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}

function InstructionCard({
  number,
  title,
  body,
  icon,
}: {
  number: string;
  title: string;
  body: string;
  icon: string;
}) {
  return (
    <View style={styles.instructionCard}>
      <View style={styles.instructionIcon}><Text style={styles.instructionIconText}>{icon}</Text></View>
      <View style={styles.flex}>
        <Text style={styles.instructionStep}>第 {number} 步</Text>
        <Text style={styles.instructionTitle}>{title}</Text>
        <Text style={styles.instructionBody}>{body}</Text>
      </View>
    </View>
  );
}

function EnvironmentRow({
  label,
  detail,
  ready,
  loading,
  actionLabel,
  onAction,
  last = false,
}: {
  label: string;
  detail: string;
  ready: boolean;
  loading: boolean;
  actionLabel: string;
  onAction: () => void;
  last?: boolean;
}) {
  return (
    <View style={[styles.environmentRow, last && styles.noBorder]}>
      <View style={[styles.environmentState, loading ? styles.environmentLoading : ready ? styles.environmentReady : styles.environmentBlocked]}>
        <Text style={styles.environmentStateText}>{loading ? '…' : ready ? '✓' : '×'}</Text>
      </View>
      <View style={styles.flex}>
        <Text style={styles.environmentLabel}>{label}</Text>
        <Text style={[styles.environmentDetail, !ready && !loading && styles.environmentDetailBlocked]}>{detail}</Text>
      </View>
      {!ready && !loading ? (
        <Pressable style={styles.environmentAction} onPress={onAction}>
          <Text style={styles.environmentActionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SettingsRow({ label, value, onPress, last = false }: { label: string; value: string; onPress: () => void; last?: boolean }) {
  return <Pressable onPress={onPress} style={[styles.settingsRow, last && styles.noBorder]}><View style={styles.flex}><Text style={styles.settingTitle}>{label}</Text><Text style={styles.muted}>{value}</Text></View><Text style={styles.chevron}>›</Text></Pressable>;
}

function DetailRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return <View style={[styles.detailRow, last && styles.noBorder]}><Text style={styles.muted}>{label}</Text><Text style={styles.detailValue}>{value}</Text></View>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function beijingParts(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value;
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: beijing.getUTCFullYear(),
    month: beijing.getUTCMonth() + 1,
    day: beijing.getUTCDate(),
    hour: beijing.getUTCHours(),
    minute: beijing.getUTCMinutes(),
  };
}

function beijingDayKey(value: string | Date) {
  const parts = beijingParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatHistoryBucket(value: string) {
  const parts = beijingParts(value);
  const now = new Date();
  const todayKey = beijingDayKey(now);
  const yesterdayKey = beijingDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const key = beijingDayKey(value);
  const day = key === todayKey ? '今天' : key === yesterdayKey ? '昨天' : `${parts.month}月${parts.day}日`;
  return `${day} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  figureHome: { flex: 1, backgroundColor: '#111111' },
  figureHomeVeil: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0, 0, 0, 0.13)' },
  figureHomeSafe: { flex: 1, paddingHorizontal: 22, paddingTop: 10, paddingBottom: 18 },
  figureHomeTop: { minHeight: 94, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' },
  roundBackButton: { position: 'absolute', left: 0, top: 5, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(36, 36, 36, 0.48)', alignItems: 'center', justifyContent: 'center' },
  roundBackText: { color: '#FFFFFF', fontSize: 42, lineHeight: 43, fontWeight: '300', marginTop: -3 },
  figureSignature: { color: '#FFFFFF', fontSize: 30, lineHeight: 42, fontWeight: '300', textAlign: 'center', textShadowColor: 'rgba(0, 0, 0, 0.28)', textShadowRadius: 10, textShadowOffset: { width: 0, height: 3 }, marginTop: 8, marginHorizontal: 54, flex: 1 },
  homeSideActions: { position: 'absolute', right: 17, top: 156, gap: 22 },
  homeIconButton: { alignItems: 'center', gap: 4 },
  homeIcon: { width: 55, height: 55, borderRadius: 28, overflow: 'hidden', backgroundColor: 'rgba(62, 62, 62, 0.62)', color: '#FFFFFF', textAlign: 'center', lineHeight: 55, fontSize: 29, fontWeight: '900' },
  homeIconLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '900', textShadowColor: 'rgba(0, 0, 0, 0.55)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 2 } },
  homeBottomActions: { position: 'absolute', left: 48, right: 48, bottom: 34, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  homeEntryButton: { alignItems: 'center', minWidth: 98 },
  homeEntryIcon: { color: '#FFFFFF', fontSize: 46, lineHeight: 54, fontWeight: '900', textShadowColor: 'rgba(0, 0, 0, 0.55)', textShadowRadius: 9, textShadowOffset: { width: 0, height: 3 } },
  homeEntryLabel: { color: '#FFFFFF', fontSize: 21, fontWeight: '900', marginTop: 3, textShadowColor: 'rgba(0, 0, 0, 0.52)', textShadowRadius: 8, textShadowOffset: { width: 0, height: 2 } },
  historySafe: { flex: 1, backgroundColor: '#FFFFFF' },
  historyHeader: { height: 106, paddingTop: 22, backgroundColor: '#F0F0F0', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  historyBack: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  historyBackText: { color: '#202020', fontSize: 43, lineHeight: 44, fontWeight: '300' },
  historyTitle: { color: '#111111', fontSize: 22, fontWeight: '500' },
  historyBody: { flex: 1 },
  historyScroll: { flex: 1 },
  historyContent: { paddingHorizontal: 22, paddingTop: 20, paddingBottom: 42, minHeight: '100%' },
  historyContentSelecting: { paddingBottom: 96 },
  historyOlderLoading: { height: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  historyOlderLoadingText: { color: '#888888', fontSize: 12 },
  historyTime: { color: '#888888', fontSize: 15, textAlign: 'center', marginBottom: 24, marginTop: 8 },
  historyHint: { color: '#D0D0D0', fontSize: 16, textAlign: 'center', marginTop: 38 },
  voiceRecognitionCard: { alignSelf: 'flex-end', width: '78%', minHeight: 72, borderRadius: 22, borderBottomRightRadius: 4, backgroundColor: '#222222', paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 4, marginBottom: 4 },
  voiceRecognitionCardError: { backgroundColor: '#B44842' },
  voiceRecognitionIcon: { width: 20, color: '#FFFFFF', fontSize: 18, lineHeight: 22, fontWeight: '900', textAlign: 'center' },
  voiceRecognitionLabel: { color: '#B8D16E', fontSize: 11, lineHeight: 16, fontWeight: '800' },
  voiceRecognitionText: { color: '#FFFFFF', fontSize: 16, lineHeight: 23, marginTop: 2 },
  historyEmpty: { minHeight: 360, alignItems: 'center', justifyContent: 'center', gap: 8 },
  messageLine: { flexDirection: 'row', alignItems: 'center', marginBottom: 32 },
  messageLineMine: { justifyContent: 'flex-end' },
  messageCheck: { width: 30, height: 30, borderRadius: 15, borderWidth: 1.2, borderColor: '#7AC060', alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  messageCheckSelected: { backgroundColor: '#7AC060' },
  messageCheckText: { color: '#FFFFFF', fontSize: 22, lineHeight: 25, fontWeight: '900' },
  messageWrap: { maxWidth: '74%', position: 'relative', alignItems: 'flex-start' },
  messageWrapMine: { alignItems: 'flex-end' },
  messageBubble: { paddingHorizontal: 18, paddingVertical: 13, minHeight: 52 },
  messageBubbleAssistant: { backgroundColor: '#EEEEEE', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomRightRadius: 20, borderBottomLeftRadius: 0 },
  messageBubbleMine: { backgroundColor: '#000000', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomLeftRadius: 20, borderBottomRightRadius: 0 },
  messageText: { color: '#202020', fontSize: 20, lineHeight: 28 },
  messageTextMine: { color: '#FFFFFF' },
  messageMenu: { position: 'absolute', left: 42, top: -78, width: 130, height: 56, borderRadius: 9, backgroundColor: '#666666', zIndex: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  messageMenuItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  messageMenuIcon: { color: '#FFFFFF', fontSize: 18, lineHeight: 20 },
  messageMenuText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  messageMenuArrow: { position: 'absolute', left: 55, bottom: -10, width: 0, height: 0, borderLeftWidth: 10, borderRightWidth: 10, borderTopWidth: 10, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#666666' },
  historyBulkBar: { height: 65, backgroundColor: '#F1F1F1', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DDDDDD', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  historyBulkAction: { width: 88, height: 56, alignItems: 'center', justifyContent: 'center' },
  historyBulkIcon: { color: '#686868', fontSize: 33, fontWeight: '700' },
  historyComposerArea: { backgroundColor: '#FFFFFF', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E2E2E2', paddingHorizontal: 13, paddingTop: 9, paddingBottom: 9 },
  historyComposer: { minHeight: 48, flexDirection: 'row', alignItems: 'flex-end', gap: 9 },
  historyComposerInput: { flex: 1, minHeight: 46, maxHeight: 112, borderRadius: 23, backgroundColor: '#F1F1F1', color: '#181818', fontSize: 16, lineHeight: 22, paddingHorizontal: 17, paddingTop: 12, paddingBottom: 10 },
  historySendButton: { width: 62, height: 46, borderRadius: 23, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },
  historyStopButton: { backgroundColor: '#C84D46' },
  historySendButtonDisabled: { backgroundColor: '#C9C9C9' },
  historySendButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  historySendErrorRow: { minHeight: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginHorizontal: 7, marginBottom: 5 },
  historySendError: { flex: 1, color: '#C53B35', fontSize: 12, lineHeight: 17 },
  historyRetryButton: { minWidth: 48, height: 25, paddingHorizontal: 10, borderRadius: 13, backgroundColor: '#F1E2E0', alignItems: 'center', justifyContent: 'center' },
  historyRetryButtonText: { color: '#B43B35', fontSize: 12, fontWeight: '800' },
  page: { padding: 20, paddingBottom: 42, gap: 16 },
  centerPage: { flex: 1, padding: 28, justifyContent: 'center', alignItems: 'center', gap: 14 },
  brandBlock: { backgroundColor: palette.ink, borderRadius: 28, padding: 24, marginBottom: 2 },
  kicker: { color: '#BAD472', fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  heroTitle: { color: '#FFFFFF', fontSize: 28, lineHeight: 38, fontWeight: '900', marginTop: 16, maxWidth: 290 },
  heroBody: { color: '#CFC9D2', fontSize: 14, lineHeight: 22, marginTop: 12 },
  deviceCard: { backgroundColor: palette.surface, borderRadius: 22, borderWidth: 1, borderColor: palette.border, padding: 16, flexDirection: 'row', gap: 14, alignItems: 'center' },
  figureAvatar: { width: 68, height: 68, borderRadius: 34, backgroundColor: palette.sand, alignItems: 'center', justifyContent: 'center' },
  figureAvatarText: { color: palette.primaryDark, fontSize: 26, fontWeight: '900' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  deviceName: { color: palette.ink, fontSize: 17, fontWeight: '800', flexShrink: 1 },
  status: { fontSize: 11, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  online: { color: '#26794E', backgroundColor: '#E6F6ED' },
  offline: { color: palette.muted, backgroundColor: '#EFEDF0' },
  muted: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  linkText: { color: palette.primaryDark, fontSize: 12, fontWeight: '800', marginTop: 8 },
  emptyCard: { minHeight: 260, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface, borderRadius: 24, borderWidth: 1, borderColor: palette.border, padding: 24 },
  emptyOrb: { width: 92, height: 92, borderRadius: 46, backgroundColor: palette.primarySoft, alignItems: 'center', justifyContent: 'center' },
  emptyOrbText: { color: palette.primary, fontSize: 25, fontWeight: '900' },
  emptyTitle: { color: palette.ink, fontSize: 20, fontWeight: '900', marginTop: 18 },
  centerMuted: { color: palette.muted, fontSize: 14, lineHeight: 22, textAlign: 'center' },
  primaryButton: { minHeight: 54, borderRadius: 27, paddingHorizontal: 22, backgroundColor: palette.primary, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
  disabled: { opacity: 0.4 },
  secondaryButton: { minHeight: 50, borderRadius: 25, paddingHorizontal: 18, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { color: palette.ink, fontSize: 14, fontWeight: '800' },
  demoHint: { color: '#9B949E', fontSize: 11, textAlign: 'center', lineHeight: 17 },
  step: { color: palette.primary, fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  pageTitle: { color: palette.ink, fontSize: 27, lineHeight: 36, fontWeight: '900', marginTop: 7 },
  pageBody: { color: palette.muted, fontSize: 15, lineHeight: 24, marginTop: 9 },
  instructionCard: { minHeight: 128, borderRadius: 21, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, padding: 17, flexDirection: 'row', alignItems: 'center', gap: 15 },
  instructionIcon: { width: 62, height: 62, borderRadius: 20, backgroundColor: palette.primarySoft, alignItems: 'center', justifyContent: 'center' },
  instructionIconText: { color: palette.primaryDark, fontSize: 21, fontWeight: '900' },
  instructionStep: { color: palette.primaryDark, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  instructionTitle: { color: palette.ink, fontSize: 17, fontWeight: '900', marginTop: 4 },
  instructionBody: { color: palette.muted, fontSize: 12, lineHeight: 19, marginTop: 6 },
  setupPreview: { minHeight: 112, borderRadius: 21, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  setupPreviewLabel: { color: '#A9A2AC', fontSize: 11, fontWeight: '700' },
  setupPreviewText: { color: '#BAD472', fontSize: 25, fontWeight: '900', letterSpacing: 5, marginTop: 8 },
  setupPreviewLight: { position: 'absolute', left: 26, right: 26, bottom: 0, height: 5, borderRadius: 3, backgroundColor: '#BAD472' },
  environmentCard: { borderRadius: 21, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, overflow: 'hidden' },
  environmentRow: { minHeight: 82, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  environmentState: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  environmentLoading: { backgroundColor: '#B8B2B9' },
  environmentReady: { backgroundColor: palette.green },
  environmentBlocked: { backgroundColor: palette.red },
  environmentStateText: { color: '#FFFFFF', fontSize: 18, lineHeight: 22, fontWeight: '900' },
  environmentLabel: { color: palette.ink, fontSize: 15, fontWeight: '900' },
  environmentDetail: { color: palette.green, fontSize: 11, lineHeight: 17, marginTop: 3 },
  environmentDetailBlocked: { color: palette.red },
  environmentAction: { minHeight: 34, borderRadius: 17, borderWidth: 1, borderColor: palette.primary, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  environmentActionText: { color: palette.primaryDark, fontSize: 11, fontWeight: '900' },
  inlineStatus: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  illustration: { height: 230, borderRadius: 24, backgroundColor: palette.sand, alignItems: 'center', justifyContent: 'center' },
  illustrationIcon: { color: palette.primaryDark, fontSize: 75 },
  illustrationText: { color: palette.primaryDark, fontSize: 14, fontWeight: '800', marginTop: 5 },
  notice: { backgroundColor: palette.sand, borderRadius: 18, padding: 17 },
  noticeTitle: { color: palette.ink, fontSize: 15, fontWeight: '900' },
  noticeText: { color: palette.muted, fontSize: 13, lineHeight: 21, marginTop: 6 },
  scannerPage: { flex: 1, backgroundColor: '#17151A', padding: 24, justifyContent: 'center', gap: 18, overflow: 'hidden' },
  scannerShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 13, 17, 0.42)' },
  scannerTitle: { color: '#FFFFFF', fontSize: 23, fontWeight: '900', textAlign: 'center' },
  scannerSubtitle: { color: '#BDB8C0', fontSize: 13, lineHeight: 20, textAlign: 'center' },
  scanFrame: { alignSelf: 'center', width: 270, height: 270, borderWidth: 3, borderColor: '#FFFFFF', borderRadius: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginVertical: 10 },
  scanLine: { position: 'absolute', top: 134, left: 15, right: 15, height: 2, backgroundColor: '#BAD472' },
  scanMark: { color: '#FFFFFF', fontSize: 75, opacity: 0.25 },
  mockBanner: { backgroundColor: '#2A272D', borderRadius: 12, padding: 12 },
  mockText: { color: '#CFC9D2', fontSize: 12, textAlign: 'center' },
  baseIllustration: { height: 230, justifyContent: 'center', alignItems: 'center' },
  baseTop: { width: 220, height: 105, borderRadius: 55, backgroundColor: '#302B34', alignItems: 'center', justifyContent: 'center' },
  baseScreen: { color: '#BAD472', fontWeight: '900', letterSpacing: 4 },
  baseLight: { width: 190, height: 10, borderRadius: 5, backgroundColor: '#BAD472', marginTop: -9 },
  checkCard: { backgroundColor: palette.surface, borderRadius: 18, borderWidth: 1, borderColor: palette.border, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: palette.primary, color: '#FFFFFF', textAlign: 'center', lineHeight: 32, fontWeight: '900' },
  checkTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  radar: { width: 150, height: 150, borderRadius: 75, backgroundColor: palette.primarySoft, borderWidth: 18, borderColor: '#F6F9EF', alignItems: 'center', justifyContent: 'center' },
  radarFound: { backgroundColor: '#E5F5EB', borderColor: '#F0F9F3' },
  radarText: { color: palette.primary, fontSize: 48, fontWeight: '900' },
  centerTitle: { color: palette.ink, fontSize: 22, fontWeight: '900', textAlign: 'center', marginTop: 12 },
  selectCard: { backgroundColor: palette.surface, borderRadius: 20, borderWidth: 1, borderColor: palette.border, padding: 17, flexDirection: 'row', alignItems: 'center', gap: 13 },
  bluetoothIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: palette.primarySoft, alignItems: 'center', justifyContent: 'center' },
  bluetoothText: { color: palette.primaryDark, fontSize: 24, fontWeight: '900' },
  chevron: { color: '#989198', fontSize: 32, fontWeight: '300' },
  listCard: { backgroundColor: palette.surface, borderRadius: 20, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' },
  deviceConnectionCard: { padding: 18, overflow: 'visible' },
  deviceAddressInput: { marginTop: 14, marginBottom: 2, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 14, color: palette.ink, backgroundColor: '#FFFFFF', fontSize: 15 },
  networkRow: { minHeight: 62, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, gap: 12 },
  networkIcon: { color: palette.ink, fontSize: 21 },
  networkName: { flex: 1, color: palette.ink, fontSize: 15, fontWeight: '700' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: '#B8B2B9' },
  radioSelected: { borderWidth: 6, borderColor: palette.primary },
  label: { color: palette.ink, fontSize: 13, fontWeight: '800', marginBottom: -8 },
  input: { minHeight: 52, borderRadius: 15, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, color: palette.ink, fontSize: 15 },
  loadingCard: { minHeight: 72, borderRadius: 18, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  errorCard: { borderRadius: 18, borderWidth: 1, borderColor: '#F0C7C7', backgroundColor: '#FFF7F7', padding: 16, gap: 5 },
  errorText: { color: palette.red, fontSize: 15, lineHeight: 22, fontWeight: '800' },
  progressCard: { backgroundColor: palette.surface, borderRadius: 22, borderWidth: 1, borderColor: palette.border, padding: 18, gap: 5 },
  progressRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 },
  progressDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#EEECEF', alignItems: 'center', justifyContent: 'center' },
  progressComplete: { backgroundColor: palette.green },
  progressCurrent: { backgroundColor: palette.primary },
  progressDotText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  progressText: { flex: 1, color: '#A19AA2', fontSize: 15, fontWeight: '700' },
  progressTextActive: { color: palette.ink },
  progressState: { color: palette.primaryDark, fontSize: 11, fontWeight: '800' },
  successPage: { flex: 1, padding: 26, paddingBottom: 38, alignItems: 'center', justifyContent: 'center', gap: 14 },
  successIcon: { width: 78, height: 78, borderRadius: 39, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  successIconText: { color: '#FFFFFF', fontSize: 38, fontWeight: '900' },
  successTitle: { color: palette.ink, fontSize: 28, fontWeight: '900', textAlign: 'center', marginTop: 12 },
  successBody: { color: palette.muted, fontSize: 15, lineHeight: 24, textAlign: 'center' },
  successBase: { width: 240, height: 150, borderRadius: 75, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center', marginVertical: 20 },
  successBaseText: { color: '#BAD472', fontSize: 17, fontWeight: '900' },
  dashboardHero: { backgroundColor: palette.sand, borderRadius: 24, padding: 20, flexDirection: 'row', alignItems: 'center', gap: 16 },
  largeAvatar: { width: 82, height: 82, borderRadius: 41, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  largeAvatarText: { color: palette.primaryDark, fontSize: 32, fontWeight: '900' },
  dashboardName: { color: palette.ink, fontSize: 20, fontWeight: '900' },
  onlineLine: { color: palette.green, fontSize: 13, fontWeight: '700', marginTop: 8 },
  statRow: { flexDirection: 'row', backgroundColor: palette.surface, borderRadius: 20, borderWidth: 1, borderColor: palette.border, paddingVertical: 18 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: palette.ink, fontSize: 16, fontWeight: '900' },
  statLabel: { color: palette.muted, fontSize: 11, marginTop: 5 },
  sectionTitle: { color: palette.ink, fontSize: 19, fontWeight: '900', marginTop: 8 },
  settingsRow: { minHeight: 70, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  settingTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  noBorder: { borderBottomWidth: 0 },
  detailRow: { minHeight: 66, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, gap: 20 },
  detailValue: { color: palette.ink, fontSize: 14, fontWeight: '700', textAlign: 'right', flexShrink: 1 },
  settingCard: { backgroundColor: palette.surface, borderRadius: 20, borderWidth: 1, borderColor: palette.border, padding: 18, flexDirection: 'row', alignItems: 'center' },
  dangerButton: { minHeight: 52, borderRadius: 26, borderWidth: 1, borderColor: '#E9BABA', backgroundColor: '#FFF7F7', alignItems: 'center', justifyContent: 'center' },
  dangerText: { color: palette.red, fontSize: 15, fontWeight: '900' },
});
