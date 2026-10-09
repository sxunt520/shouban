import { createLocalBroker } from '../apps/device-simulator/src/broker.mjs';
import { localEnvironment } from './local-environment.mjs';
const env = localEnvironment();
const runtime = await createLocalBroker({ env, host: env.LOCAL_MQTT_HOST || '127.0.0.1' });
let closing = false;
const stop = async () => { if (closing) return; closing = true; await runtime.close(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
