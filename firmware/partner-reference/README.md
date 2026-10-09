# 合作方协议参考设备

独立 ESP32-S3 目标，用于验证 APP 自定义 BLE 与云端启动/认领及 MQTT 控制。完整说明见 [第二轮联调](../../docs/partner-phase2.md)。

- BLE：ZAOC_ + STA MAC 后六位，无 Service UUID 广播；FF00 / FF01 / FF02 / FF03，开启 FF01 与 FF03 通知后向 FF01 写 scan 或 UTF-8 Wi-Fi JSON。
- Wi-Fi 失败通知 status=0，保留连接；成功提交 NVS、通知 status=1，约两秒后重启；长按 BOOT 五秒重回配网。
- 启动：编译期 bootstrap URL，预登记设备身份和独立参考凭证；返回时间及 MQTT 参数。不是量产 eFuse 激活实现。
- 控制：开发 custom/set_volume、NVS 逻辑音量与 revision、持久化最近命令回执、重复最新 ID 重发结果、旧 revision 拒绝。设备状态每五秒上报，遗嘱离线。
- 本参考构建仅支持本地 MQTT TCP；拒绝把 TLS 配置降级为明文。正式量产需实现匹配的证书校验及配置保护。

`node scripts/prepare-reference.mjs` 从项目根目录生成 main/reference_config.h 后才能编译。头文件含本机设备凭证，不提交，不作为合作方代码交付内容；交付时使用 reference_config.example.h 与双方确定的正式凭证策略。

本轮不驱动屏幕/音频/NFC，不替代原 firmware/main/board_self_test.c。烧录前完整 Flash 备份及恢复方式见联调说明。代码用 NimBLE 实现合作方文档规定的 GATT 服务；对方固件可以继续使用 Bluedroid。
