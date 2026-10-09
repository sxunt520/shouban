# 阶段七：APP 主动播报与停止播放

日期：2026-10-09。扩展我方 R1M 提案，复用 WS v1 裸 Opus 和 MQTT/UDP 加密音频。无需调用 ASR 或 AI 生成回复，直接使用当前角色声音朗读 APP 输入文本。合作方需实现准备播放、实际播放结束与停止回执；模拟设备以解码和保存 WAV 代替真实扬声器播放。

## APP API 和状态

`POST /v1/devices/<业务设备 ID>/speak`，登录 Bearer，body：

```json
{"text":"你好，我是你的手办伙伴，很高兴见到你！"}
```

去除首尾空白后 1–500 字，必须已认领并选择角色。服务器立即创建 `speak_text` 账本，不在 APP 请求内等待 TTS。有效期固定 120 秒，生成音频最长 60 秒。等待中的同文本请求复用指令 ID；其他内容需先停止，避免叠加播放。完成后相同文本可以重新播报。

`GET /v1/devices/<ID>` 增加 `speechCommand`：`id/text/status/phase/errorMessage/completedAt`。status 共用账本状态；phase 区分：

| phase | 意义 |
|---|---|
| waiting | 等待设备 hello 控制连接 |
| synthesizing | 按当前角色生成 TTS |
| streaming | 云端发送音频 |
| playing | 收到设备开始播放回执 |
| awaiting_completion | 音频已发送，等待设备播放结束 |
| finished | 收到设备完整播放完成回执，status=succeeded |
| cancelled | 云端任务取消，尚不代表收到设备停止确认 |
| stopped | 设备明确确认停止，status 仍为 cancelled |
| failed | TTS、传输或设备处理失败 |

APP 不把“音频发送结束”当成播放成功。设备缺少回执，最终 expired；TTS 失败显示具体错误。取消后收到 finished 也不能重新成功。

`POST /v1/devices/<ID>/playback/stop`：校验归属后取消待执行任务，立即中断云端生成后的发送，并请求当前设备停止。TTS 服务若已开始生成，本轮通过轮次失效阻止晚到结果发送，不保证撤销提供商侧已经执行的合成或费用。

## 播放控制与音频

云端账本类型为 `speak_text`，设备收到 `play_audio`，随后是同会话 tts 和音频流：

```json
{"type":"custom","session_id":"<session>","payload":{"cmd":"play_audio","id":"<commandId>","args":{"text":"你好","frames":67},"expiresAt":1791556100000}}
```

```json
{"type":"tts","state":"start","command_id":"<commandId>","session_id":"<session>"}
{"type":"tts","state":"sentence_start","text":"你好","command_id":"<commandId>","session_id":"<session>"}
{"type":"tts","state":"stop","command_id":"<commandId>","session_id":"<session>"}
```

start 和 stop 之间走既有音频：WS 二进制 v1 裸 Opus，或 MQTT 控制 + UDP 提案加密 Opus。24kHz、单声道、每帧 60ms；MQTT 的 tts.start/stop 另带 audio_sequence 校验首尾帧。

**command_id 是新增关联字段**。准备播放需检查有效期；完成过的 commandId 只重发原结果，不重新播放。重复 tts.start 不能重置正在播放的缓冲。无 command_id 的既有对话 TTS 不得发送主动播报指令回执。

设备开始播放时，可发送：

```json
{"type":"custom","session_id":"<session>","payload":{"eventId":"<commandId>","type":"cmd_ack","payload":{"result":"ok","phase":"playing"}}}
```

设备在接收完整音频并实际播放完后发送：

```json
{"type":"custom","session_id":"<session>","payload":{"eventId":"<commandId>","type":"cmd_ack","payload":{"result":"ok","phase":"finished","frames":67}}}
```

服务端要求已到 awaiting_completion、frames 与准备播放的完整帧数一致，才能成功。模拟器验证解码帧数、保存 WAV 后回执；这只是模拟完成，不证明扬声器出声。解码失败、UDP 缺帧或设备播放失败，使用 `result:error` 并附 `error`。

也可走 HTTP `/api/zckj/deviceEventReport` 或 `/deviceCommands/ack`，沿用 OTA 通道凭证和身份校验。HTTP 命令轮询仍补发音量与定位，**不发 speak_text**，避免固件误按旧音频文件播放；播报等待 WS/MQTT hello。

## 停止、抢话与重连

云端停止消息：

```json
{"type":"custom","session_id":"<session>","payload":{"cmd":"stop_playback","id":"<commandId>"}}
{"type":"tts","state":"stop","session_id":"<session>","command_id":"<commandId>","cancelled":true}
```

设备立即停止该任务，清理缓冲；不得把取消的 tts.stop 当作成功完成。停止确认的 cmd_ack payload 为 `{"result":"ok","phase":"stopped"}`。没有真正开始的任务可以仅由云端取消；APP 只有明确收到设备停止回执才显示“设备已确认停止”。

主动播报会打断现有监听/对话，旧 ASR/AI/TTS 结果不能晚到插播。设备再次 listen.start 会取消 APP 播报并启动新的语音轮次。角色变化、解绑、会话替换、断连同样中断旧任务。已下发播报在 API 重启后取消，避免用户听到不确定的重复播放；未下发任务继续在有效期内等待。过期任务不自动重播。

## MQTT/UDP 返回地址探测

云端要知道设备 UDP 返回地址，设备收到新 hello 后先发一个经过提案认证的静音 Opus 包：16kHz、单声道、60ms，sequence=1、timestamp=0。它只用于确认 UDP peer，不发送 listen.start，不能进入 ASR。

后续录音从 sequence=2 起，同方向会话内序号继续递增。首次 listen.start.audio_sequence 从实际录音的首包开始，云端丢弃更早的探测包；新会话重新生成密钥并重置序号。探测沿用 [UDP 字节级提案](company-r1m-proposal-v1.md)，不增加未加密裸探测包。生产蜂窝 NAT 的映射保活、网络切换与重新探测策略仍需真实 4G 硬件联调，本轮不假定已验收。

## 验证与代码

后端：`DeviceIntegrationService` 持久化任务和回执，`R1mVoiceService` 生成并流式发送；`R1mControlService` 调度连接；MQTT 适配器继续封装加密 UDP。APP：`R1mDevicePanel.tsx`。两种独立模拟器共享播放任务去重和回执逻辑。

```bash
npm run dev:partner -- --voice --r1m
npm run test:r1m
npm run test:mqtt
npm run test:voice
npm run typecheck
```

本轮 R1M 30 项、旧 MQTT 16 项、参考语音 9 项回归通过，共 55 项；后端与 APP 类型检查通过。覆盖 WS/MQTT 主动播报、去重、回执帧数校验、生成中停止、传输中停止及停止确认、TTS 失败、离线过期、断线取消和自动监听被主动播报打断，以及设备 listen.start 打断 APP 播报。

Android 真机实际操作：APP 点击“让手办说”，真实 cosyvoice-v3-flash / longanyang 生成语音，模拟设备解码 67 个经过认证的 Opus 帧，APP 显示“播放完成”；第二次播报点击停止，收到设备 stopped 回执。音量保持 78%。本轮未刷写实体底座，没有真实 R1M 扬声器或 4G 验收；iOS 共享 React Native 代码已通过类型检查，未实测。

私有证据在 `.data/verification/r1m-phase7-*`；音频和私有密钥不随对接资料发给合作方。新增功能复用既有 speak_text enum，无新增数据库字段或迁移。
