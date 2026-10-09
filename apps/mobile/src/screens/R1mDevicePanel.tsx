import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { getApiBaseUrl } from '../api';
import { Character, Device } from '../types';

export function deviceConnectionLabel(device: Device) {
  if (device.connectivity) return device.connectivity.controlReachable ? '云端已连接' : device.connectivity.network === 'online' ? '设备在线 · 语音控制通道未打开' : '网络待确认 · 控制通道未打开';
  return device.status === 'online' ? '在线' : '离线';
}
export function R1mDevicePanel({ token, device, characters, onChanged }: { token: string; device: Device; characters: Character[]; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [speechText, setSpeechText] = useState('你好，我是你的手办伙伴，很高兴见到你！');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function choose(id: string) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`${getApiBaseUrl()}/devices/${device.id}/character`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: id }) });
      if (!r.ok) { const data = await r.json(); throw new Error(data.message || '角色设置失败'); }
      await onChanged();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '角色设置失败'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function identify() {
    setBusy(true); setError('');
    try {
      const r = await fetch(`${getApiBaseUrl()}/devices/${device.id}/identify`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { const data = await r.json(); throw new Error(data.message || '定位请求失败'); }
      await onChanged();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '定位请求失败'); }
    finally { if (alive.current) setBusy(false); }
  }
  const locating = device.identifyCommand && ['pending', 'dispatched'].includes(device.identifyCommand.status);
  const speech = device.speechCommand;
  const speaking = !!speech && ['pending', 'dispatched'].includes(speech.status);
  async function playback(stop = false) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`${getApiBaseUrl()}/devices/${device.id}/${stop ? 'playback/stop' : 'speak'}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(stop ? {} : { body: JSON.stringify({ text: speechText.trim() }) }) });
      if (!r.ok) { const data = await r.json(); throw new Error(data.message || '播报请求失败'); }
      await onChanged();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '播报请求失败'); }
    finally { if (alive.current) setBusy(false); }
  }
  const speechPhases: Record<string, string> = { waiting: '等待设备连接', synthesizing: '正在生成语音', streaming: '正在发送音频', playing: '正在播放', awaiting_completion: '音频已发送，等待播放完成' };
  const speechStatus = speech ? speech.status === 'succeeded' ? '播放完成' : speech.status === 'cancelled' ? speech.phase === 'stopped' ? '设备已确认停止' : '播报已取消' : speech.status === 'expired' ? '等待播放回执超时' : speech.status === 'failed' ? '播报失败' : speechPhases[speech.phase] || '等待设备执行' : '';
  const identifyLabels = { pending: '等待设备执行', dispatched: '已发送，等待回执', succeeded: '设备已确认执行', failed: '设备执行失败', expired: '等待回执超时，请重试', cancelled: '请求已取消' };
  return <View style={{ padding: 20, borderRadius: 20, backgroundColor: 'white', marginVertical: 12 }}>
    <Text style={{ fontWeight: '700', fontSize: 20 }}>R1M 底座</Text>
    <Text style={{ marginVertical: 8 }}>{deviceConnectionLabel(device)}</Text>
    <Text>语音：{device.connectivity?.voiceActive ? '正在对话' : '待开始'}</Text>
    <Text style={{ marginTop: 8 }}>角色：{device.character?.name || '尚未选择'}</Text>
    {characters.map(c => <Pressable key={c.id} disabled={busy} onPress={() => void choose(c.id)} style={{ paddingVertical: 10 }}><Text>{device.characterId === c.id ? '●' : '○'} {c.name}</Text></Pressable>)}
    <Pressable accessibilityRole="button" accessibilityLabel="定位底座" disabled={busy || !!locating} onPress={() => void identify()} style={{ padding: 14, borderRadius: 12, backgroundColor: busy || locating ? '#ddd' : '#809c32', marginTop: 12 }}><Text style={{ color: 'white', textAlign: 'center', fontWeight: '700' }}>{locating ? '正在定位…' : '定位底座'}</Text></Pressable>
    <Text style={{ marginTop: 8 }}>让底座闪灯三次。模拟底座会记录执行结果。</Text>
    {device.identifyCommand ? <Text accessibilityLiveRegion="polite" style={{ marginTop: 8 }}>{identifyLabels[device.identifyCommand.status]}{device.identifyCommand.errorMessage ? `：${device.identifyCommand.errorMessage}` : ''}</Text> : null}
    <Text style={{ marginTop: 20, fontWeight: '700', fontSize: 18 }}>让手办说话</Text>
    <Text style={{ marginVertical: 8 }}>使用当前角色的声音。模拟底座会接收并保存音频。</Text>
    <TextInput accessibilityLabel="手办播报内容" value={speechText} onChangeText={setSpeechText} maxLength={500} multiline style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 12, padding: 12, minHeight: 90, textAlignVertical: 'top' }} />
    <Pressable accessibilityRole="button" accessibilityLabel="让手办说" disabled={busy || speaking || !device.characterId || !speechText.trim()} onPress={() => void playback()} style={{ padding: 14, borderRadius: 12, backgroundColor: busy || speaking || !device.characterId || !speechText.trim() ? '#ddd' : '#809c32', marginTop: 12 }}><Text style={{ color: 'white', textAlign: 'center', fontWeight: '700' }}>让手办说</Text></Pressable>
    {speaking ? <Pressable accessibilityRole="button" accessibilityLabel="停止播报" disabled={busy} onPress={() => void playback(true)} style={{ padding: 14 }}><Text style={{ textAlign: 'center', color: '#b42318' }}>停止播报</Text></Pressable> : null}
    {speech ? <Text accessibilityLiveRegion="polite" style={{ marginTop: 8 }}>{speechStatus}{speech.errorMessage ? `：${speech.errorMessage}` : ''}</Text> : null}
    {error ? <Text style={{ color: '#b42318' }}>{error}</Text> : null}
  </View>;
}
