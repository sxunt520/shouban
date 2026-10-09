import { ensureR1mFixtures } from './r1m-fixtures.mjs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { localEnvironment, projectRoot } from './local-environment.mjs';

const env = localEnvironment({ create: true });
if (process.argv.includes('--r1m')) ensureR1mFixtures(env);
if (process.argv.includes('--voice') || process.argv.includes('--r1m')) {
  if (process.argv.includes('--voice')) env.PARTNER_VOICE_ENABLED = 'true';
  // Reuse explicitly configured providers without inheriting the production database.
  const providerFile = resolve(projectRoot, '.env');
  if (existsSync(providerFile)) for (const [key, value] of Object.entries(dotenv.parse(readFileSync(providerFile)))) {
    if (/^(AI_|DASHSCOPE_|ALIYUN_NLS_|ALIYUN_ACCESS_KEY_)/.test(key) && env[key] === undefined) env[key] = value;
  }
}
if (!/^[A-Za-z0-9_]+_mqtt_dev$/.test(env.DB_DATABASE)) throw new Error('dev:partner requires an isolated *_mqtt_dev database');
const connection = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD });
await connection.query(`CREATE DATABASE IF NOT EXISTS \`${env.DB_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await connection.end();
const children = new Set();
let closing = false;
function run(command, args, label) {
  const child = spawn(command, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => process.stdout.write(`[${label}] ${bytes}`));
  child.on('exit', (code, signal) => { children.delete(child); if (!closing) { console.error(`${label} stopped (${code ?? signal})`); void stop(code || 1); } });
  return child;
}
async function onceExit(child) {
  await new Promise((resolvePromise, reject) => {
    child.once('error', reject); child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error('Build failed')));
  });
}
async function stop(code = 0) {
  if (closing) return; closing = true;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5000);
  timer.unref();
  await Promise.all([...children].map(child => new Promise(resolvePromise => child.once('exit', resolvePromise))));
  clearTimeout(timer); process.exitCode = code;
}
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
// Compile directly to avoid leaving an orphaned npm/CLI child on shutdown.
const build = spawn(process.execPath, [resolve(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', 'apps/api/tsconfig.build.json'], { cwd: projectRoot, env, stdio: 'inherit' });
await onceExit(build);
run(process.execPath, ['apps/device-simulator/src/broker.mjs'], 'broker');
await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
run(process.execPath, ['apps/api/dist/main.js'], 'api');
if (!process.argv.includes('--no-simulator')) run(process.execPath, ['apps/device-simulator/src/main.mjs', ...(process.argv.includes('--voice') ? ['--voice=true'] : [])], 'sim');
if (process.argv.includes('--r1m') && !process.argv.includes('--no-simulator')) {
  await new Promise(done => setTimeout(done, 4000));
  run(process.execPath, ['apps/device-simulator/src/r1m.mjs'], 'r1m');
  run(process.execPath, ['apps/device-simulator/src/r1m-mqtt.mjs'], 'r1m-mqtt');
}
console.log(`Local integration uses ${env.DB_DATABASE}. APP backend: http://<computer LAN IP>:${env.PORT}/v1`);
