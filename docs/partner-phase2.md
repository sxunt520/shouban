# 第二轮：设备身份、认领与真实 BLE 配网

## 范围与兼容边界

新增独立 ESP32-S3 参考目标 `firmware/partner-reference`，保留原硬件/音频固件源码。APP 使用 react-native-ble-plx 提供 Android/iOS 共用 GATT 客户端；本轮真机验收只覆盖连接的 Android 手机，iOS 未编译或实机验证。

BLE 遵循合作方文档的 ZAOC_ 广播、厂商数据 `00 01 + Wi-Fi STA MAC`、无服务 UUID 广播、FF00 服务及 FF01/FF03 通知，向 FF01 写 `scan` 或仅含 `ssid/password` 的 UTF-8 JSON。按实际 MTU-3 分包，512 字节上限；接收裸 SSID 时聚合去重，不伪造 RSSI、加密方式或频段。允许手填 SSID 和空密码。

只有 `{"status":"1"}` 确认 Wi-Fi 配置成功。`status=0` 保留连接原地重试；辅助 SUCCESS 文本、普通断连均不冒充成功。参考设备成功后保存 NVS，约 2 秒后断开并重启；失败后继续允许重试。扫描没有结束标记，APP 采用 8 秒收集窗口，属于待合作方确认的客户端策略。

参考固件使用 NimBLE 实现同一 GATT 布局，合作方使用 Bluedroid；此处提供协议参考，不要求他们替换蓝牙栈。FF02 保留可读/可写/可通知的特征布局，但本参考目标只实现 FF01 JSON 写入；密码特征不回读密码。

云端启动接口为 `POST /v1/partner/ota/`，按照文档返回 server_time 与 mqtt 字段。设备身份需预先登记，并使用独立 Bearer 出厂参考凭证鉴权；MAC、Client-Id 或序列号本身不是凭证。`subscribe_topic`、`profile`、`reference_transport` 是我方参考扩展。正式 eFuse HMAC 激活及正式下行主题来源仍待合作方确认，没有把开发鉴权当作他们的量产协议。

BLE 文档没有服务器地址字段，因此 APP 不通过 BLE 发送后端地址。参考固件的配置入口在编译时生成；后续接合作方的 CONFIG_OTA_URL / NVS 约定。

## 运行参考环境

需要 MySQL/MariaDB、Node.js 20+、ESP-IDF 6.1，以及原生 Android 开发构建。

1. 在项目根目录准备真实开发板身份和电脑 LAN 地址：

   ```bash
   node scripts/prepare-reference.mjs --mac=58:e6:c5:6b:9a:54 --host=电脑局域网IPv4
   ```

   脚本生成随机参考凭证、认领码，并打印 ZAOC_ 名称和认领码。忽略提交的 `.data/partner-reference.json` 保存身份；`.env.mqtt.local` 保存隔离联调配置；`firmware/partner-reference/main/reference_config.h` 保存编译期入口和设备凭证。重复运行保留同一板的身份和凭证。

   只在显式 `MQTT_REFERENCE_LAN_ENABLED=true` 时允许开发 Broker 监听指定私网 IPv4。Broker 保持每台设备的用户名、密码、client ID 和 Topic 权限校验。开发板必须能访问电脑所在 LAN；局域网 HTTP / MQTT TCP 仅为本地参考，不作为生产部署配置。

2. 启动 API 和 Broker（不启动软件模拟器冒充实体板）：

   ```bash
   npm run dev:partner -- --no-simulator
   ```

   参考底座预登记为未绑定。A/B 软件 fixture 仍可用，默认 `all` 不会启动一个与真实开发板同身份的模拟器。

3. 编译、烧录独立参考目标：

   ```bash
   export IDF_PATH=/Users/sxunt/Downloads/espressif/.espressif/v6.1/esp-idf
   source "$IDF_PATH/export.sh"
   cd firmware/partner-reference
   idf.py build
   idf.py -p /dev/cu.usbmodem143301 flash monitor
   ```

   串口路径以实际枚举为准。首次进入 ZAOC_ 配网；正常使用后长按 GPIO0/BOOT 约 5 秒重新进入配网。不要按住 BOOT 上电，以免进入 ROM 下载模式。参考固件本轮只做 BLE、Wi-Fi、启动配置和 MQTT 音量状态，不驱动原项目屏幕、扬声器、NFC 或语音。

4. Android APP 必须重建包含 BLE 原生库的 development build，不能用 Expo Go：

   ```bash
   cd apps/mobile
   npx expo prebuild --platform android --no-install
   npx expo run:android
   ```

   Android 6–11 的 BLE 扫描需要定位权限及系统定位服务；Android 12+ 使用蓝牙扫描/连接权限。保持蓝牙开启。iOS 保留对应权限说明、CoreBluetooth 通道与状态处理，但本轮不计入验证。

   手机与电脑跨网段时，APP 可走 USB：

   ```bash
   adb reverse tcp:3000 tcp:3000
   adb reverse tcp:8091 tcp:8091
   EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000 npx expo start --dev-client --port 8091 --localhost
   ```

   USB 转发只解决手机到 API / Metro 的连接，开发板到电脑仍需真实 LAN 网络。

5. APP「设备 → 添加合作方底座」搜索 ZAOC_，连接后收集 Wi-Fi 名称，填写网络、密码和参考认领码。缺少厂商 MAC 时允许手填完整 STA MAC，不使用手机 BLE ID 或广播后六位代替完整身份。正式 QR 认领格式尚未约定，本轮采用显式认领码。

