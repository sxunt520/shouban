# R1M 接入确认与实施调整（2026-10-09）

本文件记录用户新确认的范围及据此提出的实施方案。它修订后续实施优先级；最新实现见 [R1M 收敛第一轮](partner-phase4-r1m-ws.md)。已实现部分与待合作方实机验收的部分以该阶段记录为准。

## 用户确认与文档边界

| 项目 | 用户确认 / 当前契约 | 我方实施方式 |
|---|---|---|
| 交付机型与网络 | R1M，范围包含 Wi-Fi 和 4G | 从现在开始同时设计两条语音通道，不把产品固化成 MQTT-only |
| 通道配置 | 由 OTA 的 websocket / mqtt 决定 | 配置策略与实际网络类型分开；APP 使用稳定业务 API，不猜测底座走哪条传输 |
| 配网与账号 | BLE 只连接 Wi-Fi，绑定方案由我方先制定 | 设备认证/激活与用户认领分离；4G 设备跳过 Wi-Fi 配网也能认领 |
| 二进制版本 | 用户希望优先 v1，文档 WS 默认 v1 | WS version=1：每个二进制消息承载一个裸 Opus 包；MQTT hello/UDP 格式单独处理 |
| 指令事件 | custom 优先，HTTP 轮询兼容，MCP 预留 | 单一指令账本，经不同适配器派发；不修改语音主流程 |
| 手办能力 | 可先设计并拉通，再给合作方参考 | 角色、NFC、提醒与离线闹钟为明确的业务扩展，不声称已在 R1M 固件实现 |
| BLE 保护 | 用户允许先做兼容方案，后续加强 | 联调先兼容现有明文 JSON；正式发布前增加双方支持的安全层，不能单方改变 FF01 格式 |

文档 MQTT hello 示例 `version=3` 与 WS 二进制 `version=1` 不应混为同一版本号。MQTT+UDP 仍需 `type/flags/payload_len/ssrc/timestamp/sequence` 头及 AES-128-CTR；不能因 WS v1 确认而删除 UDP 头。

现有 WebSocket 设备入口 `/v1/device/conversation/stream` 使用本项目旧 `audio.start` 协议，不能当作合作方 hello/listen 协议入口直接复用。既有 ASR/AI/TTS、Opus codec 可以复用，需新增 R1M WebSocket 适配器。

## OTA 与两种语音传输

逻辑结构：设备登记/激活 → OTA 配置 → R1M WS 或 R1M MQTT+UDP 适配器 → 公共语音会话/ASR/AI/TTS → APP 业务 API。

OTA 组合固件升级、激活、服务器时间与选中通道的连接配置。建议采用每设备的通道策略，返回当前应启用的通道配置；不能仅靠网络为 Wi-Fi/4G 就在 APP 中硬编码通道。配置服务要检查设备能力和固件版本，不能下发无法解析的组合。

需要用对方初始化代码/实机确认同时存在 mqtt/websocket 时的优先级，以及 OTA 更新后旧 NVS 通道配置如何清理或失效。只在新响应里省略旧配置，未必能清除设备已经保存的旧配置。参考配置不要冒充已经验证过切换行为。

R1M WS：按 OTA token 和 Device-Id / Client-Id 鉴权；响应 hello.transport=websocket，version 默认 1；收/发裸 Opus，复用 listen、abort、stt、tts 控制。对会话切换、通道空闲关闭、重连与旧轮次丢弃做独立验收。

R1M MQTT+UDP：OTA 下发 endpoint/client_id/username/password/keepalive/publish_topic，MQTT hello 返回 UDP 参数。已有 reference-udp-opus-v1 是可运行参考实现；其上下行独立密钥、监听 ACK、输入素材消息及包数量字段都是我方扩展，正式接入不能要求未改固件理解它们。正式 codec 需用对方包样例/测试向量校准 nonce、加密范围与方向策略。

