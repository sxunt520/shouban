# MQTT 第一轮联调

本轮已实现：APP 选择 A/B → API 持久化音量命令 → MQTT 下发 → 独立模拟设备执行 → MQTT 回执 → APP 显示实际音量和执行结果。旧 HTTP 设备入口保留。

`partner-mqtt-sim-v1` 是我们定义的开发协议。合作方文档描述了 MQTT 通道及 custom 消息思路，但下面的 Topic、命令参数、ACK、状态和在线租约均未经过合作方实机确认。模拟器通过只证明当前开发协议的闭环，不代表已经适配其正式固件。

## 1. 启动

需要 Node.js 20+ 和可连接的 MySQL/MariaDB。Broker 使用项目内的 Aedes，无需安装 Docker 或 Mosquitto。

在项目根目录运行：

```bash
npm ci
npm run dev:partner
```

首次运行自动从 `config/mqtt-local.env.example` 创建忽略提交的 `.env.mqtt.local`，然后创建隔离数据库、编译 API，启动 Broker、API、A/B 两个模拟设备。Ctrl+C 会关闭本次启动的进程。

默认数据库是 `shouban_mqtt_dev`，地址为 `127.0.0.1:3306`，用户名 `root`，密码为空。使用其他数据库账号时先复制示例并修改 `.env.mqtt.local`。一键启动要求库名只含字母、数字、下划线，且以 `_mqtt_dev` 结尾；不会读取复制来的原项目 `.env` 数据库配置。

默认端口：API `3000`；开发 Broker `127.0.0.1:18883`。Broker 仅监听本机回环地址，不对局域网设备提供接入。本地模拟凭证都是公开开发值，不能作为生产凭证。

另一个终端启动 APP：

```bash
npm run dev:mobile
```

APP 使用原有体验账号登录。进入「设备」调试页，可选择模拟底座 A 或 B；连接设置填写 `http://电脑局域网IP:3000`，Web 本机预览可用 `http://127.0.0.1:3000`。手机与电脑须能通过局域网访问 API。

模拟设备会自动绑定体验账号，不需操作旧 BLE 配网。A 初始音量 60%，B 初始音量 40%；重启后恢复 `.data/mqtt-simulator/a.json`、`b.json` 中的物理状态和最近回执，因此初始值只适用于首次运行。

验收操作：选 A，输入 70，点击「设置音量」。先显示等待设备，收到回执后显示实际音量 70%；切换 B，其音量保持原值。输入只修改待提交值，不直接修改设备实际值。

## 2. 异常场景

停止一键启动后，单独启动 Broker + API，不自动启动模拟器：

```bash
npm run dev:partner -- --no-simulator
```

在另一终端选择一种模拟场景：

```bash
# 正常执行，可分别运行 A 和 B
npm run simulate:mqtt -- --device=a
npm run simulate:mqtt -- --device=b

# 拒绝：APP 显示失败和原因，实际音量保持旧值
npm run simulate:mqtt -- --device=a --mode=reject

# 无回执：默认 15 秒后显示超时
npm run simulate:mqtt -- --device=a --mode=timeout

# 前两次丢回执，随后发重复回执；重试同一命令不重复执行
npm run simulate:mqtt -- --device=a --drop-acks=2 --duplicate-acks=true

# 增加执行延迟，观察等待状态
npm run simulate:mqtt -- --device=a --delay-ms=3000
```

同一设备只运行一个实例。Ctrl+C 停止该设备会发送离线事件；再次启动可恢复未过期命令。过期命令不会重连后自动补执行，用户可重新提交。模拟器日志输出设备键、命令 ID、音量和执行次数，不输出连接密码。

自动化验收：

```bash
npm run test:mqtt
```

测试动态选择端口，创建独立随机命名的 `_mqtt_test` 数据库，结束后清理测试库和临时状态；不使用原项目业务库。数据库账号需有创建/删除测试库权限。

覆盖 13 个子场景：旧库增量迁移、A/B 隔离与异步执行、拒绝、超时、丢失/重复 ACK、离线重连、过期不重放、API 重启恢复、新旧命令竞争、遗嘱离线、跨设备权限与伪造回执、HTTP 参数/权限/能力限制，以及旧 HTTP 拉取/确认音量。

