import { Platform } from 'react-native';
import { Buffer } from 'buffer';
import type { BleManager, Device as BleDevice, Subscription } from 'react-native-ble-plx';
import { provisioning, requestProvisioningPermissions } from './provisioning';

export const PARTNER_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
const SSID = '0000ff01-0000-1000-8000-00805f9b34fb';
const STATUS = '0000ff03-0000-1000-8000-00805f9b34fb';
const CCCD = '00002902-0000-1000-8000-00805f9b34fb';
export type PartnerCandidate = { id: string; name: string; externalDeviceId: string | null; rssi: number | null };

export function encodeWifi(ssid: string, password: string): Buffer {
  const size = Buffer.byteLength(ssid, 'utf8');
  if (!size || size > 32) throw new Error('Wi-Fi 名称需要 1–32 个 UTF-8 字节');
  if (Buffer.byteLength(password, 'utf8') > 64) throw new Error('Wi-Fi 密码过长');
  const bytes = Buffer.from(JSON.stringify({ ssid, password }), 'utf8');
  if (bytes.length > 512) throw new Error('配网数据超过设备缓冲上限');
  return bytes;
}

export class PartnerProvisioningClient {
  constructor(private readonly chunkLimit = 497) {
    if (!Number.isInteger(chunkLimit) || chunkLimit < 1 || chunkLimit > 497) throw new Error('Invalid BLE chunk limit');
  }
  private manager?: BleManager;
  private device?: BleDevice;
  private subscriptions: Subscription[] = [];
  private networks = new Set<string>();
  private onNetwork?: (ssid: string) => void;
  private result?: { resolve: () => void; reject: (error: Error) => void };
  private scanning = false;
  private wifiSucceeded = false;
  private disposed = false;
  private getManager() {
    if (this.disposed) throw new Error('配网连接已关闭');
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') throw new Error('请使用 Android / iOS 真机进行蓝牙配网');
    if (!this.manager) {
      const { BleManager: NativeManager } = require('react-native-ble-plx') as typeof import('react-native-ble-plx');
      this.manager = new NativeManager();
    }
    return this.manager;
  }
  async discover(): Promise<PartnerCandidate[]> {
    await requestProvisioningPermissions();
    if (Platform.OS === 'android' && Number(Platform.Version) <= 30) {
      const environment = await provisioning.getEnvironmentStatus();
      if (!environment.locationEnabled) throw new Error('当前 Android 手机需要开启系统定位服务才能扫描蓝牙底座');
    }
    const manager = this.getManager();
    let state = await manager.state();
    if (state === 'Unknown' || state === 'Resetting') {
      state = await new Promise((resolve, reject) => {
        let subscription: Subscription | undefined;
        const timer = setTimeout(() => { subscription?.remove(); reject(new Error('蓝牙初始化超时，请重试')); }, 10000);
        subscription = manager.onStateChange(next => {
          if (next === 'Unknown' || next === 'Resetting') return;
          clearTimeout(timer); subscription?.remove(); resolve(next);
        }, false);
      });
    }
    if (state === 'Unauthorized') throw new Error(Platform.OS === 'ios'
      ? '请在 iPhone 设置中允许本 APP 使用蓝牙'
      : '请在应用设置中允许蓝牙扫描和连接权限');
    if (state === 'Unsupported') throw new Error('当前设备不支持蓝牙配网');
    if (state !== 'PoweredOn') throw new Error('请开启手机蓝牙并允许 APP 使用蓝牙');
    const found = new Map<string, PartnerCandidate>();
    let scanCount = 0;
    return new Promise((resolve, reject) => {
      const finish = () => { manager.stopDeviceScan(); if (__DEV__) console.info(`[PARTNER_SCAN] received=${scanCount}, candidates=${found.size}`); resolve([...found.values()]); };
      const timer = setTimeout(finish, 8000);
      // The vendor advertises no service UUID. Always scan without a service filter.
      manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) { clearTimeout(timer); manager.stopDeviceScan(); reject(new Error(error.message)); return; }
        scanCount++;
        const name = device?.localName || device?.name || '';
        if (!device || !/^ZAOC_[0-9A-F]{6}$/i.test(name)) return;
        const data = device.manufacturerData ? Buffer.from(device.manufacturerData, 'base64') : null;
        const identity = data && data.length === 8 && data[0] === 0 && data[1] === 1 ? Buffer.from(data.subarray(2)).toString('hex') : null;
        if (__DEV__ && !found.has(device.id)) console.info(`[PARTNER_SCAN] name=${name}, identity=${identity}`);
        found.set(device.id, { id: device.id, name, externalDeviceId: identity, rssi: device.rssi });
      });
    });
  }
  private notified(value: string | null) {
    if (!value) return;
    const text = Buffer.from(value, 'base64').toString('utf8');
    if (this.scanning) {
      if (text.startsWith('FAILED:')) return;
      if (text && !this.networks.has(text)) { this.networks.add(text); this.onNetwork?.(text); }
      return;
    }
    if (!this.result) return;
    if (text.startsWith('FAILED:')) { this.result.reject(new Error('底座拒绝配网请求，请检查输入并重试')); return; }
    try {
      const data = JSON.parse(text);
      if (data.status === '1') { this.wifiSucceeded = true; this.result.resolve(); }
      if (data.status === '0') this.result.reject(new Error('底座连接 Wi-Fi 失败或超时，可直接重试'));
    } catch { /* SUCCESS text alone never confirms Wi-Fi connectivity. */ }
  }
  async connect(candidate: PartnerCandidate) {
    const manager = this.getManager();
    manager.stopDeviceScan();
    await this.disconnect();
    // Allow legacy Android scan bookkeeping to finish before starting GATT.
    if (Platform.OS === 'android' && Number(Platform.Version) <= 30) await new Promise(resolve => setTimeout(resolve, 600));
    this.wifiSucceeded = false;
    let device = await manager.connectToDevice(candidate.id, { timeout: 15000 });
    this.device = device;
    // Older Android stacks can stall MTU negotiation; the protocol supports 20-byte writes.
    if (Platform.OS === 'android' && Number(Platform.Version) >= 31) device = await device.requestMTU(500);
    this.device = await device.discoverAllServicesAndCharacteristics();
    const characteristics = await this.device.characteristicsForService(PARTNER_SERVICE);
    for (const uuid of [SSID, STATUS]) {
      const characteristic = characteristics.find(c => c.uuid.toLowerCase() === uuid);
      if (!characteristic?.isNotifiable) throw new Error('设备缺少 FF01 / FF03 通知能力');
      this.subscriptions.push(this.device.monitorCharacteristicForService(PARTNER_SERVICE, uuid, (error, change) => {
        if (error && !this.wifiSucceeded) this.result?.reject(new Error('蓝牙连接中断，尚未收到 Wi-Fi 成功通知'));
        if (change) this.notified(change.value);
      }));
      if (Platform.OS === 'android') {
        const cccd = await this.device.readDescriptorForService(PARTNER_SERVICE, uuid, CCCD);
        if (!cccd.value || (Buffer.from(cccd.value, 'base64')[0] & 1) === 0) throw new Error('未能启用底座通知，请重新连接');
      }
    }
    // Read is queued behind notification setup on CoreBluetooth; Android checked CCCD explicitly.
    await this.device.readCharacteristicForService(PARTNER_SERVICE, STATUS);
    this.subscriptions.push(manager.onDeviceDisconnected(candidate.id, () => {
      if (!this.wifiSucceeded) this.result?.reject(new Error('底座断开，尚未确认 Wi-Fi 配置成功'));
    }));
  }
  async scanWifi(onNetwork?: (ssid: string) => void): Promise<string[]> {
    if (!this.device) throw new Error('请先连接底座');
    this.scanning = true; this.networks.clear(); this.onNetwork = onNetwork;
    try {
      await this.device.writeCharacteristicWithResponseForService(PARTNER_SERVICE, SSID, Buffer.from('scan').toString('base64'));
      // No scan-complete marker exists in the vendor document; this is a bounded collection window.
      await new Promise(resolve => setTimeout(resolve, 8000));
      return [...this.networks];
    } finally { this.scanning = false; this.onNetwork = undefined; }
  }
  async provision(ssid: string, password: string) {
    if (!this.device || this.result) throw new Error('底座未连接或正在处理配网');
    const device = this.device;
    const bytes = encodeWifi(ssid, password);
    this.wifiSucceeded = false;
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<void>((resolve, reject) => {
      this.result = { resolve, reject };
      timer = setTimeout(() => reject(new Error('未收到设备 Wi-Fi 结果，请重试')), 35000);
    });
    // Attach a handler before writing: errors/notifications can arrive during the write loop.
    const completed = response.then(() => null, error => error as Error);
    try {
      const size = Math.max(1, Math.min(device.mtu - 3, this.chunkLimit));
      for (let offset = 0; offset < bytes.length; offset += size) {
        await device.writeCharacteristicWithResponseForService(PARTNER_SERVICE, SSID, Buffer.from(bytes.subarray(offset, offset + size)).toString('base64'));
      }
      const error = await completed;
      if (error) throw error;
    } finally { clearTimeout(timer!); this.result = undefined; }
  }
  async disconnect() {
    this.result?.reject(new Error('配网已取消'));
    this.result = undefined;
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
    const device = this.device; this.device = undefined;
    if (device) await this.manager?.cancelDeviceConnection(device.id).catch(() => undefined);
  }
  async dispose() { this.manager?.stopDeviceScan(); await this.disconnect(); this.manager?.destroy(); this.disposed = true; }
}
