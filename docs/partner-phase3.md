# 第三轮：参考语音链路

本轮实现 APP 调试输入、MQTT 会话控制、UDP AES-CTR/Opus 音频、ASR/AI/TTS 复用、回复试听与打断。运行在隔离开发库，正式生产接入仍需合作方确认报文与加密测试向量。

## 启动和操作

```bash
npm run dev:partner -- --voice
```

启动本地 Broker、API 及独立 A/B 模拟器进程。原 ESP32-S3 参考板继续可连接 MQTT 并调音量，不启用其未实现的麦克风/扬声器能力。

`--voice` 仅为 `_mqtt_dev` 库启用参考语音，读取根目录 `.env` 中已配置的 `AI_* / DASHSCOPE_* / ALIYUN_NLS_* / ALIYUN_ACCESS_KEY_*` 服务配置，不继承原业务库连接。原 `.env` 不修改。首次创建独立的「语音联调角色」，默认 `cosyvoice-v3-flash / longanyang`；只供参考调试。可通过 `REFERENCE_VOICE_TTS_MODEL` 与 `REFERENCE_VOICE_TTS_VOICE` 为首次创建配置匹配的音色。

APP「设备」中选择模拟底座 A/B，在「参考语音联调」选择角色：

- 发送调试文本：模拟器执行 hello、listen，UDP 静音探测建立回传端点；文本明确绕过 ASR，但 AI、TTS 和回复 UDP 均走真实服务/通道。
- 选择 WAV：0.1–10 秒、16kHz、单声道、PCM16 WAV。APP 上传给后端作为模拟器测试素材，经参考 MQTT 扩展分包交给模拟器；模拟器通过真实 UDP 加密 Opus 回传，后端解码交给 ASR。
- 试听本轮回复：通过当前账号鉴权读取该轮 WAV。模拟器另外把收到的 UDP 回复解码为 `.data/voice-simulator/<设备>-<会话>.wav`。
- 打断：终止此轮输入/回复传输、取消旧结果与试听地址。已有请求的第三方计算不保证立即停止，但完成结果不会进入新会话。

设备离线、未选角色、服务拒绝或音频不匹配均显示真实失败；MQTT 发布成功只返回 `submitted`。`completed` 表示服务端回复发送完成，不能等同合作方喇叭已经播放完成。本参考模拟器的解码文件是另一份下行接收证据。

UDP 默认绑定 `127.0.0.1:18900`。同机模拟器可用此地址；实体板没有语音能力，因此不会向它下发 UDP 密钥。若后续扩展跨机器参考模拟器，需显式设置 `PARTNER_VOICE_HOST` 为本机私网 IPv4，并同步调整模拟器的 UDP 绑定；当前默认模拟器限定同机。

## 会话和协议边界

参考 profile 是 `reference-udp-opus-v1`。设备必须在预登记 MQTT 身份下发布，且仅 `MQTT-SIM-A/B` 在隔离库被允许。hello 还需匹配 APP 显式提交的测试 ID，避免未授权自动触发第三方服务调用。底座音量协议继续使用第一轮 profile。

已采用合作方描述的 `hello / listen / stt / tts / abort / goodbye / alert` 控制结构与 16 字节音频头。以下均为参考扩展，不能作为正式兼容证明：

- `reference_voice_profile`、`reference_test_id`，以及素材传输 `reference.voice.begin/frame/commit`。
- `reference.listen.ready` 确认监听开启，避免首个 UDP 包先于 MQTT 开始消息。
- `listen.stop.reference_frame_count` 用于检测末帧丢失；收到 stop 后保留 200ms UDP 收尾窗口。
- hello 中 `reference_down_key / reference_down_nonce` 为下行独立密钥和 nonce，避免上下行复用同一计数器。

参考 UDP 编码：头明文，`type=1 / flags=0 / payload_len / ssrc / timestamp / sequence`；多字节字段 big-endian。`ssrc` 来自会话随机 nonce 的 4–7 字节。AES-128-CTR 的 counter 为该 16 字节头，负载为加密 Opus；上、下行独立密钥。序号从 1 开始，时间戳从 0 开始每帧增加 60ms。

AES-CTR 本身不带完整性认证。长度、SSRC、序号和端点检查不等于密码学认证；当前仅作为私网开发契约。合作方的 nonce 拼接、方向区分、加密范围、完整性保护和测试向量需明确后替换 codec，不能把双方使用 AES-CTR 当作兼容证明。