建议公司云端管理 Broker、WS/UDP 服务与设备凭证，由 OTA 集中配置。这是我方架构建议，不是用户已确认的 Broker 归属。正式 publish/subscribe 规则必须匹配固件实现；文档仅定义 publish_topic，不应把参考实现的 subscribe_topic 当成 R1M 既有字段。已有云端地址是合作方示例/现配置，不视为我方获准操作或部署该服务。

## 激活与用户认领

建议流程：

1. 出厂登记 R1M 物理身份（STA MAC/序列号）及可信设备认证资料；生成独立的一机一码认领凭证。MAC、广播名和 Client UUID 用于识别，不能作为密码。
2. 用户登录 APP，扫描设备二维码。二维码含设备标识与随机认领凭证，后端只存凭证摘要；限制尝试、校验设备当前归属，认领事务防止两个账号争抢。
3. Wi-Fi 用户按 FF00/FF01/FF03 完成配网；4G 已联网时直接进入云端识别/认领。BLE SSID/password 消息不添加用户 token 或账号信息。
4. 设备 POST OTA，执行设备认证及必要激活；验证成功才发设备通道凭证。APP 通过后端分别显示网络连接、云端已认证、用户认领三个状态。
5. APP 后端核验二维码凭证、可信设备登记/上线状态后绑定账号。必要时增加短时、一次性的设备端物理确认，但这属于后续旁路扩展，现文档未提供该确认消息。
6. 解绑解除账号关系并撤销旧会话、取消旧业务命令；保留硬件登记身份。换主人不沿用旧用户的角色、提醒或音频。是否清 Wi-Fi/SIM 配置属于显式恢复出厂行为，不自动绑定到解绑。

参考阶段可沿用现有独立 bootstrap 凭证和 pairingCode。量产若采用文档 eFuse HMAC，需按 challenge 一次性/过期/防重放设计，并具备对应的服务端验证资料或可信验证服务；不能仅收到 serial_number/hmac 字段就视为验证通过。设备激活与用户认领是不同目的的步骤。

## custom / HTTP / MCP

业务指令先落统一账本，保留 commandId、设备 ID、归属、版本/失效时间、尝试次数和执行回执。默认通过可用通道下发 custom；WS 与 MQTT 使用同一业务 envelope 和不同传输适配器。

custom 仅在固件已经支持该消息处理器、当前控制通道可达时可用。文档说明 WS 通道及 UDP 语音会话可能空闲关闭，不得假设任何时刻都能下发；通道关闭时配置类指令等待或走已启用的 HTTP 轮询。实时语音/过期提醒不在重连后补执行。

HTTP 轮询和文档 5.2 事件上报都需要合作方固件旁路支持。支持这些接口是兼容目标，不能只做后端路由就宣称合作方设备已经使用它们。不同通道回执映射到同一命令，重复拉取、跨通道重发也不能重复执行。

MCP 预留 JSON-RPC 适配器；根据设备握手能力和实际工具列表选择可调用工具，不预设对方已有 NFC/闹钟工具。当前优先 custom，不以 MCP 阻塞联调。

## 在线判断：四种计时不能混用

| 文档项 | 值 / 状态 | 含义 |
|---|---|---|
| HTTP 状态上报 | 每 120 秒；ZAOC_HTTP_REPORT_ENABLE，R1M 默认关闭 | 业务遥测新鲜度；可能没有此上报 |
| WS/语音通道空闲超时 | 120 秒 | 语音会话资源释放，不必然代表底座断网 |
| MQTT keepalive 缺省 | 240 秒，OTA 可配 | Broker 对 MQTT 协议连接的保活机制 |
| MQTT Ping | 文档列 90 秒 | 协议层保活，云端业务订阅未必看到 |

MQTT 用 Broker 的每设备连接/断连事件、连接代际和已配置的遗嘱作为主要连接信号。后端自己的 MQTT client.connected 只证明后端连上 Broker，不能证明某一底座在线；PINGREQ/PINGRESP 也不会像业务 publish 一样送到后端订阅。遗嘱需设备确实配置，文档未承诺它存在。正常 DISCONNECT 不会自动触发遗嘱，因此单靠遗嘱不完整。

