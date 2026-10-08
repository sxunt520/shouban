import { randomBytes } from 'node:crypto';

export const ALARM_COS_PREFIX = 'jh_chat/alarms';

function pad(value: number) {
  return String(value).padStart(2, '0');
}

/**
 * 闹钟音频在 COS 中的固定对象路径：
 * jh_chat/alarms/年月日/毫秒时间戳_密码学随机串.扩展名
 *
 * 文件名不包含用户输入或业务名称，既避免中文路径兼容问题，也防止
 * 同一时间上传的对象发生碰撞。
 */
export function buildAlarmCosObjectKey(
  extension = 'wav',
  now = new Date(),
) {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const safeExtension = extension.replace(/^\.+/, '').toLowerCase() || 'wav';
  const opaqueName = `${now.getTime()}_${randomBytes(16).toString('hex')}`;

  return `${ALARM_COS_PREFIX}/${date}/${opaqueName}.${safeExtension}`;
}

export function isOpaqueAlarmCosObjectKey(key: string, extension?: string) {
  const escapedPrefix = ALARM_COS_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedExtension = extension
    ? extension.replace(/^\.+/, '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : '[a-z0-9]+';
  return new RegExp(
    `^${escapedPrefix}/\\d{8}/\\d{13}_[a-f0-9]{32}\\.${escapedExtension}$`,
  ).test(key);
}