上行固定 16kHz/单声道/60ms，最多 167 帧；下行固定 24kHz/单声道/60ms，最长 60 秒。收到上行后按序解码，重复帧丢弃，缺帧明确失败；本轮没有抖动缓冲、Opus PLC/FEC、连续对话和 AEC。设备回复文件按序重建，发现缺帧也报错，不静默伪造完整录音。

## 会话失效与账号隔离

每轮随机 session ID、方向密钥和路由 SSRC。新轮次取消旧轮次；旧包不进入新路由。打断、换角色、解绑、MQTT 断开会失效旧结果；ASR 后、AI/TTS 后、持久化前及发送音频过程中检查当前会话、账号和角色。模型输出不会变成旧 HTTP 的 `speak_text` 指令。

API 均校验设备归属；试听还校验会话 ID，不提供公开音频链接，也不在 APP 状态接口返回 UDP 密钥。会话最长 120 秒，届满清理音频与密钥，API/模拟器退出时清理 socket 和监听。

## iOS

文件选择使用 Expo DocumentPicker 并复制到应用缓存；上传使用 Expo FileSystem multipart；试听使用 expo-av，配置 `playsInSilentModeIOS`，组件退出或切设备时释放播放器。核心业务不依赖 Android 文件路径、USB 转发或系统定位。iPhone 联调需要手机能访问的 HTTPS/局域网后端及相应网络设置。

按用户要求持续考虑 iOS，当前未进行 iOS 编译或真机验收。Android 的文件上传及音频加载与 BLE 的 Android 实机结果分别记录，不相互替代。

## 回归与验收记录（2026-10-09）

```bash
npm run test:voice
npm run test:mqtt
npm run typecheck
```

- 语音：7 个网络子场景 + codec 用例，共 9 项（含父用例）。真实本地 Broker/UDP 与原生 Opus，ASR/AI/TTS 在自动化中使用明确的测试替身。覆盖 WAV 双向传输、A/B 隔离、归属/实体能力边界、重复包/末帧丢失、过期包/旧 goodbye、延迟回复打断、上下文及 Broker 断开失效。
- 原有 MQTT 集成：15 个子场景，共 16 项（含父用例）通过。
- 独立进程与真实 AI/TTS：文本输入已生成「嗨，我是手办语音助手！」，回复 47 个 UDP Opus 帧，模拟器重建 WAV。
- 真实提供商配置检查：原复刻音色请求遭 TTS 拒绝 `418 / InvalidParameter`，未冒充成功。仅参考角色切换为系统音色和匹配模型继续验收；原业务角色/根 `.env` 未改。模型与音色范围见 [阿里云模型说明](https://help.aliyun.com/zh/model-studio/tts-model)、[系统音色列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)。原复刻音色仍需单独核实可用性。
- Android APP WAV → 真实 ASR/AI/TTS → 音频加载：00:17 真机通过。输入是前轮 UDP 解码回复生成的 2.82 秒、16kHz 测试 WAV（并非真人麦克风录音）。APP 原生 multipart 上传成功，模拟器回传 47 帧，ASR 识别「嗨我是手办语音助手。」，真实 AI/TTS 生成回复并下发 89 帧；模拟器收到并解码 WAV，Android 使用账号鉴权加载回复音频成功，没有自动播放。
- 本机证据（忽略提交）：`.data/verification/partner-phase3-phone-result.json`、`partner-phase3-service-result.json`、`partner-phase3-phone.png`、`partner-phase3-input.wav`、`partner-phase3-reply.wav`；提供商日志摘录 `partner-phase3-provider-evidence.txt`；独立进程当前日志 `.data/phase3-runtime.log`。类型检查通过，代码差异空白检查通过。
- 实体麦克风/扬声器、真实听感、iOS、合作方实机报文：未验收。

APP 另有显式 debug 测试：私有 files 放置 `partner-voice-test.json`（仅 `deviceId`）及 `partner-voice-input.wav` 才执行。测试上传文件、等待同一 test ID 的回复，再用手机播放器加载账号鉴权的 WAV（不自动播放）。配置与输入完成后删除，结果写 `partner-voice-test-result.json`。不会在生产包自动运行。


## 后续范围更新

2026-10-09 用户确认 R1M 范围包含 4G，语音通道由 OTA 的 websocket/mqtt 配置决定。下一轮增加合作方 WS hello/listen/v1 裸 Opus 适配器，并对齐正式 MQTT/UDP；本页参考 UDP 验收不作为双通道已经完成的证明。120 秒 HTTP 上报与 MQTT keepalive/通道空闲超时分开判断。详见 [R1M 接入确认与实施调整](r1m-confirmed-integration.md)。
