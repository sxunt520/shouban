import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { getApiBaseUrl } from './api';

// Debug-only opt-in, never an automatic production conversation.
export async function referenceVoiceSelfTest(token: string, onTrace: (lines: string[]) => void, onSelected: (id: string) => Promise<void>) {
  if (!__DEV__ || !FileSystem.documentDirectory) return;
  const configPath = `${FileSystem.documentDirectory}partner-voice-test.json`;
  if (!(await FileSystem.getInfoAsync(configPath)).exists) return;
  const config = JSON.parse(await FileSystem.readAsStringAsync(configPath)) as { deviceId: string };
  await FileSystem.deleteAsync(configPath);
  const inputPath = `${FileSystem.documentDirectory}partner-voice-input.wav`;
  const lines: string[] = [];
  const trace = (line: string) => { lines.push(line); onTrace([...lines]); console.info(`[VOICE_TEST] ${line}`); };
  const url = `${getApiBaseUrl()}/devices/${config.deviceId}/voice`, headers = { Authorization: `Bearer ${token}` };
  try {
    await onSelected(config.deviceId);
    trace('开始 APP WAV 文件语音联调');
    const upload = await FileSystem.uploadAsync(`${url}/test-audio`, inputPath, { httpMethod: 'POST', uploadType: FileSystem.FileSystemUploadType.MULTIPART, fieldName: 'file', mimeType: 'audio/wav', headers });
    const accepted = JSON.parse(upload.body);
    if (upload.status < 200 || upload.status >= 300) throw new Error(accepted.message || '上传失败');
    trace('Android 文件上传已提交；等待设备与云端处理');
    for (let i = 0; i < 75; i++) {
      const response = await fetch(url, { headers });
      const state = await response.json();
      if (!response.ok) throw new Error(state.message || '读取状态失败');
      if (state.testId === accepted.testId) {
        if (state.state === 'error' || state.state === 'aborted') throw new Error(state.error || '本轮已取消');
        if (state.state === 'completed' && state.audioReady) {
          trace(`UDP 录音 ${state.receivedFrames} 帧；真实 ASR 返回文本`);
          trace(`真实 AI/TTS 生成回复；UDP 下发 ${state.sentFrames} 帧`);
          const audio = await Audio.Sound.createAsync({ uri: `${url}/audio/${state.sessionId}`, headers }, { shouldPlay: false });
          try { const status = await audio.sound.getStatusAsync(); if (!status.isLoaded) throw new Error('回复音频未加载'); }
          finally { await audio.sound.unloadAsync(); }
          trace('手机通过账号鉴权加载 WAV 回复，试听通道就绪');
          trace('PASS：APP 文件 → MQTT/UDP → ASR/AI/TTS → 音频加载闭环通过');
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('语音测试超时');
  } catch (error) { trace(`FAIL：${error instanceof Error ? error.message : '语音联调失败'}`); }
  finally {
    await FileSystem.deleteAsync(inputPath, { idempotent: true });
    await FileSystem.writeAsStringAsync(`${FileSystem.documentDirectory}partner-voice-test-result.json`, JSON.stringify({ lines, at: new Date().toISOString() }));
  }
}
