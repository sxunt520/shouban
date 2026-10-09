import { spawn } from 'node:child_process';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceFingerprint } from './partner-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const parent = resolve(root, '.data/partner-acceptance');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve(parent, stamp);
const lock = resolve(parent, 'running.lock');
await mkdir(parent, { recursive: true });
try {
  const handle = await open(lock, 'wx', 0o600);
  await handle.writeFile(String(process.pid)); await handle.close();
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  console.error('已有验收运行或遗留锁。检查 .data/partner-acceptance/running.lock 对应进程；确认停止后再删除锁重试。');
  process.exit(1);
}
await mkdir(directory, { recursive: true });
const report = { schemaVersion: 1, contract: 'company-r1m-proposal-v1', startedAt: new Date().toISOString(), scope: 'local-contract', providerMode: 'ASR/LLM/TTS test doubles; real MySQL/MQTT/WS/UDP', checks: [], manual: [
  { id: 'ble-wifi', status: 'not_run', reason: '需要真实合作方固件与手机，包含失败重试、通知及重启后认领' },
  { id: 'real-speaker', status: 'not_run', reason: '模拟器解码 WAV 不证明扬声器实际播放及停止' },
  { id: 'cellular-network', status: 'not_run', reason: '需要真实 4G、NAT、弱网及网络切换' },
  { id: 'physical-nfc', status: 'not_run', reason: '需要真实读卡器，验证放上、取下与快速换卡' },
  { id: 'ios', status: 'not_run', reason: '本机无法开展 iOS 真机验收' },
  { id: 'production', status: 'not_run', reason: '生产 TLS、出厂激活、凭证持久化与多实例部署未包含在本地验收' },
] };
let active, interrupted = false;
function kill(signal) {
  if (!active) return;
  try { if (process.platform === 'win32') active.kill(signal); else process.kill(-active.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
const interrupt = () => { interrupted = true; kill('SIGTERM'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
async function run(id, args, tap = false) {
  if (interrupted) { report.checks.push({ id, status: 'not_run', reason: '验收被中断' }); return false; }
  console.log(`[验收] ${id}`);
  const started = Date.now(), logPath = resolve(directory, `${id}.log`);
  const log = await open(logPath, 'wx', 0o600);
  let output = '', timedOut = false, force;
  const child = active = spawn(process.execPath, args, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const record = data => { output += data.toString(); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 5000); }, 180000);
  const result = await new Promise(done => {
    child.once('error', () => done({ code: null, signal: 'SPAWN_ERROR' }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer); clearTimeout(force); active = undefined;
  await log.writeFile(output); await log.close();
  const count = name => { const m = output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm')); return m ? Number(m[1]) : null; };
  const cases = tap ? [...output.matchAll(/^\s*(not ok|ok)\s+\d+\s+-\s+(.+)$/gm)].map(m => ({ name: m[2], status: m[1] === 'ok' ? 'passed' : 'failed' })) : [];
  const totals = tap ? { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled') } : undefined;
  const validTap = !tap || (totals.tests > 0 && totals.failed === 0 && totals.cancelled === 0 && totals.skipped === 0 && totals.passed === totals.tests);
  const passed = result.code === 0 && !timedOut && !interrupted && validTap;
  report.checks.push({ id, status: passed ? 'passed' : 'failed', exitCode: result.code, signal: result.signal, timedOut, durationMs: Date.now() - started, log: `${id}.log`, ...(totals ? { totals, cases } : {}) });
  console.log(`[${passed ? '通过' : '失败'}] ${id}${totals ? ` (${totals.passed ?? 0}/${totals.tests ?? 0})` : ''}`);
  return passed;
}
try {
  report.sourceFingerprint = await acceptanceFingerprint(root);
  await run('api-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/api/tsconfig.json']);
  await run('app-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/mobile/tsconfig.json']);
  const built = await run('api-build', ['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.build.json']);
  const groups = [ ['r1m', 'r1m.test.mjs', 'r1m-mqtt.test.mjs'], ['legacy-mqtt', 'integration.test.mjs'], ['reference-voice', 'voice.test.mjs'] ];
  for (const [id, ...files] of groups) {
    if (built) await run(id, ['--test', '--test-reporter=tap', ...files.map(f => `apps/device-simulator/test/${f}`)], true);
    else report.checks.push({ id, status: 'not_run', reason: 'API 编译失败，未使用旧构建测试' });
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.sourceUnchanged = !!report.sourceFingerprint && report.sourceFingerprint === await acceptanceFingerprint(root);
  report.status = !interrupted && report.sourceUnchanged && report.checks.length === 6 && report.checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
  report.hardwareAcceptance = 'not_run';
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const total = report.checks.reduce((n, c) => n + (c.totals?.tests || 0), 0);
  const lines = ['# R1M 本地契约验收报告', '', `开始：${report.startedAt}；结束：${report.finishedAt}（UTC）`, '', `契约：\`${report.contract}\`；本地结果：**${report.status}**；测试计数：${total}（含 Node 父级测试）。`, '', '真实 MySQL / MQTT / WebSocket / UDP；ASR、AI 和 TTS 使用测试替身。此报告不代表硬件或生产验收通过。', '', '| 检查 | 结果 | 测试通过/总数 |', '| --- | --- | --- |', ...report.checks.map(c => `| ${c.id} | ${c.status} | ${c.totals ? `${c.totals.passed}/${c.totals.tests}` : '—'} |`), '', '## 自动测试明细', ...report.checks.filter(c => c.cases).flatMap(c => ['', `### ${c.id}`, '', ...c.cases.map(x => `- ${x.status}: ${x.name}`)]), '', '## 待人工验收', '', ...report.manual.map(x => `- ${x.id}: ${x.status} — ${x.reason}`), '', '详细日志仅保存在本地，交付包只包含 JSON / Markdown 汇总。'];
  await writeFile(resolve(directory, 'report.md'), lines.join('\n') + '\n', { mode: 0o600 });
  await writeFile(resolve(parent, 'latest.json'), JSON.stringify({ directory: stamp, status: report.status, finishedAt: report.finishedAt }, null, 2), { mode: 0o600 });
  await unlink(lock);
  process.exitCode = report.status === 'passed' ? 0 : 1;
  console.log(`报告：${resolve(directory, 'report.md')}`);
}
