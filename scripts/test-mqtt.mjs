import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { projectRoot } from './local-environment.mjs';

async function run(args) {
  const child = spawn(process.execPath, args, { cwd: projectRoot, stdio: 'inherit' });
  await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`MQTT check failed (${code})`)));
  });
}
try {
  await run([resolve(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', 'apps/api/tsconfig.build.json']);
  await run(['--test', 'apps/device-simulator/test/integration.test.mjs']);
} catch (error) { console.error(error.message); process.exitCode = 1; }
