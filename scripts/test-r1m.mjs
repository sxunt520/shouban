import { spawn } from 'node:child_process';
import { projectRoot } from './local-environment.mjs';
for (const args of [['node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.build.json'], ['--test', 'apps/device-simulator/test/r1m.test.mjs', 'apps/device-simulator/test/r1m-mqtt.test.mjs']]) {
  const child = spawn(process.execPath, args, { cwd: projectRoot, stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) { process.exitCode = code || 1; break; }
}
