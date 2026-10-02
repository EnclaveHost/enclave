#!/usr/bin/env node
// Runs beside a Metal CVM or Windows host. The sole upstream is its loopback
// application ingress. TLS stays in the app guest, including attestation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import WebSocket, { createWebSocketStream } from 'ws';
import { TunaHost } from './tuna-host.mjs';

const timeout = () => AbortSignal.timeout(8000);
export function localUpstream(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('upstream must be a loopback HTTP origin');
  return u.origin;
}
export async function run(configFile) {
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const upstream = localUpstream(cfg.upstream);
  const api = new URL(cfg.api || 'https://api.enclave.host');
  if (api.protocol !== 'https:') throw new Error('control API must use HTTPS');
  let key = cfg.operatorKeyFile ? fs.readFileSync(cfg.operatorKeyFile, 'utf8').trim() : '';
  if (cfg.operatorConfigFile) key = JSON.parse(fs.readFileSync(cfg.operatorConfigFile, 'utf8')).registryKey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key || '')) throw new Error('operator signing key unavailable');
  const account = privateKeyToAccount(key); key = null;
  let deployments = [], domains = {}, admitted = {}, stopped = false, publishing = false;
  const sockets = new Set();
  const open = (id, protocol, port) => new Promise((resolve, reject) => {
    const url = upstream.replace(/^http/, 'ws') + `/x/${encodeURIComponent(id)}/${protocol}${port ? '/' + port : ''}`;
    const ws = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    sockets.add(ws); ws.once('close', () => sockets.delete(ws)); ws.on('error', () => {});
    ws.once('error', reject); ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_r, res) => { res.resume(); ws.terminate(); reject(new Error(`local ingress refused ${res.statusCode}`)); });
  });
  const splice = async (socket, id, protocol, port) => {
    const ws = await open(id, protocol, port);
    if (socket.destroyed) { ws.terminate(); return; }
    const stream = createWebSocketStream(ws);
    const close = () => { socket.destroy(); stream.destroy(); ws.terminate(); };
    socket.on('error', close); stream.on('error', close);
    socket.once('close', () => { stream.destroy(); ws.terminate(); });
    stream.once('close', () => socket.destroy());
    socket.pipe(stream).pipe(socket);
  };
  const host = new TunaHost({ config: configFile, binary: cfg.binary || 'enclave-tuna',
    deployments: () => deployments,
    isAllowed: id => admitted[id]?.endpoint === cfg.endpoint && admitted[id]?.expiresAt > Date.now(),
    resolveName: name => {
      if (domains[name]) return domains[name];
      const suffix = '.' + (cfg.appZone || 'app.enclave.host');
      if (!name.endsWith(suffix)) return null;
      const label = name.slice(0, -suffix.length);
      if (!/^[0-9a-f]{8,64}$/.test(label)) return null;
      const ids = Object.keys(admitted).filter(id => id.startsWith('0x' + label));
      return ids.length === 1 ? ids[0] : null;
    },
    serveHttps: (socket, id) => splice(socket, id, 'https'),
    serveTcp: (socket, id, port) => splice(socket, id, 'tcp', port),
    connectUdp: async (id, port, receive) => {
      const ws = await open(id, 'udp', port); ws.on('message', (b, binary) => { if (binary && b.length <= 65507) receive(b); });
      return { send(b) { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1048576) ws.send(b); }, close() {ws.terminate();} };
    },
  });
  async function refresh() {
    const results = await Promise.allSettled([
      fetch(upstream + '/v1/net-map', { signal: timeout() }).then(r => r.ok ? r.json() : null),
      fetch(new URL('/v1/network/tuna', api), { signal: timeout() }).then(r => r.ok ? r.json() : null),
      fetch(new URL('/v1/domains/map', api), { signal: timeout() }).then(r => r.ok ? r.json() : null),
    ]);
    const raw = results[0].status === 'fulfilled' && results[0].value;
    // A failed host read withdraws raw listeners rather than publishing stale ports.
    deployments = (raw?.deployments || []).map(d => ({ id: d.id, public: true, status: 'running', tcp: d.tcp || [], udp: d.udp || d.ports || [] }));
    if (results[1].status === 'fulfilled' && results[1].value) admitted = results[1].value.deployments || {};
    if (results[2].status === 'fulfilled' && results[2].value) domains = results[2].value.domains || {};
  }
  async function publish() {
    if (publishing || stopped) return; publishing = true;
    try {
      await refresh(); await host.reconcile();
      const status = host.status();
      const publication = { version: 1, endpoint: cfg.endpoint, expiresAt: Date.now() + 60000,
        web: status.web ? { address: status.web.address, port: status.web.tcp[0] } : null,
        raw: deployments.map(d => ({ id: d.id, ...host.network(d.id) })).filter(d => d.address)
          .map(d => ({ id: d.id, address: d.address, tcp: d.tcp?.mappings || [], udp: d.udp?.mappings || [] })) };
      const signature = await account.signMessage({ message: 'enclave-tuna-route:v1\n' + JSON.stringify(publication) });
      const res = await fetch(new URL('/v1/network/tuna', api), { method: 'POST', signal: timeout(),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publication, signature }) });
      if (!res.ok) throw new Error(`route publication refused: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      if (cfg.statusFile) {
        const file = cfg.statusFile + '.tmp'; fs.writeFileSync(file, JSON.stringify({ ...status, publication, updatedAt: new Date().toISOString() }), { mode: 0o600 }); fs.renameSync(file, cfg.statusFile);
      }
    } catch (e) { console.error(`[tuna-network] ${e.message}`); }
    finally { publishing = false; }
  }
  await refresh(); await host.start(); await publish();
  const timer = setInterval(publish, 10000);
  const close = () => { stopped = true; clearInterval(timer); host.close(); for (const ws of sockets) ws.terminate(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { host, close, publish };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--config');
  run(i >= 0 ? process.argv[i + 1] : process.env.TUNA_CONFIG).catch(e => { console.error(e.message); process.exitCode = 1; });
}
