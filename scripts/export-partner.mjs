import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceFingerprint } from './partner-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const parent = resolve(root, '.data/partner-delivery', stamp);
const name = 'shouban-r1m-reference';
const destination = resolve(parent, name);
const files = [];
// Explicit public source roots: never walk the workspace, private fixtures, or build directories.
const directories = ['apps/api/src', 'apps/api/scripts', 'apps/mobile/src', 'apps/mobile/assets', 'apps/device-simulator/src', 'apps/device-simulator/test'];
const single = ['package.json', 'package-lock.json', '.gitignore', 'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json', 'apps/api/nest-cli.json', 'apps/mobile/package.json', 'apps/mobile/tsconfig.json', 'apps/mobile/App.tsx', 'apps/mobile/app.json', 'apps/mobile/babel.config.js', 'apps/mobile/index.js', 'apps/device-simulator/package.json', 'apps/device-simulator/README.md', 'config/mqtt-devices.json', 'config/mqtt-local.env.example', 'config/r1m-proposal-vectors.json', 'docs/partner-handoff.md', 'docs/partner-acceptance.md', 'docs/company-r1m-proposal-v1.md', 'docs/r1m-confirmed-integration.md', 'docs/partner-phase4-r1m-ws.md', 'docs/partner-phase6-business.md', 'docs/partner-phase7-app-speech.md', 'docs/partner-phase8-cloud-reminders.md', 'docs/partner-phase9-nfc.md'];
async function copy(path) {
  const info = await lstat(resolve(root, path));
  if (!info.isFile()) throw new Error(`Only regular public files allowed: ${path}`);
  const target = resolve(destination, path); await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, path), target);
  files.push({ path, bytes: info.size, sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
}
async function walk(path) {
  for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name)) throw new Error(`Unexpected private/generated entry: ${path}/${entry.name}`);
    const next = `${path}/${entry.name}`;
    if (entry.isDirectory()) await walk(next); else await copy(next);
  }
}
await mkdir(destination, { recursive: true });
for (const path of single) await copy(path);
for (const path of directories) await walk(path);
for (const entry of await readdir(resolve(root, 'scripts'))) if (entry.endsWith('.mjs')) await copy(`scripts/${entry}`);
// Generate neutral examples instead of copying machine-local provider or network settings.
await writeFile(resolve(destination, '.env.example'), 'PORT=3000\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USERNAME=root\nDB_PASSWORD=\nDB_DATABASE=shouban_mqtt_dev\nDB_SYNCHRONIZE=true\n');
await writeFile(resolve(destination, 'apps/mobile/.env.example'), 'EXPO_PUBLIC_API_BASE_URL=http://<computer-LAN-IP>:3000\n');
await writeFile(resolve(destination, 'README.md'), '# R1M 联调参考交付包\n\n先阅读 [合作方对接入口](docs/partner-handoff.md)，然后执行 `npm ci` 和 `npm run accept:partner`。\n\n仅包含我方公开参考源码、开发配置、测试向量及验收汇总；设备私有凭证在接收方首次启动时独立生成。真实 BLE、扬声器、4G、NFC 和 iOS 验收见 [验收清单](docs/partner-acceptance.md)。\n');
const latest = JSON.parse(await readFile(resolve(root, '.data/partner-acceptance/latest.json')));
if (latest.status !== 'passed' || !/^[0-9TZ-]+$/.test(latest.directory)) throw new Error('先运行 npm run accept:partner，须本地契约验收通过后再导出');
const report = JSON.parse(await readFile(resolve(root, '.data/partner-acceptance', latest.directory, 'report.json')));
if (report.status !== 'passed' || report.scope !== 'local-contract') throw new Error('Invalid acceptance report');
if (report.sourceFingerprint !== await acceptanceFingerprint(root)) throw new Error('验收后源码已变化，请重新运行 npm run accept:partner');
await mkdir(resolve(destination, 'acceptance'), { recursive: true });
for (const format of ['json', 'md']) await copyFile(resolve(root, '.data/partner-acceptance', latest.directory, `report.${format}`), resolve(destination, 'acceptance', `report.${format}`));
// Hash every final bundled file, including generated examples and the public report.
files.length = 0;
async function inventory(path = '') {
  for (const e of await readdir(resolve(destination, path), { withFileTypes: true })) {
    const next = path ? `${path}/${e.name}` : e.name;
    if (e.isDirectory()) await inventory(next);
    else { const data = await readFile(resolve(destination, next)); files.push({ path: next, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }); }
  }
}
await inventory(); files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(resolve(destination, 'delivery-manifest.json'), JSON.stringify({ schemaVersion: 1, contract: 'company-r1m-proposal-v1', createdAt: new Date().toISOString(), acceptanceFinishedAt: report.finishedAt, hardwareAcceptance: 'not_run', files }, null, 2));
const archive = resolve(parent, `${name}.tar.gz`);
const tar = spawnSync('tar', ['-czf', archive, '-C', parent, name], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
if (tar.error || tar.status !== 0) throw new Error('Archive generation failed');
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
console.log(`交付包：${archive}\nSHA-256：${digest}\n清单：${resolve(destination, 'delivery-manifest.json')}`);
