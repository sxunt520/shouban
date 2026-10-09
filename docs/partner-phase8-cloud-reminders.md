# 阶段八：R1M 云端定时提醒

日期：2026-10-09。基于 [APP 主动播报](partner-phase7-app-speech.md)，到点按当前角色声音朗读提醒。支持一次性、每天重复、编辑、暂停、启用和删除。设备仍接收既有 play_audio 与 Opus 流，不要求实现本地时钟或离线闹钟。

## APP 与 API

登录后沿用 `/v1/reminders`：POST 创建、GET 列表；`PATCH /<id>` 修改；`DELETE /<id>` 删除。创建示例：

```json
{"deviceId":"<业务设备 ID>","title":"喝水休息一下","scheduledAt":"2026-10-10T02:00:00.000Z","repeat":"daily","kind":"reminder"}
```

scheduledAt 是 ISO 时间。APP 展示和输入北京时间 YYYY-MM-DD HH:mm:ss，转换为带明确时区的时间后提交；输入内容 1–80 字，时间必须在未来。repeat 为 none 或 daily。每日重复按北京时间同一时刻推进，即固定 24 小时；补过多天时直接推进到下一次未来时刻，不逐日补播。

R1M 本阶段仅允许 kind=reminder。云端断开、服务器未运行或设备控制会话未打开时，不能保证到点执行。支持创建时暂未联网或暂未选角色，到点会明确记录未执行原因。重新启用已过期提醒需重新设置未来时间；APP 的“重新设置”会打开编辑表单，默认提供一分钟后的时间，保存后才启用。

GET 列表新增 execution（没有调度过时为 null）：

```json
{"occurrenceAt":"2026-10-09T14:44:23.000Z","commandId":"<id>","status":"succeeded","phase":"finished","message":null,"completedAt":"..."}
```

一次性提醒到点后 enabled=false，但执行结果仍显示。daily 的 scheduledAt 推进至下次，而 execution 记录最近一次实际调度。succeeded 必须来自设备播放完成回执；pending/dispatched/failed/cancelled/expired 沿用播报账本，skipped 表示本次未创建播放任务。APP 页面只展示当前选择设备的提醒。

## 调度与去重

每秒检查到期提醒。R1M 调度在一个数据库事务中按设备、提醒顺序加行锁，重新检查 enabled 与 scheduledAt，再同时推进下次时间并创建 speak_text 账本。重复调度进程或请求竞争不会把同一次提醒创建两遍。播放任务 payload 内保存 reminderId、occurrenceAt、角色快照，账本历史保留；提醒表只保存最近一次关联。

调度策略：

| 到点情况 | 处理 |
|---|---|
| 控制会话可达、有角色、没有待播报任务 | 创建任务，文本为“提醒一下，<内容>” |
| WS/MQTT hello 控制会话未打开 | skipped，不补播；Broker 网络在线证据不能代替控制会话 |
| 无角色 | skipped，说明未选择角色 |
| 有另一个 APP/提醒播报任务 | skipped，不叠加也不复用他人的指令 |
| 调度已晚于计划时间超过 30 秒 | skipped，推进每日时间或关闭一次性提醒 |
| 设备归属变化 | skipped 并关闭该提醒，避免旧账号的每日任务继续尝试 |

已创建任务要求计划时间后 30 秒内开始发送音频；待执行任务超过这个窗口会 expired，TTS 生成超过窗口会 failed，不晚到补播。实际播放及完成回执仍有 120 秒任务期限。开始后沿用上一阶段的最大 60 秒音频、轮次取消和停止语义。

TTS/传输失败不自动补播；已下发的播报在 API 重启后取消。服务恢复时发现过期调度只记录未执行，不突然播出积压提醒。这里的去重针对同一调度事务和同一 commandId，不声称物理设备在任意掉电时都能提供严格的只播放一次保证。

## 编辑、暂停、删除和停止

编辑内容、时间或重复规则，暂停，以及删除提醒，会在事务中取消它关联的未完成播报，再要求对应设备停止该 commandId。不会停止同设备其他无关 APP 播报。删除提醒保留指令执行历史。旧归属账号不能编辑或启用设备提醒，但可删除自己遗留的记录。

暂停每日提醒会停止当前播报并关闭未来调度。一条一次性提醒到点后虽然已关闭，APP 在执行期间仍提供“停止本次播放”，对应 PATCH enabled=false。也可通过设备页已有停止播报入口停止当前音频。

提醒编辑保留上一轮 execution，方便看到历史结果；保存未来时间后下一次到点会更新。当前 API 列表只提供最近一次，完整历史在 speak_text 账本，通过设备 commands 记录关联 reminderId 查看。

## 数据库与运行

新增 ReminderEntity 字段：lastRunStatus、lastRunReason、lastCommandId、lastOccurrenceAt。已有提醒和旧设备路径保留。新增迁移 `R1mCloudReminder1791558000000` 支持关闭 schema synchronize 的部署；本轮仅在隔离开发数据库运行，未操作生产数据库。

```bash
npm run db:migrate:mqtt
npm run dev:partner -- --voice --r1m
npm run test:r1m
npm run test:mqtt
npm run test:voice
npm run typecheck
```

## 本轮验证

- R1M 35 项、旧 MQTT 16 项、参考语音 9 项通过，共 60 项；后端和 APP 类型检查通过。
- 验证并发调度只创建一次、设备回执后完成、离线不补播、过期每日推进、编辑/暂停/删除取消关联任务、忙碌不叠加、删除跳过的提醒不停止无关 APP 播报，以及归属变化关闭每日任务。
- Android 真机在 MQTT/UDP 底座创建“喝水休息一下”，15 秒后实际执行 TTS，模拟设备解码 60 个经过认证的 Opus 帧，列表显示“最近一次：播放完成”。随后将该提醒编辑为每天重复并暂停，避免留着每日自动播报。
- 私有结果、截图与回复 WAV 在 `.data/verification/r1m-phase8-*`。模拟解码不代表实体扬声器验收；本轮没有刷写底座，真实 4G、合作方固件和 iOS 暂未实测。

后续可以对接设备本地离线闹钟、真实播放生命周期和 NFC 事件。云端提醒不会假定设备已经有本地闹钟存储能力。