## 身份与状态

- 内部 UUID 用于业务 API；STA MAC 去冒号后用作参考外部身份；Client UUID 与 MQTT client ID 分开保存。
- `POST /devices/claim-status` 使用认领码及完整外部身份查询登记/在线/归属状态，不返回 MQTT 凭证。
- `POST /devices/bind` 对参考设备校验认领码与外部身份，通过事务锁定设备归属，拒绝其他账号抢绑。后端可先认领后联网；APP 配网路径在真实 MQTT 上线后完成绑定。
- `DELETE /devices/:id/binding` 取消未完成指令，保留命令历史；重新认领后旧回执不能完成已取消指令。当前参考 profile 不支持闹钟及音频缓存，生产解绑清除缓存还需对应正式能力。
- APP 分别显示 Wi-Fi、云端、绑定结果。Wi-Fi 已成功但云端/认领失败时，保留仅重试云端确认和绑定入口，不再次发送 Wi-Fi 密码。
- 音量命令在参考板提交 NVS 后回执，表示逻辑音量配置执行；本轮没有测量音频功放输出。

## 调试与回归

`npm run test:mqtt` 在隔离 `_mqtt_test` 库覆盖 15 个子场景，包括第一轮回归、启动凭证/身份校验、认领身份匹配、其他账号冲突及解绑取消/重绑。测试不会触碰原项目业务库。

APP 内置仅 debug 生效的显式真机测试入口：在 app 私有 files 目录放置 `partner-test.json` 才执行；包含 `ssid/password/externalDeviceId/pairingCode/testFailure`。文件读入即删除，日志只打印状态，不打印 Wi-Fi 密码、设备凭证或认领码。测试调用实际 APP BLE 客户端和 API，结果写 `partner-test-result.json`，验证发现、双通知、Wi-Fi 列表、错误密码原地重试、成功通知、设备重启、启动配置、认领和实体音量回执；不得把这些文件提交或放入发布包。

## 备份与恢复

本轮烧录前完整读取了此板的 16MB Flash，保存到忽略提交的 `.data/board-backups/pre-partner-phase2-58e6c56b9a54.bin`，SHA-256 在同目录 `.sha256` 文件。包含旧固件及 NVS；保留在本机，不发给合作方。

要恢复这块板的烧录前状态，在根目录启用 IDF 环境后运行：

```bash
python -m esptool --port /dev/cu.usbmodem143301 --baud 460800 write-flash 0x0 .data/board-backups/pre-partner-phase2-58e6c56b9a54.bin
```

恢复会把测试后的设备配置覆盖为备份时状态。其他板不能使用此 MAC 对应的备份。

## 本机验证记录（2026-10-08）

- Android：已识别并安装到 LND-AL30（Android 8 / API 26），development APK 构建成功；APP 已通过 USB 3000 转发登录并访问设备 API。
- 开发板：ESP32-S3，STA MAC `58:e6:c5:6b:9a:54`；16MB 全量备份及 SHA-256 完成；独立参考目标构建/烧录、写入校验通过，串口确认广播 `ZAOC_6B9A54` 且没有广播 Service UUID。
- 自动化：15 个子场景通过（测试框架计入父用例共 16 项），API/APP 类型检查、代码差异空白检查通过。
- Android 真机闭环通过（23:47）：发现目标广播并解析厂商 MAC，发现 FF00 服务并启用 FF01/FF03 双通知，收到 7 个去重 Wi-Fi 名称；错误密码收到 `status=0`，保留同一 BLE 连接后以 20 字节分包提交正确凭据，收到 `status=1`。底座保存 NVS 并重启，获得局域网 IP，启动配置鉴权及 MQTT 连接成功，账号认领成功，APP 音量 73% 指令由实体板写入 NVS 后回执，云端命令状态 `succeeded`，串口 `revision=1 / executions=1`。
- 重启验证通过：再次硬复位后串口读出 `volume=73 revision=1`，重新启动配置鉴权并连接 MQTT，APP/API 保留音量 73%。
- 真机修复：显式将字节切片重新包装为 Buffer，解决 Hermes 的厂商 MAC 十六进制解析和分包 Base64 编码问题；Android 6–11 保留默认 MTU、按可用 MTU 分包，停止扫描后等待 600ms 再连接，避免这台旧华为系统扫描与连接清理的并发异常。Android 12+ 的 MTU 协商路径未在本轮硬件验证。
- 本机验收证据（忽略提交）：`.data/verification/partner-phase2-physical-result.json`、`partner-phase2-reboot-result.json`、`partner-phase2-phone.png`，以及 `.data/reference-board-test.log` / `reference-board-reboot.log`。
- iOS：持续作为实现目标，暂缓实机验收。共用 BLE 客户端与配网/认领流程，配置蓝牙用途说明；不申请 Android 定位权限，不手动请求 MTU 或操作 CCCD；采用 iOS 系统提供的连接 ID，仅从厂商广播解析业务 MAC，绝不把 CoreBluetooth UUID 当作设备 MAC。权限拒绝提供 iPhone 设置提示。后续变更需同步检查平台分支。尚未编译或实机测试；iPhone 联调需使用手机可访问的后端地址，Android USB 转发的 127.0.0.1 不适用于 iPhone。
- 磁盘：构建时遇到空间不足，已清理本轮 Android 编译中间文件；APK 和完整 Flash 备份保留。
