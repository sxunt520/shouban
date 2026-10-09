# R1M 接入收敛第一轮：OTA / WebSocket v1 / 统一回执

日期：2026-10-09。此轮交付合作方文档语音格式的 **WebSocket 适配器**、独立设备模拟器，以及 APP 直接认领和控制通道状态。上一轮 MQTT/UDP 参考实现继续保留。尚未宣称合作方真 R1M、正式 eFuse 激活或正式 MQTT/UDP 通过验收。

## 已实现

- 新 profile `r1m-v1`，与 `partner-mqtt-sim-v1`、旧 HTTP 设备分开。
- OTA：`POST /v1/partner/r1m/ota`，核对登记 MAC、Client UUID、独立启动凭证和系统身份；返回 `server_time` 与 `websocket.url/token/version=1`。重新获取 OTA 会轮换 token 并撤销旧 WS 连接。token 有效期 6 小时，HTTP/新连接过期后需重新取 OTA；重启 API 后也需重新获取 OTA。
- WS：`/v1/partner/r1m/voice`，升级时验证 `Authorization: Bearer <OTA token>`、`Device-Id`、`Client-Id`、`Protocol-Version: 1`。hello 协商输入 Opus/16kHz/mono/60ms、输出 Opus/24kHz/mono/60ms；每个二进制消息就是一个裸 Opus 包，无 UDP 头或 reference 扩展。
- `listen.start/stop/detect`、`abort`、`goodbye`、`stt`、`tts.start/sentence_start/stop`、失败 `alert`。manual 按 stop 结束；auto/realtime 利用现有实时识别的 SentenceEnd 结束一句，回复后重新监听。显式 abort 或新 listen 可打断旧轮次；目前不实现 TTS 播放期间持续双工音频的自动抢话。
- 复用实际 ASR / AI / TTS / 账号与角色聊天记录；单轮录音上限 10 秒、回复上限 60 秒。文本 detect 直接使用其文本，不声称经过 ASR。自动识别服务不可用时明确报错，不伪造断句或回复。
- 单一音量指令账本经 WS custom 下发，也能经 HTTP 轮询重发；commandId、revision、过期时间保留。旧版本、旧归属、跨设备回执不能改写新意图。成功回执确认执行；只有明确匹配的 volume/revision 报告才改变显示的实际音量。
- 按合作方建议提供 HTTP 旁路：`POST /api/zckj/deviceCommands`、`/api/zckj/deviceCommands/ack`、`/api/zckj/deviceEventReport`。轮询须登记时启用；事件目前只接 cmd_ack。另保留 `/v1/partner/r1m/deviceCommands` 与 `/ack` 同义入口。`since` 是提示，未回执指令始终按相同 ID 重发，设备需去重。
- 连接证据独立于 45 秒旧 HTTP 窗口：已认证 hello 后控制可达；WS ping/pong 检查连接；默认 120 秒无应用层活动释放语音通道。关闭后网络显示待确认，不能据此断言底座断网。后端 MQTT 连接不会令 R1M 在线。
- 上下文监听器可以同时通知 WS 和参考 UDP 服务；换角色、解绑、连接替换、OTA 凭证轮换立即撤销旧语音，迟到的识别/AI/TTS 结果不送给新会话。
- APP 新增“4G / 已联网直接认领”，不调用 BLE 扫描或 Wi-Fi 配置。手填二维码上的 STA MAC 和认领码；相机扫码尚未实现。R1M 展示控制可达、语音状态及云端角色选择。共用 React Native 实现兼顾 Android/iOS；本轮 iOS 未构建或真机验证。

## 接口示例

设备启动系统信息仍按合作方 OTA 文档；**本地 fixture 额外需要启动 Bearer 凭证**，不能据此说合作方现固件已支持这种设备认证。

```json
{"type":"hello","version":1,"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}
```

```json
{"type":"listen","state":"start","mode":"manual","session_id":"<hello 返回值>"}
```

发送一系列裸 Opus 二进制消息，再发送 listen.stop。manual 模拟器和 API 回归均验证该路径。session_id 可省略以兼容文档字段边界；若提供则校验匹配。连接内用服务器轮次代际隔离，换连接使用新的 session_id。

```json
{"type":"custom","session_id":"...","payload":{"cmd":"set_volume","id":"<commandId>","args":{"value":60,"revision":1},"expiresAt":1791540000000}}
```

revision / expiresAt 为我方旁路扩展，需合作方处理器支持。HTTP 事件回执：

```json
{"deviceId":"02:00:00:00:00:03","eventId":"<commandId>","type":"cmd_ack","payload":{"result":"ok","volume":60,"revision":1}}
```

也支持 WS 上行 `custom.payload` 包裹同一事件。HTTP 鉴权同样验证 OTA token、Device-Id 和 Client-Id；body.deviceId 必须匹配该设备。HTTP 旁路须固件新增支持，不能仅部署路由就视为合作方设备已经会使用。

