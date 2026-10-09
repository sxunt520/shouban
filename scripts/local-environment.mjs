import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function localEnvironment({ create = false } = {}) {
  const path = resolve(projectRoot, '.env.mqtt.local');
  if (create && !existsSync(path)) writeFileSync(path, readFileSync(resolve(projectRoot, 'config/mqtt-local.env.example')));
  const config = dotenv.parse(readFileSync(existsSync(path) ? path : resolve(projectRoot, 'config/mqtt-local.env.example')));
  return { ...process.env, ...config, FIGURE_ENV_FILE: path };
}
