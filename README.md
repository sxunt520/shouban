# 屿宙AI手办 MVP

这是「屿宙AI手办」软硬件联调版本，包含：

- `apps/api`：NestJS 10 后端
- `apps/mobile`：Expo SDK 51 / React Native APP
- `firmware`：ESP-IDF 6.1 / ESP32-S3-N16R8 固件
- `apps/api/scripts/device-simulator.mjs`：ESP32-S3 模拟设备
- `docs/device-protocol.md`：未来固件需要实现的设备协议

## 已实现链路

```text
APP 演示账号
  └─ 绑定码绑定设备和角色
      ├─ 切换角色 → sync_character 指令
      ├─ 调节音量 → set_volume 指令
      ├─ 远程播报 → CosyVoice 生成 WAV → speak_text 指令 → ESP32 播放
      ├─ 闹钟/主动提醒 → play_reminder 指令 → 对应屏幕动画和角色语音
      └─ APP 开始说话 / 实体按键 → start_listening → ESP32 VAD 录音
                                             ↓
                         上传 WAV → 阿里云 NLS ASR → 保存用户消息
                                             ↓
                  角色 Prompt + 最近 30 条消息 → MiniMax 对话模型
                                             ↓
                      保存角色回复 → CosyVoice WAV → ESP32 播放
                         ↓
                  ESP32 真机或模拟器拉取并确认
```

业务数据已经持久化到 MySQL/MariaDB，后端重启不会丢失绑定、提醒或设备指令。

## 启动

需要 Node.js 20 或更新版本。

```bash
npm install
npm run db:create --workspace @figure/api
```

默认数据库配置为：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=
DB_DATABASE=figure_companion
DB_SYNCHRONIZE=true
```

CosyVoice TTS 使用阿里云百炼 API Key：

```dotenv
DASHSCOPE_API_KEY=你的百炼_API_Key
DASHSCOPE_TTS_MODEL=cosyvoice-v3.5-plus
DASHSCOPE_TTS_WS_ENDPOINT=wss://dashscope.aliyuncs.com/api-ws/v1/inference
DASHSCOPE_TTS_REALTIME_ENABLED=true
DASHSCOPE_TTS_DEFAULT_VOICE=<已复刻的 CosyVoice v3.5 音色 ID>
```

语音识别使用 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET` 和
`ALIYUN_NLS_APP_KEY`。设备录音默认经 WebSocket PCM 流进入阿里云实时识别，
实时连接不可用时自动退回完整 WAV/PCM 批量识别。后端自动获取并缓存 NLS
Token，AccessKey 不会下发到 APP 或 ESP32。密钥只配置在根目录 `.env`。

角色对话使用 MiniMax 的 OpenAI 兼容接口：

```dotenv
AI_API_KEY=你的_MiniMax_API_Key
AI_API_URL=https://api.minimaxi.com/v1
AI_MODEL=MiniMax-M2.7
```

每个角色的 `prompt` 存在 MySQL `figure_characters` 表中，可从 APP 修改。
每次请求按当前账号、设备和角色读取最近 30 条聊天记录并按时间顺序发送。

本机已验证的数据库服务实际为 MariaDB 10.1.37，因此 JSON 数据使用兼容的文本 JSON 映射。开发环境会通过 TypeORM 自动同步表结构；上线前应关闭 `DB_SYNCHRONIZE` 并改用数据库迁移。

终端 1，启动后端：

```bash
npm run dev:api
```

终端 2，启动模拟设备：

```bash
npm run simulate:device
```

模拟设备会每 3 秒发送心跳并拉取命令，预置凭证为：

- 硬件编号：`ESP32S3-DEMO-001`
- 设备密钥：`figure-dev-secret-001`
- 屏幕绑定码：`FIGURE-0001`

终端 3，启动 Expo Development Build：

```bash
npm run dev:mobile
```

APP 已切换为 Development Build，并已支持真实相机扫码和蓝牙配网。首次安装 Android 开发客户端：

```bash
cd apps/mobile
npm run android
```

开发客户端安装完成后，日常调试只需运行 `npm run dev:mobile`。将
`apps/mobile/.env.example` 复制为 `apps/mobile/.env`，把地址改成电脑局域网 IP，例如：

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000/v1
```

手机和电脑必须在同一 Wi-Fi，修改 `.env` 后重启 Metro。需要临时使用 Expo Go
验证纯 JavaScript 页面时，可以运行 `npm run start:go --workspace @figure/mobile`。

## 底座二维码、配网与认领

APP 已接入真实相机扫码和乐鑫 Security 1 BLE 配网。二维码由设备出厂/登记环节
生成，包含 BLE 广播名、PoP、硬件编号和账号认领码。当前开发板二维码可这样生成：

```bash
npm run qr:device --workspace @figure/api -- \
  --hardware-id ESP32S3-DEMO-001 \
  --name YZAI_6B9A54 \
  --pop yuzhou-6055 \
  --pairing-code FIGURE-0001
