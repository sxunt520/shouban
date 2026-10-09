import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { PartnerCandidate, PartnerProvisioningClient } from '../partner-provisioning';
import { API_BASE_URL } from '../api';
import { palette } from '../theme';

async function partnerApi(token: string, path: string, body: unknown) {
  const response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join('；') : data.message || '云端请求失败');
  return data;
}

export function PartnerSetup({ token, onClose, onBound }: { token: string; onClose: () => void; onBound: (id: string) => Promise<void> }) {
  const client = useRef<PartnerProvisioningClient>();
  const alive = useRef(true);
  const [mode, setMode] = useState<'wifi' | 'cellular'>('wifi');
  const [devices, setDevices] = useState<PartnerCandidate[]>([]);
  const [selected, setSelected] = useState<PartnerCandidate>();
  const [networks, setNetworks] = useState<string[]>([]);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [identity, setIdentity] = useState('');
  const [busy, setBusy] = useState(false);
  const [wifiReady, setWifiReady] = useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const [bound, setBound] = useState(false);
  const [notice, setNotice] = useState('长按底座 BOOT 进入配网，广播名称应以 ZAOC_ 开头。');
  const [error, setError] = useState('');
  useEffect(() => { alive.current = true; client.current = new PartnerProvisioningClient(); return () => { alive.current = false; void client.current?.dispose(); }; }, []);
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : '操作失败'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function choose(device: PartnerCandidate) {
    setSelected(undefined); setSsid(''); setPassword(''); setNetworks([]);
    setWifiReady(false); setCloudReady(false); setBound(false);
    await client.current!.connect(device);
    if (!alive.current) return;
    setSelected(device); setIdentity(device.externalDeviceId || ''); setNetworks([]); setWifiReady(false); setCloudReady(false); setBound(false);
    setNotice('蓝牙已连接，正在收集 Wi-Fi 名称；也可以手动填写。');
    const found = await client.current!.scanWifi(name => { if (alive.current) setNetworks(old => old.includes(name) ? old : [...old, name]); });
    if (!alive.current) return;
    setNetworks(found); setNotice('只返回网络名称，不包含频段或安全方式；请选择可用的 2.4GHz 网络。');
  }
  async function claim() {
    const body = { pairingCode: pairingCode.trim().toUpperCase(), externalDeviceId: identity.replaceAll(':', '').toLowerCase() };
    if (!body.pairingCode || !/^[a-f0-9]{12}$/.test(body.externalDeviceId)) throw new Error('请填写底座认领码和完整 Wi-Fi STA MAC');
    setNotice(mode === 'cellular' ? '正在确认底座云端连接并认领…' : 'Wi-Fi 已成功，正在等待底座连接云端…');
    const deadline = Date.now() + 45000;
    while (alive.current && Date.now() < deadline) {
      const state = await partnerApi(token, '/devices/claim-status', body);
      if (!alive.current) return;
      if (state.claimedByOther) throw new Error('该底座已经绑定其他账号');
      if (state.online) {
        setCloudReady(true);
        const device = await partnerApi(token, '/devices/bind', body);
        setBound(true); setPassword(''); setPairingCode(''); setNotice(mode === 'cellular' ? '云端连接、账号绑定均已确认。' : 'Wi-Fi、云端连接、账号绑定均已确认。');
        await onBound(device.id); return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    if (alive.current) throw new Error('底座云端控制通道尚未连接。请检查设备网络和 OTA 配置，然后重试认领。');
  }
  const button = (label: string, action: () => void, disabled = busy) => <Pressable disabled={disabled} onPress={action} style={{ padding: 14, borderRadius: 12, backgroundColor: disabled ? palette.border : palette.primary, marginVertical: 7 }}><Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>{label}</Text></Pressable>;
  const inputStyle = { borderWidth: 1, borderColor: palette.border, borderRadius: 10, padding: 12, marginVertical: 7 };
  return <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 45, gap: 10 }} keyboardShouldPersistTaps="handled">
    <Text style={{ fontSize: 24, fontWeight: '800', color: palette.ink }}>底座联网与认领</Text>
    <View style={{ flexDirection: 'row', gap: 12 }}>
      {button('Wi-Fi 配网', () => { setMode('wifi'); setWifiReady(false); setSelected(undefined); setCloudReady(false); setBound(false); setNotice('长按底座 BOOT 进入配网。'); })}
      {button('4G / 已联网直接认领', () => { setMode('cellular'); setWifiReady(false); setSelected(undefined); setIdentity(''); setCloudReady(false); setBound(false); void client.current?.disconnect(); setNotice('无需蓝牙配网，填写底座二维码上的 STA MAC 与认领码。'); })}
    </View>
    <Text>{notice}</Text>
    <Text>Wi-Fi：{mode === 'cellular' ? '无需配置' : wifiReady ? '已确认' : '未确认'}　云端：{cloudReady ? '已在线' : '未确认'}　绑定：{bound ? '已完成' : '未完成'}</Text>
    {busy ? <ActivityIndicator color={palette.primary} /> : null}
    {error ? <Text style={{ color: '#B42318' }}>{error}</Text> : null}
    {mode === 'wifi' && !wifiReady ? button('搜索 ZAOC_ 底座', () => void run(async () => { setDevices(await client.current!.discover()); setNotice('搜索完成，选择下方底座；无结果可重新搜索。'); })) : null}
    {mode === 'wifi' && !wifiReady ? devices.map(device => <Pressable key={device.id} disabled={busy} onPress={() => void run(() => choose(device))} style={inputStyle}><Text>{selected?.id === device.id ? '● ' : '○ '}{device.name}</Text></Pressable>) : null}
    {mode === 'wifi' && selected ? <View>
      <Text>当前底座：{selected.name}</Text>
      {!wifiReady ? <>
        {networks.map(name => <Pressable key={name} disabled={busy} onPress={() => setSsid(name)} style={inputStyle}><Text>{ssid === name ? '● ' : '○ '}{name}</Text></Pressable>)}
        <TextInput accessibilityLabel="Wi-Fi 名称" style={inputStyle} placeholder="Wi-Fi 名称（可手填）" value={ssid} onChangeText={setSsid} autoCapitalize="none" />
        <TextInput accessibilityLabel="Wi-Fi 密码" style={inputStyle} placeholder="Wi-Fi 密码，开放网络留空" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
      </> : null}
      <TextInput accessibilityLabel="底座认领码" style={inputStyle} placeholder="底座认领码" value={pairingCode} onChangeText={setPairingCode} autoCapitalize="characters" />
      {!selected.externalDeviceId ? <TextInput style={inputStyle} placeholder="完整 Wi-Fi STA MAC（不是手机 BLE ID）" value={identity} onChangeText={setIdentity} autoCapitalize="none" /> : null}
      {!bound ? button(wifiReady ? '重试云端确认和绑定' : '配置 Wi-Fi 并确认绑定', () => void run(async () => {
        if (!pairingCode.trim()) throw new Error('请先填写底座认领码');
        if (!wifiReady) { await client.current!.provision(ssid, password); if (!alive.current) return; setWifiReady(true); await client.current!.disconnect(); }
        await claim();
      }), busy || (!wifiReady && !ssid)) : null}
    </View> : null}
    {mode === 'cellular' ? <View>
      <TextInput accessibilityLabel="底座 STA MAC" style={inputStyle} placeholder="底座 STA MAC，例如 02:00:00:00:00:03" value={identity} onChangeText={setIdentity} autoCapitalize="none" />
      <TextInput accessibilityLabel="底座认领码" style={inputStyle} placeholder="底座认领码" value={pairingCode} onChangeText={setPairingCode} autoCapitalize="characters" />
      {!bound ? button('确认云端并认领', () => void run(claim), busy || !identity.trim() || !pairingCode.trim()) : null}
    </View> : null}
    {button(bound ? '完成，返回设备' : '返回设备', onClose, false)}
  </ScrollView>;
}
