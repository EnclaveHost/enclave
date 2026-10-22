// READ-ONLY post-activation gates of the IPNS Publisher release, phase A of accept-release.sh. ALWAYS emits exactly the
// six gates C1 C2 P1 P2 P3 R1 (a failed read fails its gates with an error, it never drops them):
//   C1 catalog version 6 = 1.0.6, owner-approved, not yanked, the frozen CID, version 1.0.5's resources/ports/config VERBATIM
//   C2 the deployment on catalog://<app>/6 with envelope d92631c6 (exactly one change: config.ipni.announceAllBlocks)
//      (C1/C2: Base 8453, two RPCs at one block both agree on)
//   P1 the publisher's /api/status: same peer and name, sequence >= 1026, the exact site value, a NEWLY signed record
//      (validUntil past the pre-release record's EOL), no lastError/configError
//   P2 every delegate's latest PUT "ok", at or after the record's signing
//   P3 IPNI: 487 blocks of the site root, an advertisement head
//   R1 the record at delegated-ipfs.dev (chain/ipns-check.mjs, unchanged; signature verified locally) = the publisher's
// The numbers accept-decide.py needs to tell a valid-but-STALE delegated record from a bad one are emitted as fields.
// No key, signature, write or login. Output: public data only.   node accept-gates.mjs > accept-gates.json  (0 = all pass)
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CATALOG_ABI, LEDGER_ABI } from '../../../site-host-live-publish/handoff/site-trust.mjs';
const require = createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');
const { createPublicClient, http } = require('viem');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const CATALOG = '0x18419CA2b502D423A8de6269AEeE171a378626e3', LEDGER = '0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';
const APP = '0x9afdfb401d6f2cfea70c446f9f5874bbca8ce7dd116e2b15715312d8d32a65ef', DEP = '0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a';
const OWNER = '0x0b2d009c0c9Af05b12100D77F3c815fea822eE61', CID = 'bafybeia2ymbg45dgh3sr3nqkxeumv3ayanfwtw6y5adj7tlg3ho33553fu';
const PEER = '12D3KooWSHxfM6L5zdmTkMh5ho8yPBB2292ug6T46BnkpCwYzoZP', NAME = 'k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52';
const ROOT = 'bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou', VALUE = '/ipfs/' + ROOT;
const PRE_EOL = Date.parse('2026-10-28T05:15:51Z') / 1000;      // the pre-release record (seq 1026)
const STATUS = 'https://d9798e4c.app.enclave.host/api/status';
const pin = (f, h) => { const s = fs.readFileSync(f, 'utf8'); if (sha(s) !== h) throw Error(`${f} is not the pinned file`); return s; };
const V5CFG = pin('version-config-v5.json', 'c681a628454c9ffef5522cd5e3fd570aab0480307a91d7afd735cec9fce2b2ee');
const ENV_OLD = pin('../../publisher-wallet-handoff/pins/envelope-current.json', 'd59dc724df6a1784e9bb55eead51ffe991526260a1db6a89bd6ef15ddf7510c8');
const ENV_NEW = pin('../../publisher-wallet-handoff/pins/envelope-new.json', 'd92631c621a0888d67463516a76f3d14aa396e6dd15c5301c927fbe594a1a18c');

const TITLES = {
  C1: 'catalog v6 = 1.0.6, approved, frozen CID, v5 config/resources/ports verbatim',
  C2: 'deployment on catalog://<app>/6 with envelope d92631c6 (only ipni.announceAllBlocks changed)',
  P1: 'publisher: same peer/name, sequence >= 1026, exact site value, newly signed, no error',
  P2: 'publisher: every delegate accepted the current record',
  P3: 'publisher IPNI: 487 blocks of the site root, an advertisement head',
  R1: 'delegated-ipfs.dev serves the publisher\'s record (signature verified locally, unexpired)',
};
const out = { startedAt: new Date().toISOString(), gates: {} };
const gate = (id, pass, detail) => { out.gates[id] = { title: TITLES[id], pass: pass === true, ...detail }; };
const failAll = (ids, e) => { for (const id of ids) gate(id, false, { error: String(e?.shortMessage || e?.message || e).slice(0, 200) }); };
const norm = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const lcEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// C: chain
try {
  const cs = RPCS.map((u) => createPublicClient({ transport: http(u, { timeout: 20000, retryCount: 1 }) }));
  const heads = await Promise.all(cs.map((c) => c.getBlockNumber())); const B = (heads[0] < heads[1] ? heads[0] : heads[1]) - 2n;
  const hs = await Promise.all(cs.map((c) => c.getBlock({ blockNumber: B }).then((b) => b.hash)));
  if (hs[0] !== hs[1]) throw Error('the two RPCs disagree on block ' + B);
  const read = async (to, abi, functionName, args) => { const r = await Promise.all(cs.map((c) => c.readContract({ address: to, abi, functionName, args, blockNumber: B })));
    if (JSON.stringify(norm(r[0])) !== JSON.stringify(norm(r[1]))) throw Error(`RPCs disagree on ${functionName}`); return r[0]; };
  const n = Number(await read(CATALOG, CATALOG_ABI, 'numVersions', [APP]));
  const v = n > 6 ? await read(CATALOG, CATALOG_ABI, 'getVersion', [APP, 6n]) : null;
  const d = await read(LEDGER, LEDGER_ABI, 'get', [DEP]);
  let cfgNew = {}; try { cfgNew = JSON.parse(d.configCid || '{}'); } catch {}
  const cfgOld = JSON.parse(ENV_OLD);
  const delta = [...new Set([...Object.keys(cfgOld.config.ipni), ...Object.keys(cfgNew.config?.ipni || {})])].filter((k) => JSON.stringify(cfgOld.config.ipni[k]) !== JSON.stringify(cfgNew.config?.ipni?.[k]));
  const vOk = !!v && v.version === '1.0.6' && v.cid === CID && Number(v.approval) === 1 && v.yanked === false && v.config === V5CFG
    && JSON.stringify([v.vramMb, v.gpuGflops, v.memMb, v.cpuGflops].map(Number)) === '[0,0,128,1]' && v.ports === 'http:8000';
  gate('C1', vOk, { block: Number(B), blockHash: hs[0], numVersions: n, v6: v && { version: v.version, cid: v.cid, approval: Number(v.approval), yanked: v.yanked, configSha256: sha(v.config), res: [v.vramMb, v.gpuGflops, v.memMb, v.cpuGflops].map(Number), ports: v.ports } });
  gate('C2', d.appRef === `catalog://${APP}/6` && d.configCid === ENV_NEW && lcEq(d.owner, OWNER),
    { appRef: d.appRef, envelopeSha256: sha(d.configCid || ''), ipniKeysChangedVsPreRelease: delta, active: d.active });
} catch (e) { failAll(['C1', 'C2'], e); }

