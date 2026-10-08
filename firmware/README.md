# ESP32-S3 固件

目标硬件：ESP32-S3-WROOM-1-N16R8 开发板。

当前固件支持：

- 串口输出芯片、Flash、PSRAM 和复位信息；
- GPIO48 板载 WS2812 RGB 灯状态提示；
- 连接 Wi-Fi 和 Nest.js 后端；
- 创建设备会话、发送心跳并拉取设备指令；
- 将音量和角色配置保存到 NVS 后 ACK；
- 驱动 1.54 英寸 ST7789 屏幕显示设备状态；
- 驱动 HT517 I2S 功放并播放启动音；
- 下载后端 CosyVoice 生成的 WAV，经 I2S 播放完成后 ACK `speak_text`；
- 提前下载并缓存最多 8 个闹钟 WAV，将计划保存到 NVS，由底座按北京时间本地触发；
- 驱动 INMP441 I2S 麦克风，并在启动时显示输入电平自检。
- 驱动 MFRC522 13.56 MHz 读卡器，识别 MIFARE、NTAG213 等 ISO 14443A
  标签的 4、7 或 10 字节 UID，并检测标签放入和移开。
- 接收 `start_listening` 或本地按键请求后，用 VAD 录制 16 kHz 单声道 WAV，上传后端完成 ASR；
- 使用统一设备状态机驱动屏幕与 RGB：连接、空闲、聆听、上传、思考、说话、提醒、闹钟和错误。
- 首次使用或长按 BOOT 约 5 秒后，通过加密 BLE 为底座配置 2.4 GHz Wi-Fi。

INMP441 接线：`VDD -> 3V3`、`GND -> GND`、`SCK -> GPIO8`、
`WS -> GPIO4`、`SD -> GPIO6`、`L/R -> GND`（选择左声道）。

MFRC522 使用独立 SPI2 总线，接线为：`3.3V -> 3V3`、`GND -> GND`、
`SDA/SS -> GPIO10`、`SCK -> GPIO12`、`MOSI -> GPIO11`、
`MISO -> GPIO13`、`RST -> GPIO9`，`IRQ` 暂不连接。模块只能使用 3.3V
供电。启动自检通过后屏幕显示 `NFC READY`；放入卡片或标签后显示完整 UID，
移开后显示 `TAG REMOVED`。串口同时输出 `NFC tag present/removed` 日志。

录音时屏幕依次显示 `LISTENING`、`UPLOADING`、`THINKING`。检测到连续语音后，
静音约 1 秒自动结束；约 4 秒仍未开始说话则结束；单次最长 10 秒。未识别到有效
语音时显示 `NO SPEECH`，上传或识别失败时进入 `ERROR`，随后自动回到空闲。

默认启用按键接口：将一个常开瞬时按键接在 `GPIO39` 与 `GND` 之间，按下后复用
同一套 VAD 录音与上传流程。不要把按钮接到 3V3；GPIO39 已启用内部上拉和 40 ms
消抖。按钮尚未安装时，引脚保持悬空高电平即可。

识别到文字后，后端异步调用绑定角色的 MiniMax 对话模型，生成 CosyVoice
语音并下发 `speak_text` 指令；设备收到后自动播放角色回复。

## 启用 ESP-IDF 6.1

```bash
export IDF_PATH=/Users/sxunt/Downloads/espressif/.espressif/v6.1/esp-idf
source "$IDF_PATH/export.sh"
```

## 编译、烧录和查看日志

```bash
cd /Users/sxunt/Downloads/expo/figure/firmware
idf.py set-target esp32s3
idf.py menuconfig
idf.py build
idf.py -p /dev/cu.usbmodem143201 flash monitor
```

在 `menuconfig` 中进入 `Figure Board Self-Test`，至少配置：

- `Wi-Fi SSID`
- `Wi-Fi password`
- `Figure API base URL`，当前电脑局域网地址示例为
  `http://192.168.18.225:3000/v1`

SSID 和密码只保存在已被 `.gitignore` 排除的 `sdkconfig` 中。

同一菜单还可以调节 VAD 阈值、结束静音时长、等待说话超时和按键 GPIO。当前实机
默认值为最低阈值 `350`、静音 `1000 ms`、等待说话 `4000 ms`、GPIO39。
每次录音开始时还会自动测量约 0.33 秒环境底噪，并动态提高实际阈值。

