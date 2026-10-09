import 'reflect-metadata';
import { createRequire } from 'node:module';
import { DataSource } from 'typeorm';
import { localEnvironment, projectRoot } from './local-environment.mjs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const env = localEnvironment();
const build = spawnSync(process.execPath, [resolve(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', 'apps/api/tsconfig.build.json'], { cwd: projectRoot, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) throw new Error('API build failed before migration');
const require = createRequire(import.meta.url);
const { databaseEntities } = require(resolve(projectRoot, 'apps/api/dist/modules/figure-companion/entities.js'));
const { DeviceIntegration1791417600000 } = require(resolve(projectRoot, 'apps/api/dist/migrations/DeviceIntegration1791417600000.js'));
const { R1mIdentify1791547200000 } = require(resolve(projectRoot, 'apps/api/dist/migrations/R1mIdentify1791547200000.js'));
const { R1mCloudReminder1791558000000 } = require(resolve(projectRoot, 'apps/api/dist/migrations/R1mCloudReminder1791558000000.js'));
const { R1mNfc1791561600000 } = require(resolve(projectRoot, 'apps/api/dist/migrations/R1mNfc1791561600000.js'));
const source = new DataSource({
  type: 'mysql', host: env.DB_HOST, port: Number(env.DB_PORT), username: env.DB_USERNAME,
  password: env.DB_PASSWORD, database: env.DB_DATABASE, charset: 'utf8mb4',
  entities: databaseEntities, migrations: [DeviceIntegration1791417600000, R1mIdentify1791547200000, R1mCloudReminder1791558000000, R1mNfc1791561600000], synchronize: false,
});
try { await source.initialize(); await source.runMigrations({ transaction: 'none' }); console.log(`Migration completed: ${env.DB_DATABASE}`); }
finally { if (source.isInitialized) await source.destroy(); }