## 本地运行

```bash
npm run dev:partner -- --voice --r1m
npm run test:r1m
npm run test:voice
npm run test:mqtt
npm run typecheck
```

启动脚本只使用隔离的 `*_mqtt_dev` 数据库，自动生成私有 `.data/r1m-devices.json`（权限 0600），新增未绑定的 `R1M-WS-SIM`。二维码认领资料从此文件取，不将设备凭证写入公开文档。不会把参考开发板升级成 R1M 或改写其配置。

独立设备模拟器 `apps/device-simulator/src/r1m.mjs` 不导入后端音频编码实现，直接使用自己的 Opus/WAV 编解码。无参数时保持控制模拟；角色在 APP 设置后模拟器会重连。调试输入在独立进程执行，会替换同一设备原 WS 连接；本地短时独占锁让后台控制模拟器暂缓重连，避免抢走正在处理的语音会话：

```bash
npm run simulate:r1m -- --text="你好"
npm run simulate:r1m -- --wav=/absolute/path/input.wav
```

输入 WAV 需 16kHz 单声道 PCM16、0.1–10 秒。回复保存于 `.data/r1m-simulator/`。这代表模拟设备解码成功，并不代表真实 R1M 扬声器播放成功。

## 验证与边界

`test:r1m` 使用真实 MySQL 隔离库、Nest HTTP/WS 和独立模拟器，ASR/AI/TTS 使用明确测试替身。验证启动认证、OTA 不虚构持续在线、4G 不经过 BLE 的认领、协议头校验、裸 Opus 往返、自动 SentenceEnd、custom/HTTP 两种回执、轮询重复/跨设备/过期或被替代命令、旧连接隔离、打断、角色变化、解绑与 idle close。原 MQTT 与 UDP 参考回归继续通过。

本地登记服务只在 `R1M_DEV_ENABLED=true` 且隔离数据库开启。量产出厂登记、认领凭证摘要与限流、eFuse HMAC 验证资料接入、凭证持久化及多实例部署仍属后续生产接入工作；`ota/activate` 返回 503，不会把模拟 HMAC 当成认证成功。

R1M 正式 mqtt 策略当前明确返回 503，不下发参考 UDP 密钥/nonce 或未确认的 subscribe_topic。保留可用的 reference MQTT+UDP 联调链路；下一轮继续对齐正式上下行主题、nonce/加密范围、方向策略和 Broker 每设备连接事件。双方未提供测试向量之前，不能拿我方模拟器自洽作为合作方兼容证明。

仍需合作方校准的 WS 行为：auto/realtime 监听与 VAD/打断策略、idle 后何时重建通道、OTA 下发新配置时清理旧 NVS 的规则。完整业务能力和 MCP 工具尚不假设存在。BLE 继续兼容现文档，量产保护层需共同实现。


## 本轮实测记录

- `npm run test:r1m`：13 个场景（TAP 含父组共 14 项）通过；`test:voice`：9 项通过；`test:mqtt`：16 项通过；API 与 APP typecheck 和 diff 空白检查通过。
- 华为 Android 8 真机 `com.yuzhou.shouban`：在新界面选择 4G/已联网模式，手填开发认领凭证，成功确认云端并绑定 R1M-WS-SIM；通过手机选择云端角色；手机界面提交 74% 音量，设备模拟器 custom 执行 + HTTP event 回执后，APP/后端均确认实际音量 74%。这些验证使用模拟底座，并不证明真实 4G 模组已验收。
- 真实 provider 路径：沿用上阶段 16kHz/2.82 秒合成录音，经独立模拟器编码为 47 个裸 Opus 上行包；实际 ASR 返回“嗨我是手办语音助手。”；实际 AI 回复“你好呀，很高兴认识你！”；TTS 使用开发联调角色 cosyvoice-v3-flash / longanyang，独立设备解码 47 个 24kHz 下行包并保存 WAV。原业务配置和原克隆音色没有修改；未使用真人麦克风或真实底座扬声器。
- 实体参考开发板重连后持续在线，现有音量保持 63%，没有重新刷写固件或覆盖用户设置。
- 私有证据：`.data/verification/r1m-phase4-service-result.json`、`r1m-phase4-phone.png`、`r1m-provider-roundtrip.log`、`r1m-phase4-provider-evidence.txt`、`r1m-phase4-reply.wav`。服务结果只含用户可读取的设备/聊天信息，不包含启动或通道密钥。


2026-10-09 后续更新：用户同意由我方先制定缺失契约。新增 [公司 R1M 联调协议提案 v1](company-r1m-proposal-v1.md)，开发模式现已实现 HMAC 激活和 MQTT/UDP，不再一律返回 503；本文原有“待补齐”描述保留为阶段历史，合作方现固件兼容性仍待评审。
