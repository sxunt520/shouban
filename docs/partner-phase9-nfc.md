# 阶段九：NFC 手办识别与角色切换

本阶段是我方补充的业务契约，供合作方参考实现，并非原有两份文档已经定义的能力。沿用 OTA 选择的 WebSocket 或 MQTT 控制通道，通过 custom 消息上报；无需改动 Opus 音频格式。

## 行为与账号归属

- 标签绑定按“当前账号 + UID”保存，同一 UID 在不同账号下可映射不同角色。一个角色可绑定多个 UID；同一账号内改绑到其他角色须先解除原绑定。
- UID 支持 4、7、10 字节十六进制，忽略空格、冒号、横线并统一大写。UID 用于识别手办，不能代替设备认证。
- 放上已绑定标签：切换当前角色，取消旧角色的语音会话及正在执行的主动播报；后续对话和到点提醒使用新角色。
- 放上未知标签：展示未知标签，保留当前角色，等待 APP 绑定。绑定当前已放上的标签时立即应用新角色。
- 取下手办：清除标签识别状态，取消当前语音及主动播报，保留当前角色。不自动播放问候语。
- 解除当前标签绑定：取消当前语音，保留当前角色，标签显示为未匹配。账号绑定的变更立即作用于本次操作的底座，其他同账号底座在下一次有效读卡或状态上报时应用。
- 未激活绑定账号的设备事件返回 `ignored: true, reason: "unclaimed"`，不应用角色变更，也不关闭用于激活的连接。

旧版本角色表里的全局 `nfcTagUid` 继续服务旧设备；R1M 使用独立账号标签映射，不从旧全局绑定自动匹配。

## APP 接口

以下接口使用当前用户认证，设备须属于该账号，且已启用本地 R1M 联调配置。

| 方法与路径 | 请求或用途 |
| --- | --- |
| `GET /v1/devices/:id/nfc-bindings` | 获取当前账号标签映射 |
| `PUT /v1/devices/:id/nfc-bindings` | `{ "uid": "04A1B2C3D4E5F6", "characterId": "reference-nfc-character" }` |
| `DELETE /v1/devices/:id/nfc-bindings/:uid` | 解除当前账号的该 UID 绑定 |
| `POST /v1/devices/:id/simulator/nfc` | 本地模拟器操作：`{ "present": true, "uid": "04A1B2C3D4E5F6" }` 或 `{ "present": false }` |

设备详情增加 `nfcState`：`present`、`uid`、`lastSeenAt`、`matched`、`characterId`。其中 `nfcState.characterId` 表示标签匹配的角色；设备顶层 `characterId` 表示保留的当前角色，两者在取下手办后可以不同。

## 设备 custom 事件

设备收到 hello 后，使用其返回的当前 `session_id`。放上标签示例：

```json
{
  "type": "custom",
  "session_id": "当前 hello 的 session_id",
  "payload": {
    "eventId": "唯一事件 UUID",
    "type": "nfc_tag_present",
    "payload": {
      "uid": "04A1B2C3D4E5F6",
      "sequence": 1,
      "ts": 1791558000000
    }
  }
}
```

`ts` 示例仅展示格式，发送时须用当前 UTC 毫秒时间。设备应通过 OTA 返回的服务器时间校时；服务端要求时间误差不超过 30 秒。

| 事件 | 业务字段 |
| --- | --- |
| `nfc_tag_present` | `uid`：放上的标签 |
| `nfc_tag_removed` | `uid`：取下的标签，避免旧标签的延迟移除事件清除新标签 |
| `nfc_state` | `present: true` 时需要 `uid`；`present: false` 表示读卡器确认无标签 |

所有事件都需要 `eventId`、`sequence`、`ts`。`eventId` 为 1–80 个字母、数字、下划线或横线，事件之间不可复用。每次新 hello 后序号从 1 开始，当前连接内严格递增，上限为 uint32；旧序号和旧会话不应用。重复事件 ID 不再次执行或新增审计记录，返回当前状态。

重连后读卡器应重新采样，发送新的 `nfc_state`，而不是补发离线期间缓存的放上/取下边沿。读卡状态未知时先不报告“无标签”。当前标签与 `nfc_tag_removed.uid` 不一致时，云端返回 `applied: false`，保留新标签。

云端回执同样走 custom：

```json
{
  "type": "custom",
  "session_id": "当前会话",
  "payload": {
    "type": "nfc_ack",
    "eventId": "对应事件 UUID",
    "payload": {
      "duplicate": false,
      "applied": true,
      "present": true,
      "uid": "04A1B2C3D4E5F6",
      "matched": true,
      "characterId": "reference-nfc-character",
      "switched": true
    }
  }
}
```

发生角色切换或手办取下时，云端先发 `nfc_ack`，随后释放旧语音会话。设备重新 hello 并上报新状态即可，无需重新 BLE 配网或重新绑定账号。`switched` 只表示当前角色是否发生变化，取下手办通常为 false。

HTTP 旁路沿用 `/api/zckj/deviceEventReport` 的设备认证，使用相同 `eventId/type/payload`，另外携带当前 `session_id`。必须已有有效控制会话；旁路也校验序号、时间和归属。

## 本地模拟与交付边界

模拟按钮仅允许私有配置中标记为 SIM 的设备、隔离的 `_mqtt_dev` / `_mqtt_test` 数据库及有效控制会话。APP 请求后云端下发 `simulate_nfc`，独立设备模拟器再上报事件，未直接写入云端 NFC 状态。真实设备不得实现该调试指令。

模拟器保存物理标签状态；新 hello 后重新发送状态快照。本地新增“NFC 联调角色”，使用已有可用的 TTS 配置，方便验证切换；它与“语音联调角色”暂用同一音色，角色身份已区分。自动测试另外使用不同音色，核对切换后新语音确实使用新角色。

迁移 `R1mNfc1791561600000` 新增 `figure_nfc_bindings` 与设备连接序号字段。运行 `npm run db:migrate:mqtt`；本轮已应用于本地隔离数据库。生产启用、真实 NFC 读卡器与卡类型、合作方固件事件实现仍待后续对接。

## 本轮验证（2026-10-09）

- R1M 40 项、旧 MQTT 16 项、参考语音 9 项，共 65 项测试通过；API 和 APP TypeScript 检查通过。
- 覆盖 WebSocket / MQTT NFC 上报、重复事件、过期序号和时间、旧会话、迟到移除事件、跨账号隔离、模拟器限制、切换时取消旧播报以及新角色音色。
- Android 真机操作：UID `04A1B2C3D4E5F6` 绑定到“NFC 联调角色”，后台当前角色确认为 `reference-nfc-character`；模拟取下后 `present=false`，当前角色保留，控制会话自动恢复。
- 本地证据保存在 `.data/verification/r1m-phase9-*`，不作为公开交付文件。
- iOS 采用同一 React Native 界面与接口，没有加入 NFC 原生权限或依赖；本轮未在 iOS 真机验证。Android 操作连接独立设备模拟器，尚未验证真实 NFC 读卡器或实体 4G 网络。
