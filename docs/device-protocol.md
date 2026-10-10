# ESP32-S3 设备协议（MVP）

基础地址示例：`http://192.168.1.20:3000/v1`

除创建设备会话外，设备接口都携带：

```http
Authorization: Bearer <deviceAccessToken>
Content-Type: application/json
```

## 1. 创建设备会话

```http
POST /device/session
```

```json
{
  "hardwareId": "ESP32S3-DEMO-001",
  "deviceSecret": "figure-dev-secret-001"
}
```

返回设备访问 Token、绑定码和当前绑定状态。正式量产时，`hardwareId` 和 `deviceSecret` 应在生产测试阶段写入 NVS，不能所有设备共用同一个密钥。

## 2. 心跳

建议每 10～15 秒发送一次：

```http
POST /device/heartbeat
```

```json
{
  "firmwareVersion": "0.1.0",
  "volume": 60
}
```

后端在 45 秒内收到过心跳，就把设备视为在线。

## 3. 拉取控制指令

```http
GET /device/commands
```

返回尚未确认的指令数组。MVP 支持：

| type | 用途 | payload 主要字段 |
|---|---|---|
| `sync_character` | 更新角色与音色配置 | `character` |
| `set_volume` | 调节输出音量 | `volume` |
| `speak_text` | 下载并播报角色语音 | `text`, `voiceId`, `audioPath`, `audioFormat`, `sampleRate` |
| `play_reminder` | 触发闹钟或角色语音提醒 | `kind`, `title`, `voiceId`, `audioPath`, `audioFormat`, `sampleRate` |
| `sync_alarms` | 保存完整离线闹钟计划并预缓存铃声 | `revision`, `timezone`, `alarms[]` |
| `control_alarm` | 远程停止当前闹钟或进入稍后提醒 | `action`, `alarmId` |
| `start_listening` | VAD 录音并提交短语音识别 | `durationMs`, `stopMode`, `sampleRate`, `format`, `source` |

设备只有在执行成功或已经安全保存指令后才进行 ACK。

`speak_text.audioPath` 是后端生成的相对地址，例如
`/audio/550e8400-e29b-41d4-a716-446655440000.wav`。设备使用同一个
`deviceAccessToken` 下载该 WAV；当前固件支持 8～48 kHz、16-bit PCM、单声道或双声道，
最大 8 MB。设备完成播放后才 ACK，下载或播放失败时保留指令等待重试。

`sync_alarms` 是完整快照，不是增量更新。每个条目包含 `id`、`hour`、`minute`、
`daysMask`、`snoozeEnabled`、`snoozeMinutes`、`snoozeCount` 和 `audioPath`。
固件先把全部 WAV 下载到 SPIFFS，随后一次性替换 NVS 中的计划并 ACK；任何下载失败
都保留旧计划并等待下一轮重试。0.8 及以上固件使用 SNTP 校准北京时间，在底座本地
到点播放，后端只维护状态，不再重复下发 `play_reminder`。当前最多同步 8 个启用闹钟。

底座按 `revision` 回传 `alarm_sync_started`、`alarm_sync_completed` 或
`alarm_sync_failed` 事件；成功事件包含 `cachedCount`，失败事件包含可展示给
用户的 `message`。APP 可通过 `GET /devices/<deviceId>/alarm-sync` 查询真实
同步状态，或通过 `POST /devices/<deviceId>/alarm-sync` 重新下发完整快照。

`control_alarm.action` 支持 `stop` 和 `snooze`。该指令只控制当前响铃，
不修改闹钟本身的启用状态。

## 4. 确认指令

```http
POST /device/commands/<commandId>/ack
```

请求体使用空 JSON 对象 `{}`。未 ACK 的指令会在下一次拉取时再次返回，所以固件需要根据 `commandId` 防止重复执行。

## 5. 上报设备事件

```http
POST /device/events
```

```json
{
  "type": "button_pressed",
  "payload": {
    "button": "talk"
  }
}
```

后续可增加 `wake_word_detected`、`playback_started`、`playback_finished`、`wifi_signal` 和错误信息。

RC522 读到或移除标签时上报规范化 UID（大写十六进制、无分隔符）：

```json
{
  "type": "nfc_tag_present",
  "payload": {
    "uid": "3B03F16F",
    "uidLength": 4,
    "reader": "MFRC522"
  }
}
```

后端从 `figure_characters.nfcTagUid` 匹配角色。匹配成功且设备已绑定账号时，后端立即更新
设备当前角色并生成 `sync_character` 指令；未匹配 UID 仍保存在事件表，供 APP 的 NFC
角色绑定界面选择角色后写入 MySQL。同一个 UID 只能绑定一个角色。

后端也会把当前放置状态同步到设备记录：

- `nfc_tag_present`：写入 `lastNfcTagUid`、`lastNfcAt` 和匹配到的角色 ID。
- `nfc_tag_removed`：清空当前 `lastNfcTagUid` 和匹配角色，但保留最后变更时间。
- APP 绑定“当前已放置但未识别”的 UID 到某个角色后，后端会立即把底座当前角色切到该角色，
  下发 `sync_character`，并生成一句角色欢迎语。

