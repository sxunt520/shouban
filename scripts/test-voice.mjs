import { spawn } from 'node:child_process';
import { projectRoot } from './local-environment.mjs';
async function run(args) {
  const p = spawn(process.execPath, args, { cwd: projectRoot, stdio: 'inherit' });
  await new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', code => code === 0 ? resolve() : reject(new Error(`Voice check failed (${code})`))); });
}
try { await run(['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.build.json']); await run(['--test', 'apps/device-simulator/test/voice.test.mjs']); }
catch (error) { console.error(error.message); process.exitCode = 1; }
