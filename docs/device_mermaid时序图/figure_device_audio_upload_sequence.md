# Figure 设备音频上传与生命周期说明

本文整理了 ESP32 设备端的核心生命周期，以及两条主要音频上传链路：

- WebSocket 实时语音流
- HTTP WAV 文件上传

这两条链路在源码中由统一入口 `record_and_upload(...)` 负责调度，优先走 WebSocket，失败时自动回退到 HTTP。

---

## 1. 程序整体生命周期

### 1.1 启动流程（`app_main()`）

程序入口位于 `app_main()`。启动时会依次执行：

- 初始化 RGB LED、显示屏、麦克风、Speaker、NFC 等硬件
- 执行板载自检
- 初始化 NVS，恢复音量、API 地址、离线闹钟
- 配置按键 GPIO
- 若设备未完成 Wi‑Fi 配置，则进入 BLE Provisioning 流程
- 若已完成配置，则进入 Wi‑Fi station 模式
- 等待 Wi‑Fi 连接成功
- 启动 SNTP 时间同步
- 创建后台任务：
  - `offline_alarm_task()`
  - `figure_network_task()`
  - NFC 事件上传任务

```mermaid
sequenceDiagram
    autonumber
    participant Board as 电源上电
    participant App as app_main()
    participant HW as 硬件初始化
    participant NVS as NVS 恢复配置
    participant WiFi as Wi‑Fi / Provisioning
    participant Sync as SNTP 时间同步
    participant BG as 后台任务

    Board->>App: 启动程序
    App->>HW: 初始化 LED / 屏幕 / 麦克风 / 扬声器 / NFC
    App->>NVS: 读取 volume / api_base_url / offline_alarms
    App->>WiFi: 检查是否已配网
    alt 未配置
        WiFi->>WiFi: BLE provisioning
    else 已配置
        WiFi->>WiFi: 连接 Wi‑Fi station
    end
    WiFi-->>App: Wi‑Fi connected
    App->>Sync: configure_time_sync()
    App->>BG: 创建 offline_alarm_task / figure_network_task / nfc_event_uploader_task
    App-->>Board: 进入持续运行状态
```

### 1.2 运行流程（状态机）

程序核心是 `device_state_t` 状态机，典型状态包括：

- `DEVICE_STATE_BOOTING`
- `DEVICE_STATE_CONNECTING`
- `DEVICE_STATE_IDLE`
- `DEVICE_STATE_LISTENING`
- `DEVICE_STATE_UPLOADING`
- `DEVICE_STATE_THINKING`
- `DEVICE_STATE_SPEAKING`
- `DEVICE_STATE_REMINDER`
- `DEVICE_STATE_ALARM`
- `DEVICE_STATE_ERROR`

其中 `device_set_state(...)` 负责统一切换状态，并同步更新：

- `device_state`
- `device_state_since`
- RGB LED 颜色
- 显示屏状态
- 日志输出

```mermaid
stateDiagram-v2
    [*] --> BOOTING
    BOOTING --> CONNECTING
    CONNECTING --> IDLE
    IDLE --> LISTENING
    LISTENING --> UPLOADING
    UPLOADING --> THINKING
    THINKING --> SPEAKING
    THINKING --> REMINDER
    THINKING --> ALARM
    SPEAKING --> IDLE
    REMINDER --> IDLE
    ALARM --> IDLE
    LISTENING --> ERROR
    UPLOADING --> ERROR
    THINKING --> ERROR
    ERROR --> IDLE
```

### 1.3 事件流（按键 / NFC / 云端命令）

后台的 `figure_network_task()` 是核心调度器，主要职责包括：

- 生成/刷新设备 session
- 发送 heartbeat
- 拉取 `/device/commands`
- 执行云端命令
- ack 命令完成
- 上报本地按钮事件和 NFC 事件