// P: the publisher's own status
let st = null;
try {
  const r = await fetch(STATUS, { signal: AbortSignal.timeout(20000) });
  if (r.status !== 200) throw Error(`status HTTP ${r.status}`);
  st = await r.json();
  if (!st || typeof st !== 'object') throw Error('status is not a JSON object');
  const seq = num(st.sequence), vu = num(st.validUntil), pub = num(st.publishedAt);
  gate('P1', st.peerId === PEER && st.name === NAME && seq !== null && seq >= 1026 && st.value === VALUE && vu !== null && vu > PRE_EOL && pub !== null && pub > 0 && !st.lastError && !st.configError,
    { peerId: st.peerId, sequence: seq, value: st.value, validUntilUnix: vu, publishedAtUnix: pub, recovered: st.recovered ?? null, lastError: st.lastError ?? null, configError: st.configError ?? null, uptimeSecs: num(st.uptimeSecs) });
  const latest = Array.isArray(st.delegates) ? st.delegates : [];
  gate('P2', latest.length > 0 && latest.every((x) => x.outcome === 'ok' && num(x.at) !== null && num(x.at) >= (pub || Infinity)),
    { delegates: latest.map((x) => ({ url: x.url, outcome: String(x.outcome).slice(0, 120), atUnix: num(x.at) })) });
  const i = st.ipni || {};
  gate('P3', i.provider === PEER && i.root === ROOT && i.blocks === 487 && typeof i.head === 'string' && i.head.length > 0,
    { provider: i.provider ?? null, root: i.root ?? null, blocks: i.blocks ?? null, head: i.head ?? null, chainLen: i.chainLen ?? null,
      announced: (i.announced || []).map((a) => ({ indexer: a.indexer, outcome: String(a.outcome).slice(0, 80) })), note: String(i.note || '').slice(0, 160) });
} catch (e) { failAll(['P1', 'P2', 'P3'], e); st = null; }

// R: the record at the public delegated router (the existing checker, unchanged; it verifies the signature locally)
try {
  const j = JSON.parse(execFileSync('node', ['../../chain/ipns-check.mjs'], { encoding: 'utf8', timeout: 150000 }));
  const r = j?.routers?.['https://delegated-ipfs.dev'];
  if (!r || typeof r !== 'object') throw Error('ipns-check returned no router result');
  if (r.error) throw Error('router: ' + r.error);
  const validityUnix = r.validity ? Date.parse(String(r.validity).replace(/(\.\d{3})\d*Z$/, '$1Z')) / 1000 : null;
  const seq = num(r.sequence), pseq = st ? num(st.sequence) : null, pvu = st ? num(st.validUntil) : null;
  const same = pseq !== null && seq === pseq && r.value === st.value && validityUnix === pvu;
  gate('R1', r.status === 200 && r.signatureV2Valid === true && r.v1ValueMatchesV2 !== false && r.expired === false && r.value === VALUE && seq !== null && seq >= 1026 && same,
    { status: r.status ?? null, signatureV2Valid: r.signatureV2Valid ?? null, v1ValueMatchesV2: r.v1ValueMatchesV2 ?? null, sequence: seq, value: r.value ?? null,
      validityUnix: Number.isFinite(validityUnix) ? validityUnix : null, expired: r.expired ?? null, ttlSeconds: num(r.ttlSeconds),
      publisherSequence: pseq, publisherValidUntilUnix: pvu, equalsPublisher: same,
      rootProvidersAtRouter: r.providers?.count ?? null, publisherPeerAmongThem: (r.providers?.list || []).some((p) => p.id === PEER) });
} catch (e) { failAll(['R1'], e); }

out.finishedAt = new Date().toISOString();
out.ipniHead = st?.ipni?.head ?? null;
out.pass = Object.keys(TITLES).every((k) => out.gates[k]?.pass === true);
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
