import aedes from 'aedes';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fixtures, prefix, topics } from './profile.mjs';

export async function createLocalBroker({ env = process.env, port = Number(env.LOCAL_MQTT_PORT || 18883), host = '127.0.0.1', log = console.log } = {}) {
  if (host !== '127.0.0.1' && host !== '::1' && !(env.MQTT_REFERENCE_LAN_ENABLED === 'true' && /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host))) throw new Error('Reference LAN broker requires explicit opt-in and a private IPv4 address');
  const broker = aedes({ heartbeatInterval: 1000 });
  const devices = fixtures(env);
  const r1m = env.R1M_MQTT_PROPOSAL_ENABLED === 'true' ? JSON.parse(readFileSync(env.R1M_FIXTURES_PATH, 'utf8')).filter(f => f.transport === 'mqtt') : [];
  const r1mBase = 'shouban/r1m/v1', connected = new Map();
  const r1mTopic = (mac, direction) => `${r1mBase}/devices/${mac}/${direction}`;
  async function validateR1m(clientId, username, password) {
    const r = await fetch(`${env.R1M_BROKER_API_BASE || `http://127.0.0.1:${env.PORT || 3000}`}/v1/partner/r1m/broker/auth`, { method: 'POST', signal: AbortSignal.timeout(2500),
      headers: { 'Content-Type': 'application/json', 'X-Broker-Token': env.R1M_BROKER_ADMIN_TOKEN }, body: JSON.stringify({ clientId, username, password }) });
    if (!r.ok) throw new Error('R1M authentication rejected'); return r.json();
  }
  function presence(client, online) {
    const identity = client.profileIdentity;
    if (identity?.role !== 'r1m') return;
    if (!online && connected.get(identity.mac) !== identity.connectionId) return;
    if (online) connected.set(identity.mac, identity.connectionId); else connected.delete(identity.mac);
    broker.publish({ topic: `${r1mBase}/broker/devices/${identity.mac}/presence`, qos: 1, retain: true,
      payload: Buffer.from(JSON.stringify({ state: online ? 'online' : 'offline', connectionId: identity.connectionId, ts: Date.now() })) }, () => {});
  }
  const cloudUser = env.PARTNER_MQTT_USERNAME || 'local-cloud';
  const cloudPass = env.PARTNER_MQTT_PASSWORD || 'local-cloud-only';
  broker.authenticate = (client, username, password, done) => {
    const secret = password?.toString();
    const device = devices.find(d => d.username === username && d.password === secret && d.clientId === client.id);
    if (username === cloudUser && secret === cloudPass && client.id.startsWith('figure-cloud-')) client.profileIdentity = { role: 'cloud' };
    else if (r1m.some(f => client.id === `r1m-${f.mac.replaceAll(':', '').toLowerCase()}` && username === f.mac.replaceAll(':', '').toLowerCase())) {
      void validateR1m(client.id, username, secret).then(d => { client.profileIdentity = { role: 'r1m', mac: d.mac, password: secret, connectionId: randomUUID() }; done(null, true); }, () => { const e = new Error('Invalid R1M credentials'); e.returnCode = 5; done(e, false); }); return;
    }
    else if (device) client.profileIdentity = { role: 'device', device };
    else { const error = new Error('Invalid local profile credentials'); error.returnCode = 5; done(error, false); return; }
    done(null, true);
  };
  broker.authorizePublish = (client, packet, done) => {
    const identity = client.profileIdentity;
    if (identity?.role === 'r1m') {
      if (packet.topic !== r1mTopic(identity.mac, 'up') || packet.retain || packet.payload.length > 8192) { done(new Error('R1M publish denied')); return; }
      void validateR1m(client.id, identity.mac, identity.password).then(() => done(null), () => done(new Error('R1M credentials expired'))); return;
    }
    const allowed = identity?.role === 'cloud'
      ? (devices.some(d => topics(d, env).down === packet.topic) || r1m.some(f => r1mTopic(f.mac.replaceAll(':', '').toLowerCase(), 'down') === packet.topic)) && !packet.retain
      : identity?.role === 'device' && topics(identity.device, env).up === packet.topic;
    if (!allowed || packet.payload.length > 8192) { done(new Error('Topic publish denied')); return; }
    if (packet.retain) {
      try {
        const message = JSON.parse(packet.payload.toString());
        if (message.type !== 'presence' || message.state !== 'offline') throw new Error();
      } catch { done(new Error('Only offline presence may be retained in the development profile')); return; }
    }
    done(null);
  };
  broker.authorizeSubscribe = (client, sub, done) => {
    const identity = client.profileIdentity;
    if (identity?.role === 'r1m') {
      const allowed = sub.topic === r1mTopic(identity.mac, 'down');
      if (!allowed) { done(null, null); return; }
      void validateR1m(client.id, identity.mac, identity.password).then(() => done(null, { ...sub, qos: Math.min(sub.qos, 1) }), () => done(null, null)); return;
    }
    const allowed = identity?.role === 'cloud'
      ? (sub.topic === `${prefix(env)}/devices/+/up` || (r1m.length && [`${r1mBase}/devices/+/up`, `${r1mBase}/broker/devices/+/presence`].includes(sub.topic)))
      : identity?.role === 'device' && sub.topic === topics(identity.device, env).down;
    done(null, allowed ? { ...sub, qos: Math.min(sub.qos, 1) } : null);
  };
  broker.on('clientError', client => log(`[broker] rejected client ${client.id}`));
  broker.on('clientReady', client => { presence(client, true); log(`[broker] connected ${client.id}`); });
  broker.on('clientDisconnect', client => { presence(client, false); log(`[broker] disconnected ${client.id}`); });
  const server = createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  log(`[broker] local simulation profile listening on ${host}:${address.port}`);
  return {
    broker, server, port: address.port,
    async close() {
      await new Promise(resolve => broker.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createLocalBroker({ host: process.env.LOCAL_MQTT_HOST || '127.0.0.1' });
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
