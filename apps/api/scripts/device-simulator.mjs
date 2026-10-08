const apiBaseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000/v1';
const hardwareId = process.env.HARDWARE_ID ?? 'ESP32S3-DEMO-001';
const deviceSecret = process.env.DEVICE_SECRET ?? 'figure-dev-secret-001';

async function request(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const session = await request('/device/session', {
  method: 'POST',
  body: JSON.stringify({ hardwareId, deviceSecret }),
});
const token = session.accessToken;
console.log(`模拟设备已启动，屏幕绑定码：${session.device.pairingCode}`);

async function cycle() {
  const headers = { authorization: `Bearer ${token}` };
  const heartbeat = await request('/device/heartbeat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ firmwareVersion: 'simulator-0.1.0', volume: 60 }),
  });
  const commands = await request('/device/commands', { headers });
  if (heartbeat.pendingCommandCount > 0) {
    console.log(`收到 ${commands.length} 条指令`);
  }
  for (const command of commands) {
    console.log(`[${command.type}]`, command.payload);
    await request(`/device/commands/${command.id}/ack`, {
      method: 'POST',
      headers,
      body: '{}',
    });
  }
}

await cycle();
setInterval(() => void cycle().catch(console.error), 3000);
