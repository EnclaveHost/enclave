#!/usr/bin/env node
// PUBLIC-ONLY evidence capture for the certificate activation (root runs it; it reads no env file, private config, key,
// wallet or database, writes nothing but stdout, and sends no transaction). Shared chain facts (registry entry for this host,
// platform policy anchor, book owner, service-index code) come from work/hosted-services-activation's
// scripts/capture-public-inputs.sh; this adds what the CERTIFICATE path needs:
//   --zone Z           (repeatable) NS / SOA / CAA of each zone, from the system resolver and from 1.1.1.1 and 9.9.9.9
//   --front URL        (repeatable) a staged challenge front: GET /health (role, trusted judge, ledger index, Shield profile digest,
//                      hostExcluded, live host sessions), never a push
//   --ns HOST:PORT     (repeatable) a staged replica's DNS: SOA of --zone over UDP (does it answer authoritatively?)
//   --host-id 0x..     (repeatable) EnclaveRegistry get(hostId) at ONE block that 2+ --rpc agree on (endpoint, operator, active)
//   --rpc URL          (2..8) public Base RPCs for --host-id
//   --acme URL         (repeatable) an ACME directory (public CA reachability only; no account, no order)
//   --artifact CID=SHA256 --gateway URL   fetch a published release/image object by CID and check its sha256 (bytes discarded)
// Output: one JSON document. Every value is labelled observed / unreachable / refused; nothing is inferred.
//   node capture-cert-evidence.mjs --tree <repo tree> [options]
import dns from 'node:dns';
import dgram from 'node:dgram';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const args = process.argv.slice(2), all = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : [])), one = (k) => all(k)[0];
const tree = one('--tree');
if (!tree) { console.error('usage: capture-cert-evidence.mjs --tree <repo tree> [--zone Z] [--front URL] [--ns H:P] [--host-id 0x..] [--rpc URL]... [--acme URL] [--artifact CID=SHA --gateway URL]'); process.exit(2); }
const out = {at: new Date().toISOString(), publicOnly: true, zones: {}, fronts: {}, replicas: {}, registry: null, acme: {}, artifacts: {}};
const settle = async (f) => { try { return {observed: await f()}; } catch (e) { return {unreachable: String(e?.message || e).slice(0, 200)}; } };
const timeout = (ms) => AbortSignal.timeout(ms);

for (const zone of all('--zone')) {
  const r = {};
  for (const [label, servers] of [['system', null], ['1.1.1.1', ['1.1.1.1']], ['9.9.9.9', ['9.9.9.9']]]) {
    const res = new dns.promises.Resolver({timeout: 4000, tries: 1}); if (servers) res.setServers(servers);
    r[label] = {ns: await settle(() => res.resolveNs(zone)), soa: await settle(() => res.resolveSoa(zone)), caa: await settle(() => res.resolveCaa(zone))};
  }
  out.zones[zone] = r;
}
for (const front of all('--front')) {
  out.fronts[front] = await settle(async () => {
    const h = await fetch(new URL('/health', front), {signal: timeout(8000), redirect: 'error'}).then((x) => x.json());
    const a = h.appChallenge || {};
    return {readOnly: h.readOnly, mode: a.mode ?? h.mode, judgeMode: a.judgeMode ?? h.judgeMode, ledgerIndexComplete: a.ledgerIndex?.complete ?? null,
      shield: a.shield ? {tier: a.shield.tier, hostExcluded: a.shield.hostExcluded, party: a.shield.party, liveHostSessions: a.shield.liveHostSessions,
        profileDigest: a.shield.registry?.profileDigest} : (h.shield ?? null), snpMeasurements: a.measurements ?? h.measurements ?? null};
  });
}
for (const hp of all('--ns')) {
  const [host, port] = hp.split(':'), zone = all('--zone')[0];
  out.replicas[hp] = await settle(() => new Promise((ok, no) => {
    if (!zone) return no(new Error('--ns needs a --zone'));
    const h = Buffer.alloc(12); h.writeUInt16BE(0x4242, 0); h.writeUInt16BE(1, 4);
    const q = Buffer.concat([h, ...zone.split('.').map((v) => Buffer.concat([Buffer.from([v.length]), Buffer.from(v)])), Buffer.from([0, 0, 6, 0, 1])]);
    const s = dgram.createSocket('udp4'); const t = setTimeout(() => { s.close(); no(new Error('UDP timeout')); }, 4000);
    s.once('message', (m) => { clearTimeout(t); s.close(); ok({authoritative: !!(m[2] & 4), rcode: m[3] & 15, answers: m.readUInt16BE(6)}); });
    s.send(q, Number(port), host);
  }));
}
const ids = all('--host-id'), rpcs = all('--rpc');
if (ids.length) {
  out.registry = await settle(async () => {
    if (rpcs.length < 2) throw new Error('--host-id needs 2 or more --rpc');
    const imp = (p) => import(pathToFileURL(path.join(tree, p)).href);
    const {quorumReader, rpcClients} = await imp('windows/node/host-identity.mjs');
    const pins = JSON.parse((await import('node:fs')).readFileSync(path.join(tree, 'contracts/deployments/contract-pins-production-base.json'), 'utf8'));
    const reader = quorumReader({clients: await rpcClients(rpcs)});
    const abi = [{type: 'function', name: 'get', stateMutability: 'view', inputs: [{type: 'bytes32'}], outputs: [{type: 'tuple', components:
      [['endpoint', 'string'], ['repo', 'string'], ['measurement', 'bytes32'], ['operator', 'address'], ['registeredAt', 'uint64'], ['lastSeen', 'uint64'], ['active', 'bool']]
        .map(([name, type]) => ({name, type}))}]}];
    const registry = String(pins.registry || pins.contracts?.registry || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(registry)) throw new Error('no registry pin in contract-pins-production-base.json');
    const facts = await reader.agreed(async (c, blockNumber) => {
      const rows = {};
      for (const id of ids) { const x = await c.readContract({address: registry, abi, functionName: 'get', args: [id], blockNumber});
        rows[id] = {endpoint: x.endpoint, operator: String(x.operator).toLowerCase(), active: x.active === true}; }
      return {rows};
    });
    return {registry, block: String(facts.blockNumber), rows: facts.rows};
  });
}
for (const acme of all('--acme')) out.acme[acme] = await settle(async () => { const d = await fetch(acme, {signal: timeout(8000)}).then((x) => x.json());
  return {newAccount: !!d.newAccount, externalAccountRequired: !!d.meta?.externalAccountRequired, caaIdentities: d.meta?.caaIdentities ?? null}; });
const gw = one('--gateway');
for (const a of all('--artifact')) {
  const [cid, want] = a.split('=');
  out.artifacts[cid] = await settle(async () => {
    if (!gw || !/^[0-9a-f]{64}$/.test(want || '')) throw new Error('--artifact CID=<sha256> needs --gateway');
    const r = await fetch(`${gw.replace(/\/+$/, '')}/ipfs/${cid}`, {signal: timeout(600_000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const h = createHash('sha256'); let n = 0; for await (const c of r.body) { h.update(c); n += c.length; }
    const got = h.digest('hex'); return {bytes: n, sha256: got, matches: got === want};
  });
}
console.log(JSON.stringify(out, null, 1));