## 3. 开发协议

身份映射与模拟凭证集中在 `config/mqtt-devices.json`。业务设备 ID 使用原数据库 UUID；MQTT 路由使用独立 externalDeviceId，不能用消息正文中的 deviceId 改变所属设备。

| 设备 | externalDeviceId | clientId |
|---|---|---|
| A | `020000000001` | `shouban-sim-a` |
| B | `020000000002` | `shouban-sim-b` |

默认上行：`shouban/dev/v1/devices/{externalDeviceId}/up`；下行：`shouban/dev/v1/devices/{externalDeviceId}/down`。使用 MQTT 3.1.1、QoS 1；控制命令不 retain。Broker 限制设备只能订阅自己的下行、发布自己的上行。正式 Broker 参数后续单独接入。

云端设置音量（毫秒时间戳仅为样例，模拟时必须使用未来 expiresAt）：

```json
{
  "type": "custom",
  "payload": {
    "cmd": "set_volume",
    "id": "数据库命令UUID",
    "args": { "value": 70, "revision": 1 },
    "expiresAt": 1791417615000
  }
}
```

设备成功回执：

```json
{
  "type": "cmd_ack",
  "eventId": "事件UUID",
  "connectionId": "连接UUID",
  "sequence": 2,
  "ts": 1791417601000,
  "commandId": "数据库命令UUID",
  "status": "ok",
  "result": { "volume": 70, "revision": 1, "executionCount": 1 }
}
```

失败回执用 `status: "error"`、`error: "原因"`，result 保留设备当前 volume/revision。状态消息使用 `type: "status"`，携带相同的事件/连接/顺序/时间字段及 `volume`、`revision`。云端可发送 `type: "status.request"` 主动查询。

模拟设备每 5 秒上报一次状态，默认 30 秒无新状态视为离线；非正常断线通过 MQTT will 发布 `type: "presence", state: "offline"`。这是本地在线管理策略，生产设备是否空闲期间保持 MQTT 连接仍需实机确认。MQTT keepalive 与业务状态上报不是同一机制。

命令状态：`pending` → `dispatched` → `succeeded / failed / expired`；被新请求替代或归属变化时进入 `cancelled`。QoS 发布确认只表示传输成功，不代表执行完成。

API 默认每 2 秒重试同一命令 ID，15 秒过期。模拟器保存最近 256 条回执，重复 ID 重发原回执；revision 防止旧配置覆盖新配置。后端保存事件 ID 去重，并核对 Topic 身份、连接、顺序、命令归属、实际音量和 revision。ACK 丢失时状态上报可能先更新实际音量，但命令仍等待执行回执，不会因此冒充成功。

## 4. 数据库与兼容

原有设备默认 `legacy`；只有显式模拟 fixture 使用 `partner-mqtt-sim-v1`。原 `.env` 和 `firmware` 没有改为 MQTT。关闭 `PARTNER_MQTT_ENABLED` 后不启动 MQTT 连接和派发任务。

新增字段与索引有增量迁移，不删除旧表/数据。需要迁移已有库时，在 `.env.mqtt.local` 明确填写目标库、设置 `MQTT_SIMULATOR_FIXTURES=false` 和 `DB_SYNCHRONIZE=false`，先备份，再运行：

```bash
npm run db:migrate:mqtt
```

脚本会先编译 API，再执行增量迁移；已确认的旧命令补为 succeeded。首次空库开发由 schema sync 建表，迁移脚本面向已有表。回滚应用代码可保留新增字段；迁移 down 不自动删除执行历史。

## 5. 后续对接

下一轮接设备启动配置、身份/认领与合作方自定义 BLE。MQTT 正式 Topic、TLS、凭证、业务命令及 ACK 根据对方确认结果收敛到正式 profile；本地模拟代码可作为讨论参考。

本轮没有实现正式 BLE、MQTT 语音控制、UDP/Opus 音频、NFC、提醒和离线闹钟，也没有验证 Android/iOS 真机。这些功能不会在当前模拟设备上显示为已支持。总体顺序见 `partner-device-integration-plan.md`。
