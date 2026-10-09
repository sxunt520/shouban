import { createCipheriv, createDecipheriv } from 'node:crypto';

// Development wire contract. Vendor nonce/encryption details still require test vectors.
export const REFERENCE_VOICE_PROFILE = 'reference-udp-opus-v1';
export const FRAME_MS = 60;
export const MAX_PACKET = 1275;
export function packAudio(payload: Buffer, key: Buffer, nonce: Buffer, sequence: number, timestamp: number) {
  if (!payload.length || payload.length > MAX_PACKET || sequence < 1 || sequence > 0xffffffff) throw new Error('Invalid audio packet');
  const header = Buffer.from(nonce);
  header[0] = 1; header[1] = 0; header.writeUInt16BE(payload.length, 2);
  header.writeUInt32BE(timestamp >>> 0, 8); header.writeUInt32BE(sequence, 12);
  const cipher = createCipheriv('aes-128-ctr', key, header);
  return Buffer.concat([header, cipher.update(payload), cipher.final()]);
}
export function unpackAudio(packet: Buffer, key: Buffer, nonce: Buffer) {
  if (packet.length <= 16 || packet.length > 16 + MAX_PACKET || packet[0] !== 1 || packet[1] !== 0 ||
      packet.readUInt16BE(2) !== packet.length - 16 || !packet.subarray(4, 8).equals(nonce.subarray(4, 8))) throw new Error('Invalid audio header');
  const sequence = packet.readUInt32BE(12);
  if (!sequence) throw new Error('Invalid audio sequence');
  const cipher = createDecipheriv('aes-128-ctr', key, packet.subarray(0, 16));
  return { sequence, timestamp: packet.readUInt32BE(8), payload: Buffer.concat([cipher.update(packet.subarray(16)), cipher.final()]) };
}
export function readPcmWav(wav: Buffer) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('需要 PCM16 单声道 WAV 文件');
  let rate = 0, valid = false, pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > wav.length) throw new Error('WAV 文件不完整');
    const type = wav.toString('ascii', offset, offset + 4);
    if (type === 'fmt ' && size >= 16) {
      valid = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt16LE(start + 14) === 16;
      rate = wav.readUInt32LE(start + 4);
    }
    if (type === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + (size & 1);
  }
  if (!valid || !pcm?.length || pcm.length % 2 || ![16000, 24000].includes(rate)) throw new Error('仅支持 PCM16 单声道、16kHz/24kHz WAV');
  return { rate, pcm };
}
export function opusCodec(rate: number) {
  const { OpusEncoder } = require('@discordjs/opus') as { OpusEncoder: new (rate: number, channels: number) => { encode(pcm: Buffer, size: number): Buffer; decode(opus: Buffer): Buffer } };
  return new OpusEncoder(rate, 1);
}
export function encodePcm(pcm: Buffer, rate: number) {
  const size = rate * FRAME_MS / 1000, codec = opusCodec(rate), frames: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += size * 2) {
    const frame = Buffer.alloc(size * 2); pcm.copy(frame, 0, offset, offset + size * 2);
    frames.push(codec.encode(frame, size));
  }
  return frames;
}