```mermaid
sequenceDiagram
    autonumber
    participant User as 用户
    participant Button as 按键任务
    participant NFC as NFC Reader
    participant Net as figure_network_task()
    participant API as 后端服务
    participant Device as 设备状态机

    User->>Button: 按下音量/功能/睡眠键
    Button->>Button: queue_button_event(...)
    Button->>Net: xTaskNotifyGive(figure_network_task)

    NFC->>NFC: 读取 Tag UID
    NFC->>Net: 入队 nfc_event_queue

    Net->>API: create_device_session() / send_heartbeat()
    API-->>Net: 设备 session / pending commands
    Net->>API: GET /device/commands
    API-->>Net: 返回命令
    Net->>Device: device_set_state(...)
    Net->>API: acknowledge_command()/post_device_event()
```

---

## 2. WebSocket 实时语音上传时序

### 2.1 主流程

当用户按下对话键，或者云端发起语音任务时，程序进入统一入口：

- `record_and_upload(...)`
- `record_and_stream_websocket(...)`

主要逻辑如下：

1. 建立 WebSocket 连接到 `/device/conversation/stream`
2. 发送 `audio.start`
3. 调用 `stream_microphone_pcm(...)` 读取麦克风 PCM
4. 进行 VAD（静音/语音检测）
5. 分块通过 WebSocket 发送 PCM
6. 发送 `audio.end`
7. 服务端返回 `conversation.accepted`
8. 若 `hasText == true`，则进入 `play_realtime_voice_reply(...)`
9. 播放返回 `reply.audio`
10. 发送 `reply.audio.ack`
11. 完成后发送 `reply.done`

```mermaid
sequenceDiagram
    autonumber
    participant UI as 用户/命令
    participant R as record_and_upload()
    participant RS as record_and_stream_websocket()
    participant B as build_voice_websocket_url()
    participant WS as esp_websocket_client
    participant API as /device/conversation/stream
    participant SM as stream_microphone_pcm()
    participant VAD as VAD / 静音检测
    participant PR as play_realtime_voice_reply()
    participant DL as download_and_play_audio()

    UI->>R: 触发语音采集
    R->>RS: record_and_stream_websocket(...)
    RS->>B: 生成 ws:// / wss:// URL
    B-->>RS: 返回目标 URL
    RS->>WS: esp_websocket_client_init()
    RS->>WS: esp_websocket_client_start()
    WS->>API: 建立连接
    API-->>WS: 连接成功
    RS->>WS: 发送 {"type":"audio.start"}
    API-->>WS: {"type":"session.ready"}

    RS->>SM: stream_microphone_pcm(client,...)
    loop 实时采集
        SM->>SM: i2s_channel_read()
        SM->>VAD: 计算音量与静默时长
        VAD-->>SM: 判断 speech_detected / silence
        SM->>WS: esp_websocket_client_send_bin()
        WS->>API: 实时 PCM 流
    end

    SM-->>RS: 采集结束
    RS->>WS: 发送 {"type":"audio.end"}
    API-->>WS: {"type":"conversation.accepted"}

    alt hasText == true
        RS->>PR: play_realtime_voice_reply()
        PR->>PR: device_set_state(THINKING)
        loop 处理 reply.audio
            API-->>WS: {"type":"reply.audio", "audioPath": "..."}
            PR->>DL: download_and_play_audio(audio_path)
            DL-->>PR: 播放完成
            PR->>WS: 发送 {"type":"reply.audio.ack"}
        end
        API-->>WS: {"type":"reply.completed"}
        PR->>WS: 发送 {"type":"reply.done"}
        PR->>PR: device_set_state(IDLE)
    else hasText == false
        RS->>RS: 直接回到空闲状态
    end
```

### 2.2 关键函数

- `build_voice_websocket_url(...)`
  - 将 `api_base_url` 转换成 `ws://` 或 `wss://` 语音流地址
- `voice_websocket_event(...)`
  - 处理 `CONNECTED / DATA / ERROR / DISCONNECTED`
  - 通过 EventGroup 同步状态位
- `stream_microphone_pcm(...)`
  - 读取 PCM
  - 执行 VAD
  - 主动发送音频二进制数据
- `play_realtime_voice_reply(...)`
  - 接收服务端返回的复述音频
  - 有序播放并 ACK

---

## 3. HTTP WAV 上传时序

### 3.1 回退机制

当 WebSocket 不可用、连接失败或返回错误时，程序会自动回退到：

- `record_and_upload_http(...)`
- `record_microphone_wav(...)`
- `http_binary_post(...)`

