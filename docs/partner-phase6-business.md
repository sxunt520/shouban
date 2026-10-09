# 阶段六：定位底座业务闭环

日期：2026-10-09。基于公司 R1M 协议提案 v1 增加 `identify_device`，用于演示 APP → 云端 → 设备 → 回执。该指令由我方提出，合作方需要确认灯效实现；模拟器执行日志与持久化计数，不代表实体 R1M 已闪灯。本轮没有刷写开发板。

## APP 与云端

登录后 `POST /v1/devices/<设备业务 ID>/identify`，无业务请求 body。服务器校验归属，只允许已开启 R1M 开发接入的底座。返回指令账本记录；等待中的重复请求复用同一 ID。默认 15 秒执行有效期，超时可以重新发起。与音量 revision 分开，设置音量不会取消定位。

`GET /v1/devices/<ID>` 新增 `identifyCommand`：`id/status/errorMessage/completedAt`。APP 显示等待、已发送、执行成功、失败、超时或取消；成功只来自设备有效回执。状态沿用 `pending/dispatched/succeeded/failed/expired/cancelled`。账号解绑取消待执行指令，旧账号指令不能由新归属确认。

## 设备 custom 契约

WS 与 MQTT 使用同一业务格式，hello 后的控制消息携带当前 session_id：

```json
{"type":"custom","session_id":"<当前会话>","payload":{"cmd":"identify_device","id":"<commandId>","args":{"pattern":"blink","count":3,"intervalMs":300},"expiresAt":1791550000000}}
```

本版固定三次闪灯，间隔 300ms。合作方落实指示灯位置、亮灭时序以及硬件能力；不具备该功能时返回 error，不伪造成功。设备检查有效期并按 commandId 去重，重复投递仅重发已有执行结果。模拟器持久化最近 100 个指令 ID 和定位累计执行次数，重连恢复去重记录。

成功回执：

```json
{"type":"custom","session_id":"<当前会话>","payload":{"eventId":"<commandId>","type":"cmd_ack","payload":{"result":"ok","pattern":"blink","count":3,"executed":true}}}
```

失败回执使用 `result:error`，附 `error` 原因。成功必须明确携带 pattern/count/executed，空结果不能把账本标成成功。

HTTP 补发沿用 `/api/zckj/deviceCommands`；args 与 custom 完全一致。`/api/zckj/deviceCommands/ack` body：

```json
{"deviceId":"<STA MAC>","id":"<commandId>","status":"ok","result":{"pattern":"blink","count":3,"executed":true}}
```

也支持 `/api/zckj/deviceEventReport` 的 cmd_ack 事件。设备身份、Bearer 通道凭证和归属校验沿用 [协议提案](company-r1m-proposal-v1.md)。回执按设备和指令 ID 关联，过期与取消的请求不能重新成功。

## 运行与验证

```bash
npm run db:migrate:mqtt
npm run dev:partner -- --voice --r1m
npm run test:r1m
npm run test:mqtt
npm run test:voice
npm run typecheck
```

关闭 schema synchronize 的部署使用新增 `R1mIdentify1791547200000` 迁移，保留现有 enum 成员与指令历史；本地隔离 `shouban_mqtt_dev` 已运行迁移。未修改生产数据库。

本轮验证：

- R1M 回归 25 项通过，包括 WS custom、MQTT、HTTP 补发、重复点击、重复投递、音量并行、归属拒绝、过期重试及缺少执行结果的回执。
- 旧 MQTT 回归 16 项、参考语音回归 9 项通过；APP 与后端类型检查通过。
- Android 真机选中 MQTT/UDP 联调底座并点击“定位底座”，APP 显示“设备已确认执行”；模拟设备累计执行一次，音量仍为 78%。
- iOS 使用共享 React Native 按钮和接口代码，本轮未实测。

私有验证记录：`.data/verification/r1m-phase6-tests.tap`、`r1m-phase6-identify-result.json`、`r1m-phase6-android-identify.png`。合作方交付资料包括本文、协议提案、测试向量和独立模拟器；私有密钥及用户音频不随资料提供。

后续业务可按同一账本扩展灯效设置、提醒播放和 NFC 事件；涉及合作方硬件的能力需先明确实现与回执语义。