退出串口监视器：按 `Ctrl+]`。

这里使用开发板上标记为 `USB` 的原生 USB Serial/JTAG 接口。当前这块板通过
标记为 `UART` 的 CH343 接口读取正常，但上传 stub 和写 Flash 不稳定；设备名
也可能在重新插拔后变化，可用 `ls /dev/cu.usbmodem*` 重新确认。

RGB 含义：启动时红绿蓝各一次；等待配置时蓝色闪烁；连接 Wi-Fi 时黄色；
心跳成功短亮绿色；网络或后端失败短亮红色。

## APP 蓝牙配网

首次烧录且 NVS 中没有 Wi-Fi 时，底座会自动进入配网模式，屏幕显示 `SETUP`，
并广播名称 `YZAI_<MAC 后六位>`。已有 Wi-Fi 的底座需要在正常启动完成后长按
板载 `BOOT`（GPIO0）约 5 秒；屏幕显示 `SETUP` 后松开，设备会重启并清除旧的
Wi-Fi 配置。不要在按住 BOOT 时复位或重新上电，否则 ESP32-S3 会进入下载模式。

在“屿宙AI手办”APP 中进入“AI手办 → 添加智能底座”，可扫描底座二维码，也可
选择“搜索附近底座”。二维码使用乐鑫标准 JSON 格式：

```json
{"ver":"v1","name":"YZAI_6B9A54","pop":"yuzhou-6055","transport":"ble","security":1,"hardwareId":"ESP32S3-DEMO-001","pairingCode":"FIGURE-0001"}
```

当前开发阶段使用统一 PoP `yuzhou-6055`、认领码 `FIGURE-0001` 和 Security 1
加密链路。量产前必须为每台设备生成独立随机 PoP 与认领码，并把设备名、硬件编号、
PoP 与认领码编码到机身二维码；不要继续使用公开的开发值。APP 将 Wi-Fi 凭据通过
加密 BLE 发给底座，不会上传 Wi-Fi 密码。

本地生成当前开发板二维码：

```bash
npm run qr:device --workspace @figure/api -- \
  --hardware-id ESP32S3-DEMO-001 \
  --name YZAI_6B9A54 \
  --pop yuzhou-6055 \
  --pairing-code FIGURE-0001
```

生成文件位于仓库根目录 `.data/device-qrcodes/`，该目录已被 Git 忽略。

底座只支持 2.4 GHz Wi-Fi。搬到公司或更换路由器时，重新长按 BOOT 进入配网模式，
在 APP 设备页选择“更换 Wi-Fi”即可；这不会解除底座与账户或角色的绑定。

## TTS 实机链路

后端使用 `DASHSCOPE_API_KEY` 请求 CosyVoice，把生成的 WAV 缓存在
`.data/tts/`，再向设备下发带 `audioPath` 的 `speak_text`。ESP32 使用设备令牌
下载音频，屏幕依次显示 `DOWNLOADING`、`SPEAKING` 和 `SPEAK OK`。

当前仅接受 WAV PCM 16-bit、单/双声道、8～48 kHz，单个文件最大 8 MB。
音频下载或解析失败时不会 ACK，设备会在下一轮继续重试。

## 离线闹钟

APP 新增、修改、开关或删除闹钟后，后端下发完整 `sync_alarms` 快照。底座会先下载
所有铃声，确认 WAV 有效后才把新计划写入 NVS；因此同步中断不会破坏原计划。铃声
保存在 10 MB `audio` SPIFFS 分区，计划在断电重启后仍存在。联网启动时使用 SNTP
校准 Asia/Shanghai 时间，校时完成后由底座本地检查并播放，不依赖到点时后端在线。

当前离线调度最多保存 8 个启用闹钟。ESP32-S3 没有后备电池 RTC，完全断电后必须
至少联网完成一次校时才会重新触发闹钟；后续可增加带电池 RTC 解决无网络冷启动。

每次同步都携带唯一 `revision`。底座会回传开始、完成或失败事件，
APP 因此可显示真实的“等待底座”、“正在缓存”、“已同步”和“同步失败”。
响铃时 APP 可下发 `control_alarm` 远程停止或稍后提醒，实体功能键仍可离线使用。

`backups/` 保存烧录前读取的开发板内容，不提交到 Git。