这是一条更稳妥的备用链路。

```mermaid
sequenceDiagram
    autonumber
    participant UI as 用户/命令
    participant R as record_and_upload()
    participant RH as record_and_upload_http()
    participant M as record_microphone_wav()
    participant HB as http_binary_post()
    participant HC as esp_http_client
    participant API as /device/conversation/audio
    participant JSON as cJSON_Parse

    UI->>R: 启动录音
    R->>RH: 触发 HTTP 回退流程
    RH->>RH: device_set_state(LISTENING)
    RH->>M: record_microphone_wav(...)
    M->>M: i2s_channel_read() 采集麦克风
    M->>M: 组装 WAV 文件头
    M-->>RH: 返回 wav buffer / wav_size

    RH->>HB: http_binary_post(..., wav, wav_size, "audio/wav", &http_response)
    HB->>HC: esp_http_client_init / set_method / set_post_field
    HC->>API: POST 二进制音频
    API-->>HC: 返回 HTTP status
    HC-->>HB: HTTP_EVENT_ON_DATA
    HB-->>RH: 返回 status / response

    RH->>JSON: cJSON_Parse(http_response.data)
    JSON-->>RH: 解析 accepted / text

    alt accepted == true
        RH->>RH: device_set_state(THINKING)
        RH-->>R: 返回 true
    else
        RH->>RH: device_set_state(ERROR)
        RH-->>R: 返回 false
    end
```

### 3.2 关键函数

- `record_microphone_wav(...)`
  - 把 PCM 组装成合法 WAV 文件
- `http_binary_post(...)`
  - 发送二进制音频内容
- `http_event_handler(...)`
  - 收集 HTTP 返回体
- `cJSON_Parse(...)`
  - 解析 `accepted` 与识别文本

---

## 4. 时序总结：统一入口调度逻辑

```mermaid
sequenceDiagram
    autonumber
    participant Trigger as 用户按键 / 云端命令
    participant Entry as record_and_upload()
    participant WS as record_and_stream_websocket()
    participant HTTP as record_and_upload_http()
    participant Device as device_set_state()

    Trigger->>Entry: 触发语音录制
    Entry->>WS: 尝试 WebSocket 实时语音流

    alt WebSocket 成功
        WS-->>Entry: VOICE_STREAM_SUCCESS
        Entry->>Device: 调整状态为 LISTENING / THINKING / IDLE
        Entry-->>Trigger: 结束
    else WebSocket 不可用
        WS-->>Entry: VOICE_STREAM_UNAVAILABLE
        Entry->>HTTP: 进入 HTTP WAV 回退路径
        HTTP-->>Entry: 返回上传结果
        Entry->>Device: 更新状态
        Entry-->>Trigger: 结束
    else WebSocket 失败
        WS-->>Entry: VOICE_STREAM_FAILED
        Entry->>Device: 进入 ERROR 或恢复状态
        Entry-->>Trigger: 返回失败
    end
```

这一层设计体现了整个项目的本质：

- 优先低延迟实时交互
- 降级到稳定的 HTTP 上传
- 统一状态机控制运行状态
- 通过事件驱动和队列处理异步上传/回放

---

## 5. 结论

这份代码不是传统意义上的“单线程顺序流程”，而是典型的 ESP32 多任务 + 状态机设计：

- 启动初始化
- Wi‑Fi 配网
- Session 建立
- 心跳与命令同步
- 实时语音采集
- WebSocket 或 HTTP 上传
- 音频播放
- 离线闹钟与状态恢复

核心函数可以概括为：

- `app_main()`
- `device_set_state()`
- `figure_network_task()`
- `record_and_upload()`
- `record_and_stream_websocket()`
- `record_and_upload_http()`
- `offline_alarm_task()`

该设计兼顾了：

- 低延迟实时交互
- 稳定的降级能力
- 云端命令驱动
- 本地状态机管理
- 自恢复与异常处理

因此，它更像是一个“云端命令驱动 + 本地事件驱动 + 状态机控制”的智能音频设备运行模型。

---

如果你需要，我还可以继续把这份文档整理成：

1. 更适合 README 的精简版
2. 更适合发给团队的汇报版
3. 带中文注释的函数级时序图版本
