# R1M 独立参考设备模拟器

模拟器作为设备连接云端，模拟音量、定位、NFC 与 Opus 收发。播放完成用“完整解码并保存 WAV”代替真实扬声器，因此硬件播放验收要由合作方固件另外完成。

## 环境与一键验收

需要 Node.js 20 或更新版本、npm、可用 MySQL。MySQL 账号须能创建/删除随机 `*_mqtt_test` 数据库；测试结束清理其自行创建的库。设备仿真还会创建独立 `*_mqtt_dev` 库。Opus / ffmpeg 原生依赖须在目标机器安装成功。

在交付包或仓库根目录执行：

```bash
npm ci
cp config/mqtt-local.env.example .env.mqtt.local
```

编辑 `.env.mqtt.local` 中的 MySQL 地址和账号；保留开发数据库后缀。自动契约测试使用 ASR / AI / TTS 测试替身，不需要购买或配置提供商服务：

```bash
npm run accept:partner
```

报告在 `.data/partner-acceptance/<UTC时间>/report.md` 和 `report.json`，日志仅在本地。命令返回 0 表示全部本地检查通过；报告中的真实 BLE / NFC / 4G / iOS 等仍为 not_run。可与开发服务同时运行，测试使用随机数据库和端口，勿同时运行多个验收或另一个构建任务。

## 运行常驻设备

```bash
npm run dev:partner -- --r1m
```

该命令自动编译 API，启动本地 Broker、API、WS 和 MQTT 两种模拟底座。首次运行会在 `.data/r1m-devices.json` 生成每设备私有开发身份与认领码；只在本地查看填写 APP，不复制他人的文件，也不提交 Git。默认 API 为 `127.0.0.1:3000`、Broker 为 `127.0.0.1:18883`，Broker 默认只允许本机。

实际 ASR / AI / TTS 演示需要接收方自行配置提供商。启动 `npm run dev:partner -- --voice --r1m` 可读取根 `.env` 中的提供商配置，数据库仍来自隔离 `.env.mqtt.local`。包内不含真实提供商密钥。

APP 将 `apps/mobile/.env.example` 复制为 `.env` 并填写电脑局域网 API 地址，启动 `npm run dev:mobile`。BLE 需要原生开发客户端，Expo Go 不具备该原生模块；iOS 在支持的 Mac/Xcode 环境构建。已有 Android 开发客户端可通过 USB `adb reverse tcp:3000 tcp:3000` 与实际 Metro 端口反向转发调试。

在 APP “添加合作方底座”选择“4G / 已联网直接认领”，填写本机生成的 STA MAC 与认领码，选择角色后即可调试音量、定位、主动播报、提醒、NFC。此模式是跳过 BLE 的云端认领，不代表已经用真实 4G 网络。

## 单次音频输入

输入必须为 16kHz、单声道、PCM16 WAV，时长 0.1–10 秒。默认常驻模拟器与单次进程通过设备语音租约协调，单次进程结束后常驻进程自动恢复会话：

```bash
npm run simulate:r1m -- --device=R1M-WS-SIM --wav=/absolute/path/input.wav
npm run simulate:r1m-mqtt -- --wav=/absolute/path/input.wav
```

设备默认读取本机 `.data/r1m-devices.json`；可使用环境变量 `R1M_FIXTURES_PATH` 指定本机独立测试登记文件，`R1M_API_BASE` 指定 API。跨电脑运行还需云端返回设备可达的 WS / MQTT / UDP 地址，并按网络环境部署 Broker；仅修改 API 地址不能自动让 loopback Broker 对远端可达。

回复 WAV、状态、去重记录分别在 `.data/r1m-simulator/` 和 `.data/r1m-mqtt-simulator/`。停止服务后才能清理这些状态，否则会影响去重或设备语音租约。

## 代码入口与协议差异

| 文件 | 内容 |
| --- | --- |
| `src/r1m.mjs` | WebSocket v1 裸 Opus、custom、NFC、指令去重与完成回执 |
| `src/r1m-mqtt.mjs` | HMAC 激活、真实 MQTT、独立 UDP HKDF/AES-CTR/HMAC 实现 |
| `src/broker.mjs` | 本地 Broker，设备 ACL 与可信在线证据 |
| `test/r1m.test.mjs` | WS、HTTP 旁路、角色与会话隔离 |
| `test/r1m-mqtt.test.mjs` | MQTT/UDP、激活、回执、提醒、NFC 与跨设备隔离 |

`src/main.mjs`、`src/voice.mjs` 是早期 MQTT/参考语音协议的兼容回归工具；合作方 R1M 从 `r1m*.mjs` 开始，不能混用 `reference.*` 消息或参考 UDP 格式。

当前 UDP 采用我方提案 `company-udp-ctr-hmac-v1`，包含 HMAC tag。合作方已有无 tag 格式不能直接互通；请先校准 [公开向量](../../config/r1m-proposal-vectors.json) 和 [对接入口](../../docs/partner-handoff.md)。固定向量密钥是公开测试值，禁止作为设备运行密钥。
