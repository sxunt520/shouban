#!/usr/bin/env bash

set -euo pipefail

mode="${1:-app}"
package_name="${ANDROID_APP_ID:-com.yuzhou.aifigure}"

if ! command -v adb >/dev/null 2>&1; then
  echo "找不到 adb。请先把 Android platform-tools 加入 PATH。" >&2
  exit 1
fi

device_count="$(adb devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')"
if [ "$device_count" -eq 0 ]; then
  echo "没有检测到可用的 Android 真机。请连接 USB，并允许 USB 调试。" >&2
  exit 1
fi
if [ "$device_count" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
  echo "检测到多台 Android 设备。请先设置 ANDROID_SERIAL 后重试。" >&2
  adb devices -l
  exit 1
fi

case "$mode" in
  app)
    app_pid="$(adb shell pidof "$package_name" 2>/dev/null | tr -d '\r')"
    if [ -z "$app_pid" ]; then
      echo "APP 未运行，正在启动 ${package_name} ..."
      adb shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1 >/dev/null
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        app_pid="$(adb shell pidof "$package_name" 2>/dev/null | tr -d '\r')"
        [ -n "$app_pid" ] && break
        sleep 0.3
      done
    fi
    if [ -z "$app_pid" ]; then
      echo "无法启动或定位 ${package_name}，请确认 APP 已安装。" >&2
      exit 1
    fi
    echo "正在查看 ${package_name}（PID ${app_pid}）的前端与原生日志；按 Ctrl+C 退出。"
    exec adb logcat --pid="$app_pid" -v color
    ;;
  crash)
    echo "正在查看 Android crash 缓冲区；复现崩溃后日志会出现在这里，按 Ctrl+C 退出。"
    exec adb logcat -b crash -v color
    ;;
  *)
    echo "未知日志模式：$mode" >&2
    exit 1
    ;;
esac
