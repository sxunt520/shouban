import React, { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { getApiBaseUrl } from '../api';
import { Device, Reminder } from '../types';

const beijing = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
function parseTime(text: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text.trim())) throw new Error('时间格式：YYYY-MM-DD HH:mm:ss');
  const iso = `${text.trim().replace(' ', 'T')}${text.trim().length === 16 ? ':00' : ''}+08:00`;
  const d = new Date(iso); if (!Number.isFinite(d.getTime()) || beijing(d.toISOString()).slice(0, text.trim().length) !== text.trim()) throw new Error('请输入有效的北京时间');
  return d.toISOString();
}
const statusLabels: Record<string, string> = { pending: '等待设备执行', dispatched: '正在处理，等待播放完成', succeeded: '播放完成', failed: '播放失败', cancelled: '本次播放已取消', expired: '等待执行超时', skipped: '本次未执行' };
export function R1mRemindersPanel({ token, device, reminders, onChanged }: { token: string; device: Device; reminders: Reminder[]; onChanged: () => Promise<void> }) {
  const [title, setTitle] = useState('喝水休息一下'), [time, setTime] = useState(beijing(new Date(Date.now() + 60000).toISOString()));
  const [repeat, setRepeat] = useState<'none' | 'daily'>('none'), [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function request(path: string, method: string, body?: unknown) {
    const r = await fetch(`${getApiBaseUrl()}/reminders${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json(); if (!r.ok) throw new Error(data.message || '提醒操作失败'); return data;
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError(''); try { await fn(); await onChanged(); } catch (e) { setError(e instanceof Error ? e.message : '提醒操作失败'); } finally { setBusy(false); }
  }
  const button = (label: string, onPress: () => void, selected = false, accessibilityLabel = label) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={busy} onPress={onPress} style={{ padding: 12, margin: 4, borderRadius: 10, backgroundColor: selected ? '#809c32' : '#edf0e5' }}><Text style={{ color: selected ? 'white' : '#333' }}>{label}</Text></Pressable>;
  function edit(r: Reminder) {
    setEditing(r.id); setTitle(r.title); setRepeat(r.repeat); setError('');
    setTime(beijing(new Date(r.scheduledAt).getTime() > Date.now() ? r.scheduledAt : new Date(Date.now() + 60000).toISOString()));
  }
  const rows = reminders.filter(r => r.deviceId === device.id);
  return <View>
    <View style={{ padding: 20, borderRadius: 20, backgroundColor: 'white', marginVertical: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>{editing ? '编辑云端提醒' : '创建云端提醒'}</Text>
      <Text style={{ marginVertical: 10 }}>设备：{device.name}。到点未连接、忙碌或已过期时不补播。</Text>
      <Text>提醒内容</Text><TextInput accessibilityLabel="云端提醒内容" maxLength={80} value={title} onChangeText={setTitle} style={{ borderWidth: 1, borderColor: '#ccc', padding: 12, borderRadius: 10, marginVertical: 8 }} />
      <Text>北京时间（YYYY-MM-DD HH:mm:ss）</Text><TextInput accessibilityLabel="云端提醒时间" value={time} onChangeText={setTime} autoCapitalize="none" style={{ borderWidth: 1, borderColor: '#ccc', padding: 12, borderRadius: 10, marginVertical: 8 }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{[15, 60, 300].map(seconds => button(seconds < 60 ? '15秒后' : `${seconds / 60}分钟后`, () => setTime(beijing(new Date(Date.now() + seconds * 1000).toISOString()))))}</View>
      <View style={{ flexDirection: 'row' }}>{button('仅一次', () => setRepeat('none'), repeat === 'none')}{button('每天', () => setRepeat('daily'), repeat === 'daily')}</View>
      {button(editing ? '保存修改' : '保存云端提醒', () => void action(async () => {
        const scheduledAt = parseTime(time); if (!title.trim()) throw new Error('请输入提醒内容');
        const body = { title: title.trim(), scheduledAt, repeat, enabled: true };
        if (editing) await request(`/${editing}`, 'PATCH', body); else await request('', 'POST', { deviceId: device.id, kind: 'reminder', title: body.title, scheduledAt, repeat });
        setEditing(null); setTime(beijing(new Date(Date.now() + 60000).toISOString()));
      }), true)}
      {editing ? button('取消编辑', () => setEditing(null)) : null}
      {error ? <Text style={{ color: '#b42318', marginTop: 10 }}>{error}</Text> : null}
    </View>
    <Text style={{ fontSize: 20, fontWeight: '700', marginVertical: 12 }}>提醒列表 · {rows.length} 条</Text>
    {rows.length === 0 ? <Text>还没有云端提醒</Text> : rows.map(r => <View key={r.id} style={{ padding: 20, borderRadius: 20, backgroundColor: 'white', marginBottom: 12 }}>
      <Text style={{ fontWeight: '700', fontSize: 18 }}>{r.title}</Text>
      <Text style={{ marginVertical: 8 }}>{beijing(r.scheduledAt)} · {r.repeat === 'daily' ? '每天' : '单次'} · {r.enabled ? '已启用' : '已关闭'}</Text>
      {r.execution ? <Text accessibilityLiveRegion="polite">最近一次：{statusLabels[r.execution.status] || r.execution.status}{r.execution.message ? ` · ${r.execution.message}` : ''}</Text> : null}
      {!r.enabled && r.execution && ['pending', 'dispatched'].includes(r.execution.status) ? button('停止本次播放', () => void action(() => request(`/${r.id}`, 'PATCH', { enabled: false }))) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {button('编辑', () => edit(r), false, `编辑 ${r.title}`)}
        {button(r.enabled ? '暂停' : new Date(r.scheduledAt).getTime() <= Date.now() ? '重新设置' : '启用', () => { if (!r.enabled && new Date(r.scheduledAt).getTime() <= Date.now()) edit(r); else void action(() => request(`/${r.id}`, 'PATCH', { enabled: !r.enabled })); }, false, `${r.enabled ? '暂停' : '启用'} ${r.title}`)}
        {button('删除', () => Alert.alert('删除提醒', `删除“${r.title}”并取消未完成的播放？`, [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => void action(async () => { await request(`/${r.id}`, 'DELETE'); if (editing === r.id) setEditing(null); }) }] ), false, `删除 ${r.title}`)}
      </View>
    </View>)}
  </View>;
}