APP 的设备视图会返回 `nfcTag`：

```json
{
  "uid": "3B03F16F",
  "lastSeenAt": "2026-09-13T10:00:00.000Z",
  "matched": true,
  "characterId": "suki",
  "characterName": "Suki"
}
```

## 6. 上传短语音

APP 通过 `POST /devices/<deviceId>/listen` 下发 `start_listening`。设备进入
`LISTENING` 后以 VAD 录音：检测到说话后遇到约 0.6 秒静音自动结束，约 4 秒内没有
说话则结束，最大录音长度由 `durationMs` 限制（当前 APP 为 10 秒）。输出为
16 kHz、16-bit、单声道 PCM WAV：

```http
POST /device/conversation/audio?commandId=<commandId>
Authorization: Bearer <deviceAccessToken>
Content-Type: audio/wav

<WAV binary>
```

后端校验 WAV 后调用阿里云 NLS 一句话识别，响应包含 `text`、`taskId`、
`durationMs` 和 `sampleRate`。同时写入 `speech_recognized` 或 `speech_empty`
设备事件，APP 轮询事件列表显示最近识别结果。设备收到成功响应后再 ACK 指令。
有识别文字时，后端异步执行角色对话，避免 MiniMax 和 TTS 耗时阻塞设备上传请求。

对话服务读取设备当前绑定角色的 `prompt`，并携带相同用户、设备、角色下最近
30 条消息调用 MiniMax。回复写入聊天记录后生成 CosyVoice WAV，并通过新的
`speak_text` 指令让设备自动播放。

实体按键调用同一个录音上传函数但省略 `commandId`；后端会将事件来源记为
`device_button`。固件默认将常开瞬时按键配置为 `GPIO39 → 按键 → GND`。
上传上限为 512 KB，当前最长 10 秒 WAV 大约 320 KB。

## 7. 设备状态与显示

固件状态为 `BOOTING`、`CONNECTING`、`IDLE`、`LISTENING`、`UPLOADING`、
`THINKING`、`SPEAKING`、`REMINDER`、`ALARM` 和 `ERROR`。屏幕底部动画和 RGB
都由状态机统一驱动；`play_reminder.payload.kind` 为 `alarm` 时显示红橙闪烁，
否则显示主动提醒动画。异常状态约 5 秒自动恢复，等待 AI 回复超过约 90 秒也会回到空闲。

## 8. 文本对话

```http
POST /device/conversation/messages
```

```json
{
  "text": "今天有什么安排？"
}
```

该接口也使用正式的 MiniMax 角色对话和 CosyVoice TTS，并把用户消息、角色回复
写入 MySQL。返回 `text`、`characterId`、`voiceId` 和 `audioUrl`，同时向设备
队列写入 `speak_text`。

APP 查询当前角色最近 30 条聊天记录：

```http
GET /devices/<deviceId>/messages
Authorization: Bearer <appAccessToken>
```

实时语音使用独立持久 WebSocket。连接建立后，后端先发送
`session.capabilities`，当前优先协商 `opus`（16 kHz、单声道、20 ms/帧），并兼容
`pcm_s16le`。Opus 每个二进制 WebSocket 消息承载一个完整编码帧；后端逐帧解码成
PCM 后送入现有实时 ASR。编码器或后端不支持 Opus 时自动使用 PCM，HTTP WAV
半双工链路继续作为稳定降级方案。

后端完成设备身份校验后会立即返回 `session.ready`，不再阻塞等待阿里云
实时 ASR 建连。ASR 在后台并行启动，建连期间到达的 PCM 会在内存中按序缓存并在
就绪后补送。说话结束时若实时 ASR 仍未就绪，最多再等待 800 ms，然后直接
转为批量 ASR，避免云端建连波动拖住整轮对话。

## 9. BLE 配网与更换 Wi-Fi

底座使用乐鑫 `network_provisioning` 的 BLE transport 和 Security 1。未保存 Wi-Fi
时自动进入配网；已配网设备在正常启动后长按 BOOT（GPIO0）约 5 秒，重启后进入
配网。BLE 广播名为 `YZAI_<MAC 后六位>`，APP 扫描的二维码结构如下：

```json
{
  "ver": "v1",
  "name": "YZAI_6B9A54",
  "pop": "yuzhou-6055",
  "transport": "ble",
  "security": 1,
  "hardwareId": "ESP32S3-DEMO-001",
  "pairingCode": "FIGURE-0001"
}
```

APP 从底座读取附近网络列表，再通过加密 BLE 发送所选 2.4 GHz SSID 和密码。
配网成功只更新设备本地网络凭据；账户绑定、角色绑定、记忆和提醒继续由后端保存，
因此更换 Wi-Fi 不等同于解绑。新增设备配网成功后，APP 使用 `pairingCode` 调用
`POST /devices/bind` 自动认领；同一账号重复调用是幂等的，已属于其他账号时返回
冲突。解绑调用 `DELETE /devices/<deviceId>/binding`，会停用该底座的旧提醒并删除
未执行指令，聊天记录继续按原用户隔离保存。开发阶段使用共享 PoP 和认领码，量产
时两者都改为不可预测的一机一码。