MQTT 3.1.1 在非零 Keep Alive 且 1.5 倍周期没有收到客户端控制包时要求断开。若 keepalive=240，可对应约 360 秒；不能因为 HTTP 上报=120 就推导 MQTT keepalive=120。详见 [MQTT 3.1.1](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html)。

WS 用已认证连接、关闭和可用时的 ping/pong 作为通道信号；idle close 单独显示“语音通道未打开”。4G/Wi-Fi 网络在线、控制可达、正在对话及最后状态上报分别保存。缺乏连接/上报证据时显示“待确认/不可达”，不把 OTA 请求一次成功永久当成在线。

若固件启用 120 秒 HTTP 上报，业务遥测可暂用 360 秒过期窗口并配置化。这不覆盖仍由 Broker 确认的在线连接，也不作为所有设备统一离线阈值。

现有代码：旧 HTTP profile 默认 45 秒；partner-mqtt-sim-v1 当前默认 30 秒状态租约、模拟器 5 秒上报。它们是旧设备/开发模拟参数，不能作为正式 R1M 策略。新增 R1M profile 的存在性/可达性判断应独立实现，不直接修改模拟器短周期参数冒充正式兼容。

## BLE 安全实施边界

联调继续兼容 FF01 明文 JSON，保护层作为可协商能力预留。现协议未定义配对鉴权、加密协商或握手消息；APP 单方加 AES/任意封装会让现固件无法解析。随机实现一种加密然后撤换也会制造跨平台兼容和密钥管理返工。

建议设备端优先支持 BLE LE Secure Connections 与受保护 GATT 访问，业务层仍发送同一 JSON，由 Android/iOS 蓝牙栈处理链路加密。身份认证方式结合底座屏幕/按键能力选择：可显示时用确认码/Passkey；无合适交互时可考虑扫码得到一机一密作为经过约定的 OOB/PoP 方案。仅扫描二维码并不会自动让系统配对具备 OOB 认证能力，双方仍需明确实现。

Just Works 可建立加密链路，但不能当成具备 MITM 身份认证。生产前仍要双方落实认证方式；见 [Bluetooth Security Manager](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-54/out/en/host/security-manager-specification.html)。

当前先落实长按进入、配网窗口限定、成功后关闭服务、凭据不打日志及云端独立认领鉴权。短时配网窗口和二维码认领不能替代 Wi-Fi 密码的 BLE 传输保护。联调阶段采用既有未定义加密协议不等于量产安全验收已通过。

## 调整后的开发顺序

下一轮优先完成“R1M 正式接入收敛”，再扩展 NFC/闹钟：

1. 增加 R1M 配置/profile 边界及 OTA 通道策略；保留既有参考 profile，明确激活、登记、认领分工。
2. 实现合作方 WebSocket hello/listen/v1 裸 Opus 适配器，复用现有语音处理，并补 WS 独立模拟器。
3. 对齐 MQTT+UDP 正式 codec 与主题规则，去除正式路径对 reference.* 扩展的依赖。
4. custom 统一派发/执行回执与可达性；接入 Broker 每设备连接证据，并补 HTTP 轮询兼容接口及独立模拟验收。
5. 完成双通道切换、idle close、旧会话隔离、4G 不经 BLE 认领、Android/iOS 公共 API 回归后，再开展角色/NFC/提醒/离线闹钟扩展。

后续最少核对项限定为实施细节：固件通道选择/NVS 更新规则、MQTT 下行订阅实现、UDP nonce/加密测试向量、出厂激活验证资料、custom/HTTP 旁路开关。无需重新询问已经确认的 R1M、4G 范围或双语音通道。


2026-10-09 后续更新：用户同意由我方先制定缺失契约。新增 [公司 R1M 联调协议提案 v1](company-r1m-proposal-v1.md)，开发模式现已实现 HMAC 激活和 MQTT/UDP，不再一律返回 503；本文原有“待补齐”描述保留为阶段历史，合作方现固件兼容性仍待评审。