```

PNG 和对应 JSON 写入 `.data/device-qrcodes/`，不会提交到 Git。APP 扫码并完成 Wi-Fi
配置后会自动认领当前账号；换 Wi-Fi 不改变账号绑定。设备管理页支持解绑，解绑会
停用旧提醒和清除未执行指令，但聊天记忆仍按原账号隔离保存。

添加底座前，APP 会先引导用户开机并长按 BOOT 约 5 秒进入 `SETUP`，随后真实检测
手机网络、蓝牙、附近设备权限，以及 Android 11 及以下所需的定位权限和定位服务。
未满足的项目显示红叉并可跳转系统设置；从设置返回后自动复检，全部通过才允许进入
扫码或附近搜索。相机权限只在扫码页面申请。

## 检查命令

```bash
npm run typecheck
npm run build:api
```

验证 Expo 能否正常打包：

```bash
cd apps/mobile
npx expo export --platform ios --output-dir /tmp/figure-expo-export
```

## 后续阶段

硬件到货后依次替换：

1. 将 APP 的演示登录替换为现有 APP 用户 Token。
2. 将 `figure_users` 演示用户映射替换为现有 APP 用户表和正式登录 Token。
3. 实体按键到货后，将常开按键接在 `GPIO39` 与 `GND` 之间；固件接口已经就绪。
4. 将临时门禁卡替换为手办内置 NTAG213；现有 RC522 UID 识别、角色绑定和自动切换链路可直接复用。
5. 当前设备语音使用持久 WebSocket，并优先通过 Opus 16 kHz 单声道、20 ms 帧上传；连接建立时由后端广播能力，后端或编码器不支持 Opus 时自动回退 PCM16。后端验证设备后立即允许开始录音，阿里云实时 ASR 在后台并行建连，启动期间的音频会缓存后补送；说话结束后仍未就绪则快速转批量识别。单条连接可承载多轮对话，识别完成后会直接推送分段文本与 TTS 音频，首个自然短语优先合成，底座收到首段即可播放，并支持再次按下对话键打断当前回复。HTTP WAV、设备指令轮询仍作为稳定降级链路；后续可继续升级为带回声消除的真正全双工语音。

## ESP32-S3 主板自检

ESP-IDF 固件位于 `firmware/`，目前已验证串口、16MB Flash、8MB Octal
PSRAM、RGB 灯、ST7789 屏幕、HT517 功放、扬声器和 INMP441 麦克风。

详细命令见 `firmware/README.md`。

## 目前有意保留的限制

- 演示 Token 和预置设备凭证只用于本地开发。
- 演示角色中的占位 `voiceId` 会回退到 `DASHSCOPE_TTS_DEFAULT_VOICE`；完成音色复刻后替换成正式音色 ID。
- 对话 TTS 默认走 DashScope WebSocket 实时合成，完整 WAV 到达后立即交给底座；连接或模型不支持时自动降级到原 HTTP 合成。设置 `DASHSCOPE_TTS_REALTIME_ENABLED=false` 可强制使用 HTTP。
- 尚未实现 OTA、完整恢复出厂和固件签名；当前二维码仍使用开发阶段共享值，量产前必须改成一机一码。
- 普通主动提醒仍由运行中的 API 进程触发；AI 闹钟已由 0.8 固件提前缓存 WAV 和计划，
  可在后端临时不可达时本地响铃。APP 会显示底座的真实同步回执，并在响铃时
  提供“停止”和“稍后提醒”。完全断电后的无网络冷启动仍需外接 RTC 才能校时。

## 数据表

| 表 | 内容 |
|---|---|
| `figure_users` | 当前 MVP 的用户映射，后续接入现有用户表 |
| `figure_characters` | 角色资料、自定义 Prompt、问候语、阿里云音色 ID 和唯一 NFC UID |
| `figure_conversation_messages` | 用户与角色的聊天记录和最近 30 条上下文记忆 |
| `figure_devices` | 硬件编号、绑定账号、绑定角色、固件和在线状态 |
| `figure_device_sessions` | 设备访问 Token 哈希及过期时间 |
| `figure_reminders` | 闹钟/提醒时间、重复方式和执行状态 |
| `figure_device_commands` | APP 下发给 ESP32 的待执行指令及 ACK |
| `figure_device_events` | NFC UID、按键、唤醒、播放完成和错误等设备事件 |

设备密钥和设备会话 Token 均以 SHA-256 哈希保存，API 响应不会返回数据库中的密钥哈希。
