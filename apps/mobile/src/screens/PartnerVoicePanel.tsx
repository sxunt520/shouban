import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { getApiBaseUrl } from '../api';
import { Character, Device } from '../types';

type State = { state: string; sessionId?: string; receivedFrames?: number; sentFrames?: number; transcript?: string; reply?: string; error?: string; audioReady?: boolean };
const labels: Record<string, string> = { idle: '待开始', ready: '通道已建立', listening: '接收录音', processing: '识别与生成回复', speaking: '发送回复音频', completed: '回复发送完成', aborted: '已打断', error: '失败' };
export function PartnerVoicePanel({ token, device, characters, onChanged }: { token: string; device: Device; characters: Character[]; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<State>({ state: 'idle' });
  const [text, setText] = useState('你好，请简单介绍一下自己。');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), sound = useRef<Audio.Sound | null>(null), playback = useRef(0);
  const base = () => `${getApiBaseUrl()}/devices/${device.id}/voice`;
  const headers = { Authorization: `Bearer ${token}` };
  async function request(url: string, method = 'GET', body?: unknown) {
    const r = await fetch(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json();
    if (!r.ok) throw new Error(Array.isArray(data.message) ? data.message.join('；') : data.message || '语音请求失败');
    return data;
  }
  useEffect(() => {
    alive.current = true; let fetching = false;
    const refresh = async () => {
      if (fetching) return; fetching = true;
      try { const next = await request(base()); if (alive.current) setState(next); }
      catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '读取语音状态失败'); }
      finally { fetching = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1500);
    return () => { alive.current = false; clearInterval(timer); playback.current++; void sound.current?.unloadAsync(); sound.current = null; };
  }, [device.id, token]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '语音操作失败'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function stopPreview() { playback.current++; const old = sound.current; sound.current = null; if (old) await old.unloadAsync(); }
  async function upload() {
    const selected = await DocumentPicker.getDocumentAsync({ type: ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'], copyToCacheDirectory: true });
    if (selected.canceled) return;
    const asset = selected.assets[0];
    if (asset.size && asset.size > 400000) throw new Error('请选择最长 10 秒的 16kHz 单声道 PCM16 WAV');
    await stopPreview();
    const r = await FileSystem.uploadAsync(`${base()}/test-audio`, asset.uri, { httpMethod: 'POST', uploadType: FileSystem.FileSystemUploadType.MULTIPART, fieldName: 'file', mimeType: 'audio/wav', headers });
    const data = JSON.parse(r.body);
    if (r.status < 200 || r.status >= 300) throw new Error(data.message || '上传录音失败');
    if (alive.current) setState({ state: 'ready' });
  }
  async function preview() {
    await stopPreview(); const generation = playback.current;
    if (!state.sessionId) return;
    await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
    const created = await Audio.Sound.createAsync({ uri: `${base()}/audio/${state.sessionId}`, headers }, { shouldPlay: false });
    if (!alive.current || playback.current !== generation) { await created.sound.unloadAsync(); return; }
    sound.current = created.sound; await created.sound.playAsync();
  }
  const button = (label: string, action: () => Promise<void>, disabled = false) => <Pressable disabled={disabled || busy} onPress={() => void run(action)} style={{ padding: 12, backgroundColor: disabled || busy ? '#e6e6e6' : '#e7edce', borderRadius: 10, marginTop: 8 }}><Text>{label}</Text></Pressable>;
  return <View style={{ padding: 20, backgroundColor: 'white', borderRadius: 20, marginVertical: 12 }}>
    <Text style={{ fontWeight: 'bold', fontSize: 20 }}>参考语音联调</Text>
    <Text style={{ marginVertical: 10 }}>选择模拟底座的角色，使用文本或 WAV 文件测试回复。</Text>
    <Text>当前角色：{device.character?.name || '尚未选择'}</Text>
    {characters.map(c => <Pressable key={c.id} disabled={busy} onPress={() => void run(async () => {
      await stopPreview(); await request(`${getApiBaseUrl()}/devices/${device.id}/character`, 'PATCH', { characterId: c.id }); await onChanged();
    })} style={{ paddingVertical: 8 }}><Text>{device.characterId === c.id ? '●' : '○'} {c.name}</Text></Pressable>)}
    <TextInput value={text} onChangeText={setText} multiline maxLength={500} placeholder="输入调试文本" style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12 }} />
    {button('发送调试文本', async () => { await stopPreview(); await request(`${base()}/test-text`, 'POST', { text }); setState({ state: 'ready' }); }, !device.characterId || device.status !== 'online')}
    {button('选择 WAV 录音测试', upload, !device.characterId || device.status !== 'online')}
    <Text style={{ marginVertical: 10 }}>录音：16kHz · 单声道 · PCM16 · 最长 10 秒</Text>
    <Text>状态：{labels[state.state] || state.state}</Text>
    <Text>录音接收 {state.receivedFrames || 0} 帧 · 回复发送 {state.sentFrames || 0} 帧</Text>
    {state.transcript ? <Text style={{ marginTop: 8 }}>识别 / 输入：{state.transcript}</Text> : null}
    {state.reply ? <Text style={{ marginTop: 8 }}>回复：{state.reply}</Text> : null}
    {state.error || error ? <Text style={{ color: '#b52d2d', marginTop: 8 }}>{error || state.error}</Text> : null}
    {button('试听本轮回复', preview, !state.audioReady)}
    <Pressable onPress={() => void run(async () => { await stopPreview(); await request(`${base()}/abort`, 'POST'); setState({ state: 'aborted' }); })} style={{ padding: 12, marginTop: 8 }}><Text>打断本轮回复</Text></Pressable>
  </View>;
}
