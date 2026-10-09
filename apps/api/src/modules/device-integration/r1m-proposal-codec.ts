import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const R1M_UDP_PROPOSAL = 'company-udp-ctr-hmac-v1';
export type AudioDirection = 'up' | 'down';
const keys = (key: Buffer, nonce: Buffer, direction: AudioDirection) => {
  if (key.length !== 16 || nonce.length !== 16) throw new Error('Invalid session key/nonce');
  const material = Buffer.from(hkdfSync('sha256', key, nonce, Buffer.from(`${R1M_UDP_PROPOSAL}/${direction}`), 48));
  return { aes: material.subarray(0, 16), mac: material.subarray(16) };
};
const iv = (nonce: Buffer, sequence: number) => {
  const counter = Buffer.alloc(16); nonce.copy(counter, 0, 0, 8);
  counter.writeUInt32BE(sequence, 8); // Packet counter occupies high bits; low 32 bits are AES block counter.
  return counter;
};
export function encodeProposalAudio(payload: Buffer, key: Buffer, nonce: Buffer, direction: AudioDirection, sequence: number, timestamp: number) {
  if (!payload.length || payload.length > 1275 || !Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff || !Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) throw new Error('Invalid audio frame');
  const header = Buffer.alloc(16); header[0] = 1; header[1] = 1; header.writeUInt16BE(payload.length, 2);
  nonce.copy(header, 4, 4, 8); header.writeUInt32BE(timestamp, 8); header.writeUInt32BE(sequence, 12);
  const k = keys(key, nonce, direction), cipher = createCipheriv('aes-128-ctr', k.aes, iv(nonce, sequence));
  const data = Buffer.concat([header, cipher.update(payload), cipher.final()]);
  return Buffer.concat([data, createHmac('sha256', k.mac).update(data).digest().subarray(0, 16)]);
}
export function decodeProposalAudio(packet: Buffer, key: Buffer, nonce: Buffer, direction: AudioDirection) {
  if (packet.length < 33 || packet.length > 1307 || packet[0] !== 1 || packet[1] !== 1 || packet.readUInt16BE(2) !== packet.length - 32 || !packet.subarray(4, 8).equals(nonce.subarray(4, 8))) throw new Error('Invalid audio envelope');
  const k = keys(key, nonce, direction), data = packet.subarray(0, -16);
  if (!timingSafeEqual(packet.subarray(-16), createHmac('sha256', k.mac).update(data).digest().subarray(0, 16))) throw new Error('Invalid audio authentication');
  const sequence = packet.readUInt32BE(12); if (!sequence) throw new Error('Invalid sequence');
  const cipher = createDecipheriv('aes-128-ctr', k.aes, iv(nonce, sequence));
  return { sequence, timestamp: packet.readUInt32BE(8), payload: Buffer.concat([cipher.update(data.subarray(16)), cipher.final()]) };
}
