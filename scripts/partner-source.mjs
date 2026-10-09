import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Inputs affecting acceptance. Documentation and runtime credentials are deliberately excluded.
export async function acceptanceFingerprint(root) {
  const files = ['package.json', 'package-lock.json', 'apps/mobile/App.tsx', 'apps/mobile/tsconfig.json', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json', 'config/mqtt-devices.json', 'config/r1m-proposal-vectors.json'];
  async function walk(path) {
    for (const e of await readdir(resolve(root, path), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) await walk(`${path}/${e.name}`);
      else if (e.isFile()) files.push(`${path}/${e.name}`);
      else throw new Error(`Unexpected acceptance input: ${path}/${e.name}`);
    }
  }
  for (const path of ['apps/api/src', 'apps/mobile/src', 'apps/device-simulator/src', 'apps/device-simulator/test', 'scripts']) await walk(path);
  const digest = createHash('sha256');
  for (const path of files.sort()) digest.update(path).update('\0').update(createHash('sha256').update(await readFile(resolve(root, path))).digest()).update('\0');
  return digest.digest('hex');
}
