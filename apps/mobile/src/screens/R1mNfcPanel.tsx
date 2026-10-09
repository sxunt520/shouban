import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { getApiBaseUrl } from '../api';
import { Character, Device } from '../types';
type Binding = { uid: string; characterId: string };
export function R1mNfcPanel({ token, device, characters, onChanged }: { token: string; device: Device; characters: Character[]; onChanged: () => Promise<void> }) {
  const [uid, setUid] = useState(device.nfcState?.uid || '04A1B2C3D4E5F6'), [characterId, setCharacterId] = useState(device.characterId || characters[0]?.id || '');
  const [bindings, setBindings] = useState<Binding[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const path = `/devices/${device.id}`;
  async function request(suffix: string, method = 'GET', body?: unknown) {
    const r = await fetch(`${getApiBaseUrl()}${path}${suffix}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json(); if (!r.ok) throw new Error(data.message || 'NFC 操作失败'); return data;
  }
  useEffect(() => { let alive = true; void request('/nfc-bindings').then(data => { if (alive) setBindings(data); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [device.id, token]);
  useEffect(() => { if (device.nfcState?.uid) setUid(device.nfcState.uid); }, [device.nfcState?.uid]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError(''); try { await fn(); setBindings(await request('/nfc-bindings')); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'NFC 操作失败'); } finally { setBusy(false); }
  }
  const state = device.nfcState, matched = characters.find(c => c.id === state?.characterId);
  const button = (label: string, fn: () => void, selected = false) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={fn} style={{ padding: 12, marginVertical: 4, borderRadius: 10, backgroundColor: selected ? '#809c32' : '#edf0e5' }}><Text style={{ color: selected ? 'white' : '#333' }}>{label}</Text></Pressable>;
  return <View style={{ padding: 20, borderRadius: 20, backgroundColor: 'white', marginVertical: 12 }}>
    <Text style={{ fontSize: 20, fontWeight: '700' }}>NFC 手办识别</Text>
    <Text style={{ marginVertical: 10 }}>{state?.present ? state.matched ? `已识别：${matched?.name || '当前手办'}` : '发现未知标签，请绑定角色' : state?.lastSeenAt ? '手办已取下，保留当前角色' : '等待读卡状态'}</Text>
    {state?.present ? <Text>标签：{state.uid}</Text> : null}
    <Text style={{ marginTop: 10 }}>标签 UID（4、7 或 10 字节十六进制）</Text>
    <TextInput accessibilityLabel="NFC 标签 UID" value={uid} onChangeText={setUid} maxLength={40} autoCapitalize="characters" style={{ borderWidth: 1, borderColor: '#ccc', padding: 12, borderRadius: 10, marginVertical: 8 }} />
    <Text>选择标签对应角色</Text>
    {characters.map(c => button(`${characterId === c.id ? '●' : '○'} 标签角色：${c.name}`, () => setCharacterId(c.id), characterId === c.id))}
    {button('绑定 NFC 标签', () => void action(() => request('/nfc-bindings', 'PUT', { uid, characterId })), true)}
    <Text style={{ marginTop: 12, fontWeight: '700' }}>我的标签绑定</Text>
    {bindings.length ? bindings.map(b => <View key={b.uid} style={{ paddingVertical: 8 }}><Text>{b.uid} → {characters.find(c => c.id === b.characterId)?.name || b.characterId}</Text>{button(`解除绑定 ${b.uid}`, () => void action(() => request(`/nfc-bindings/${encodeURIComponent(b.uid)}`, 'DELETE')))}</View>) : <Text>尚未绑定标签</Text>}
    {device.nfcSimulator ? <View style={{ marginTop: 12 }}><Text style={{ fontWeight: '700' }}>模拟器操作</Text><Text>由模拟设备上报事件，暂未接真实 NFC 读卡器。</Text>{button('模拟放上手办', () => void action(() => request('/simulator/nfc', 'POST', { present: true, uid })))}{button('模拟取下手办', () => void action(() => request('/simulator/nfc', 'POST', { present: false })))}</View> : null}
    {error ? <Text style={{ color: '#b42318', marginTop: 8 }}>{error}</Text> : null}
  </View>;
}
