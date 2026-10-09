import { fixtures } from './profile.mjs';
import { DeviceSimulator } from './device.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter(s => s.startsWith('--')).map(s => s.slice(2).split('=')));
const selection = args.device || 'all';
const mode = args.mode || 'success';
if (!['success', 'reject', 'timeout'].includes(mode)) throw new Error('mode must be success, reject or timeout');
const selected = fixtures().filter(d => (selection === 'all' && d.autoBind !== false) || d.key === selection);
if (!selected.length) throw new Error('device must be a, b or all');
const simulators = [];
for (const fixture of selected) {
  const simulator = new DeviceSimulator(fixture, {
    mode, delayMs: Number(args['delay-ms'] || 300), dropAcks: Number(args['drop-acks'] || 0),
    duplicateAcks: args['duplicate-acks'] === 'true',
  });
  simulators.push(simulator); await simulator.start();
  if (args.voice === 'true') {
    if (!/^MQTT-SIM-[AB]$/.test(fixture.hardwareId)) throw new Error('Voice fixture cannot impersonate a physical board');
    const { VoiceSimulator } = await import('./voice.mjs');
    simulator.voice = new VoiceSimulator(simulator); await simulator.voice.start();
  }
}
console.log('Development MQTT simulator ready. This profile is pending vendor confirmation.');
let closing = false;
async function stop() { if (closing) return; closing = true; await Promise.all(simulators.map(s => s.stop())); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
