import { requireNativeModule } from 'expo-modules-core';
import { PermissionsAndroid, Platform } from 'react-native';

export type ProvisioningDescriptor = {
  ver: 'v1';
  name: string;
  pop: string;
  transport: 'ble';
  security: 0 | 1 | 2;
  hardwareId?: string;
  pairingCode?: string;
};

export type ProvisioningDevice = {
  id: string;
  name: string;
  rssi: number;
  serviceUuid: string;
};

export type ProvisioningWifi = {
  ssid: string;
  rssi: number;
  security: number;
};

export type ProvisioningEnvironment = {
  networkConnected: boolean;
  networkType: 'wifi' | 'cellular' | 'ethernet' | 'other' | 'none';
  wifiEnabled: boolean;
  bluetoothEnabled: boolean;
  bluetoothPermission: boolean;
  locationRequired: boolean;
  locationEnabled: boolean;
  locationPermission: boolean;
};

type NativeProvisioningModule = {
  getEnvironmentStatus(): Promise<ProvisioningEnvironment>;
  openSystemSettings(section: 'network' | 'bluetooth' | 'location' | 'app'): Promise<void>;
  scanDevices(prefix: string): Promise<ProvisioningDevice[]>;
  stopScan(): Promise<void>;
  connect(deviceId: string, pop: string, security: number): Promise<{ connected: boolean }>;
  scanWifiNetworks(): Promise<ProvisioningWifi[]>;
  provision(ssid: string, password: string, apiBaseUrl: string): Promise<{ success: boolean; ssid: string }>;
  disconnect(): Promise<void>;
};

const nativeProvisioning: NativeProvisioningModule | null =
  Platform.OS === 'android' || Platform.OS === 'ios'
    ? requireNativeModule<NativeProvisioningModule>('YuzhouProvisioning')
    : null;

// Development boards use one shared PoP for now. Production units should print a
// unique PoP in each bottom QR code and never embed it as a global APP constant.
export const DEVELOPMENT_DESCRIPTOR: ProvisioningDescriptor = {
  ver: 'v1',
  name: 'YZAI_',
  pop: 'yuzhou-6055',
  transport: 'ble',
  security: 1,
  hardwareId: 'ESP32S3-DEMO-001',
  pairingCode: 'FIGURE-0001',
};

export function parseProvisioningQr(rawValue: string): ProvisioningDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    throw new Error('这不是屿宙智能底座二维码');
  }

  if (!value || typeof value !== 'object') {
    throw new Error('二维码内容不完整');
  }
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const pop = typeof candidate.pop === 'string' ? candidate.pop : '';
  const transport = candidate.transport;
  const security = candidate.security === undefined ? 1 : Number(candidate.security);
  const hardwareId = typeof candidate.hardwareId === 'string'
    ? candidate.hardwareId.trim()
    : undefined;
  const pairingCode = typeof candidate.pairingCode === 'string'
    ? candidate.pairingCode.trim().toUpperCase()
    : undefined;

  if (candidate.ver !== 'v1' || !name || !pop || transport !== 'ble') {
    throw new Error('二维码不是支持的屿宙智能底座格式');
  }
  if (!name.startsWith('YZAI_') && !name.startsWith('PROV_')) {
    throw new Error('二维码中的设备名称无效');
  }
  if (security !== 0 && security !== 1 && security !== 2) {
    throw new Error('二维码安全版本不受支持');
  }
  if (!pairingCode) {
    throw new Error('二维码缺少设备认领码');
  }
  if (hardwareId && !/^[A-Za-z0-9._:-]{3,100}$/.test(hardwareId)) {
    throw new Error('二维码中的硬件编号无效');
  }
  if (!/^[A-Z0-9-]{6,64}$/.test(pairingCode)) {
    throw new Error('二维码中的设备认领码无效');
  }

  return {
    ver: 'v1',
    name,
    pop,
    transport: 'ble',
    security,
    hardwareId,
    pairingCode,
  };
}

export async function requestProvisioningPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;

  const apiLevel = Number(Platform.Version);
  const permissions = apiLevel >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(permissions);
  const denied = permissions.some((permission) => result[permission] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied) throw new Error('需要蓝牙权限才能发现并配置智能底座');
}

function getNativeProvisioning(): NativeProvisioningModule {
  if (!nativeProvisioning) throw new Error('当前平台不支持蓝牙配网');
  return nativeProvisioning;
}

export const provisioning = {
  getEnvironmentStatus: () => getNativeProvisioning().getEnvironmentStatus(),
  openSystemSettings: (section: 'network' | 'bluetooth' | 'location' | 'app') =>
    getNativeProvisioning().openSystemSettings(section),
  scanDevices: (prefix: string) => getNativeProvisioning().scanDevices(prefix),
  stopScan: () => getNativeProvisioning().stopScan(),
  connect: (deviceId: string, pop: string, security: number) =>
    getNativeProvisioning().connect(deviceId, pop, security),
  scanWifiNetworks: () => getNativeProvisioning().scanWifiNetworks(),
  provision: (ssid: string, password: string, apiBaseUrl: string) =>
    getNativeProvisioning().provision(ssid, password, apiBaseUrl),
  disconnect: () => getNativeProvisioning().disconnect(),
};
