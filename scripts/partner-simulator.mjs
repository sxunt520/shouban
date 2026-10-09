import { spawn } from 'node:child_process';
import { localEnvironment, projectRoot } from './local-environment.mjs';
const child = spawn(process.execPath, ['apps/device-simulator/src/main.mjs', ...process.argv.slice(2)], { cwd: projectRoot, env: localEnvironment(), stdio: 'inherit' });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
