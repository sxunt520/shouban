import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || !value) {
    throw new Error('参数格式必须为 --名称 值');
  }
  values.set(key.slice(2), value);
}

function required(argumentName, environmentName) {
  const value = values.get(argumentName) ?? process.env[environmentName];
  if (!value?.trim()) {
    throw new Error(`缺少 --${argumentName}（或环境变量 ${environmentName}）`);
  }
  return value.trim();
}

const hardwareId = required('hardware-id', 'DEVICE_HARDWARE_ID');
const name = required('name', 'DEVICE_BLE_NAME');
const pop = required('pop', 'DEVICE_PROVISIONING_POP');
const pairingCode = required('pairing-code', 'DEVICE_PAIRING_CODE').toUpperCase();
const defaultDirectory = path.resolve(process.cwd(), '../../.data/device-qrcodes');
const output = path.resolve(
  values.get('output') ?? path.join(defaultDirectory, `${hardwareId}.png`),
);

if (!/^[A-Za-z0-9._:-]{3,100}$/.test(hardwareId)) {
  throw new Error('hardware-id 格式无效');
}
if (!/^(YZAI_|PROV_)[A-Za-z0-9_-]+$/.test(name)) {
  throw new Error('name 必须是 YZAI_ 或 PROV_ 开头的 BLE 广播名');
}
if (!/^[A-Z0-9-]{6,64}$/.test(pairingCode)) {
  throw new Error('pairing-code 只能包含大写字母、数字和连字符');
}

const payload = {
  ver: 'v1',
  name,
  pop,
  transport: 'ble',
  security: 1,
  hardwareId,
  pairingCode,
};
const rawPayload = JSON.stringify(payload);
const metadataOutput = output.replace(/\.[^.]+$/, '') + '.json';

await mkdir(path.dirname(output), { recursive: true });
await QRCode.toFile(output, rawPayload, {
  type: 'png',
  errorCorrectionLevel: 'H',
  margin: 4,
  width: 1024,
  color: { dark: '#111111', light: '#FFFFFF' },
});
await writeFile(metadataOutput, `${JSON.stringify(payload, null, 2)}\n`, {
  mode: 0o600,
});

console.log(`设备二维码已生成：${output}`);
console.log(`设备登记信息已生成：${metadataOutput}`);
