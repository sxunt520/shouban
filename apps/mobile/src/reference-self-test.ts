import * as FileSystem from 'expo-file-system';
import { PartnerProvisioningClient, encodeWifi } from './partner-provisioning';
import { API_BASE_URL } from './api';

// Explicit opt-in: an ignored file placed in the debug app's private files directory.
// No production fallback, invented devices, or automatic success states.
export async function referenceSelfTest(token: string, onTrace: (lines: string[]) => void, onBound: (id: string) => Promise<void>) {
  if (!__DEV__ || !FileSystem.documentDirectory) return;
  const path = `${FileSystem.documentDirectory}partner-test.json`;
  if (!(await FileSystem.getInfoAsync(path)).exists) return;
  const config = JSON.parse(await FileSystem.readAsStringAsync(path)) as { ssid: string; password: string; externalDeviceId: string; pairingCode: string; testFailure?: boolean };
  await FileSystem.deleteAsync(path);
  const lines: string[] = [];
  const trace = (line: string) => { lines.push(line); onTrace([...lines]); console.info(`[REFERENCE_TEST] ${line}`); };
  const client = new PartnerProvisioningClient(20);
  const request = async (route: string, method: string, body?: unknown) => {
    const response = await fetch(`${API_BASE_URL}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(`API ${route} (${response.status})`);
    return data;
  };
  try {
    const expected = config.externalDeviceId;
    trace('开始 Android 真机 BLE 联调');
    const bytes = encodeWifi('中文网络', '');
    if (JSON.parse(bytes.toString()).password !== '') throw new Error('开放网络 UTF-8 编码失败');
    const found = await client.discover();
    const device = found.find(d => d.externalDeviceId === expected);
    if (!device) throw new Error('未发现目标 ZAOC_ 参考底座');
    trace('通过名称和厂商 MAC 发现目标底座');
    await client.connect(device); trace('FF00 服务、FF01/FF03 通知订阅通过');
    const networks = await client.scanWifi();
    if (!networks.length) throw new Error('底座未返回 Wi-Fi 扫描通知');
    trace(`收到并去重 ${networks.length} 个 Wi-Fi 名称`);
    if (config.testFailure) {
      let rejected = false;
      try { await client.provision(config.ssid, 'deliberately-wrong-reference-password'); }
      catch (error) { if (error instanceof Error && /失败或超时/.test(error.message)) rejected = true; else throw error; }
      if (!rejected) throw new Error('错误密码未被设备拒绝');
      trace('错误密码收到 status=0；保留连接原地重试');
    }
    await client.provision(config.ssid, config.password); trace('20 字节分包提交正确凭据，收到 status=1；Wi-Fi 已确认');
    await client.disconnect();
    const body = { pairingCode: config.pairingCode, externalDeviceId: expected };
    let online = false;
    for (let i = 0; i < 35; i++) {
      if ((await request('/devices/claim-status', 'POST', body)).online) { online = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    if (!online) throw new Error('Wi-Fi 成功后未确认云端在线');
    trace('设备重启、启动配置鉴权及 MQTT 上线通过');
    const bound = await request('/devices/bind', 'POST', body); trace('账号认领成功，内部设备 ID 已返回');
    await request(`/devices/${bound.id}/volume`, 'PATCH', { volume: 73 });
    let succeeded = false;
    for (let i = 0; i < 25; i++) {
      const state = await request(`/devices/${bound.id}`, 'GET');
      if (state.volumeCommand?.status === 'succeeded' && state.volume === 73) { succeeded = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!succeeded) throw new Error('真实底座未确认音量命令');
    trace('APP → API → MQTT → 开发板 NVS → ACK：音量 73% 通过');
    await onBound(bound.id); trace('PASS：本轮 Android 真机闭环完成');
  } catch (error) {
    trace(`FAIL：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    await client.dispose();
    await FileSystem.writeAsStringAsync(`${FileSystem.documentDirectory}partner-test-result.json`, JSON.stringify({ lines, at: new Date().toISOString() }));
  }
}
