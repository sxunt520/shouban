# 开发板出厂内容备份

烧录自检固件前读取到的出厂分区表：

```text
nvs       0x009000   16K
otadata   0x00d000    8K
phy_init  0x00f000    4K
ota_0     0x020000 4032K
assets    0x410000    8M
ota_1     0xc10000 4032K
```

本项目自检固件只写入 `0x000000`、`0x008000` 和 `0x010000` 附近，
因此备份 `0x000000-0x40ffff` 即覆盖所有会被改写的原始数据，后面的
`assets` 和 `ota_1` 保持在开发板中不变。

二进制备份及 SHA-256 文件不会提交到 Git。

如需恢复，先启用 ESP-IDF 环境，再执行：

```bash
python -m esptool \
  --port /dev/cu.usbmodem143201 \
  --baud 460800 \
  write-flash 0x0 factory-protected-range-0x000000-0x40ffff-20260906.bin
```

恢复时使用开发板上标记为 `USB` 的原生 USB Serial/JTAG 接口。串口设备名
可能在重新插拔后变化。
