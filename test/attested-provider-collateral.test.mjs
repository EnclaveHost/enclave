// The attested provider's AMD collateral (network/wg-provider/attested-authority.mjs providerCollateral): an expired
// pre-seeded CRL must never shadow a fresh AMD KDS answer, and nothing about the verifier's policy is relaxed to get there.
// Real, signed collateral end to end through the UNCHANGED verifier (verifier/snp.mjs, CRL "required", TCB floor, ARK pin):
// the SYNTHETIC AMD-shaped chain of test/helpers/snp-synth.mjs (own ARK/ASK/VCEK, ARK-signed RSASSA-PSS CRLs, one revoking
// the ASK), pinned only programmatically. "KDS" here is a local adapter serving those bytes with controllable availability:
// these are offline tests of the provider's composition, not a live AMD KDS or SEV-SNP hardware end-to-end run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyEvidence } from '../verifier/index.mjs';
import { fileCollateral, layeredCollateral, memoryCollateral } from '../verifier/collateral.mjs';
import { inspectCache } from '../verifier/collateral-cache.mjs';
import { parseAmdChain, checkCrlAuthentic } from '../verifier/snp.mjs';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { providerCollateral, providerChainAuthority } from '../network/wg-provider/attested-authority.mjs';

const S = synthChain({ crlDays: 1, extraCrlDays: [400], revokeAsk: true, extraVceks: 1 });   // 1-day CRL goes stale; 400-day stays fresh
const FORGED = synthChain({ crlDays: 400 });                                                   // a different ARK: authentic to nobody we pin
const ROOTS = new Map([['Genoa', S.arkFp]]);
const SP = Buffer.from('302a300506032b6570032100' + '11'.repeat(32), 'hex'), NONCE = Buffer.from('22'.repeat(32), 'hex');
const DOC = { format: 'sev-snp-guest-metal-v1', body: synthReport(S, { reportData: Buffer.concat([createHash('sha256').update(Buffer.concat([SP, NONCE])).digest(), Buffer.alloc(32)]) }).toString('base64') };
const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const NOW = new Date(), LATER = new Date(Date.now() + 2 * 86400e3);   // at LATER the 1-day CRL is past nextUpdate, the 400-day one is not
const verify = (collateral, at) => verifyEvidence(DOC, { policy: { snp: { roots: ROOTS, allowedMeasurements: ['77'.repeat(48)], minTcb: FLOOR, crl: 'required' } },
  context: { transportKeySpki: SP, nonce: NONCE, now: at }, collateral });
const sha = (b) => createHash('sha256').update(b).digest('hex');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'provider-collateral-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dirs = () => { const base = path.join(tmp, `case-${++n}`); return { seed: path.join(base, 'seed'), cache: path.join(base, 'cache') }; };

// the exact VCEK slot the verifier asks for (product, chip, tcb), learned from one verification over in-memory bytes
const SLOT = await (async () => { let slot = null; const m = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crls[400] } });
  const v = await verify({ chain: (p) => m.chain(p), crl: (p) => m.crl(p), vcek: (p, chip, tcb) => { slot = { p, chip, tcb }; return m.vcek(p, chip, tcb); } }, NOW);
  assert.equal(v.status, 'verified', v.reasons.join('\n')); return slot; })();
/** The operator's pre-seed: the layout fileCollateral reads (amd/<P>-cert_chain.pem, amd/<P>-crl.der, vcek/<P>-<chip>-<tcb>.der). */
const bytesOrNull = (o, what) => { for (const [k, v] of Object.entries(o)) if (v !== null && !Buffer.isBuffer(v) && typeof v !== 'string') throw new Error(`${what}.${k}: fixture is ${v} (an undefined fixture would silently fall back to the genuine default)`); };
function seed(dir, over = {}) {
  bytesOrNull(over, 'seed'); const { chain, crl, vcek } = { chain: S.chainPem, crl: S.crlDer, vcek: S.vcekDer, ...over };
  fs.mkdirSync(path.join(dir, 'amd'), { recursive: true }); fs.mkdirSync(path.join(dir, 'vcek'), { recursive: true });
  if (chain !== null) fs.writeFileSync(path.join(dir, 'amd', 'Genoa-cert_chain.pem'), chain);
  if (crl !== null) fs.writeFileSync(path.join(dir, 'amd', 'Genoa-crl.der'), crl); else fs.rmSync(path.join(dir, 'amd', 'Genoa-crl.der'), { force: true });
  if (vcek !== null) fs.writeFileSync(path.join(dir, 'vcek', `${SLOT.p}-${SLOT.chip}-${SLOT.tcb}.der`), vcek);
  return dir;
}
/** A local stand-in for AMD KDS (same adapter shape as httpCollateral) serving signed bytes; availability is controlled. */
function kds(over = {}) {
  bytesOrNull(over, 'kds'); for (const [key, v] of Object.entries(over)) if (v === null) throw new Error(`kds.${key}: null is not a KDS answer`);
  const k = { kind: 'http', down: false, calls: { chain: 0, vcek: 0, crl: 0 }, serve: { chain: S.chainPem, crl: S.crls[400], vcek: S.vcekDer, ...over } };
  const up = (what) => { k.calls[what]++; if (k.down) throw new Error('KDS: connection refused'); };
  k.chain = async () => { up('chain'); return { pem: k.serve.chain, source: 'kds:chain', fetchedAt: new Date().toISOString() }; };
  k.vcek = async () => { up('vcek'); return { der: k.serve.vcek, source: 'kds:vcek', fetchedAt: new Date().toISOString() }; };
  k.crl = async () => { up('crl'); return { der: k.serve.crl, source: 'kds:crl', fetchedAt: new Date().toISOString() }; };
  return k;
}
const provider = (d, k, at, extra = {}) => providerCollateral({ dir: d.seed, cacheDir: d.cache, kds: !!k, ...extra }, { http: () => k, roots: ROOTS, now: () => at });

test('the DEFECT, reproduced on the old composition: layered(pre-seed, KDS) serves the expired seed CRL first and KDS is never asked', async () => {
  const d = dirs(); seed(d.seed); const k = kds();
  const v = await verify(layeredCollateral(fileCollateral(d.seed), k), LATER);
  assert.equal(v.status, 'rejected'); assert.match(v.reasons.join('\n'), /CRL is stale/); assert.equal(k.calls.crl, 0, 'the fresh KDS CRL was shadowed');
});

test('stale pre-seed + fresh KDS: the provider fetches the fresh CRL, verifies, and caches only what it authenticated', async () => {
  const d = dirs(); seed(d.seed); const k = kds();
  const v = await verify(provider(d, k, LATER), LATER);
  assert.equal(v.status, 'verified', v.reasons.join('\n'));
  assert.equal(v.claims.collateral.crl.source, 'kds:crl'); assert.equal(v.claims.collateral.crl.stale, false);
  // the cache authenticated the chain during the VCEK lookup and then served it (source cache:...); its ORIGIN is the seed:
  // the cached bytes are the seed's bytes, its sidecar names the seed file, and KDS was never asked for a chain or VCEK
  const chainFile = path.join(d.cache, 'Genoa', 'chain.pem'), chainMeta = JSON.parse(fs.readFileSync(`${chainFile}.meta.json`, 'utf8'));
  assert.equal(v.claims.collateral.chain.source, `cache:${chainFile}`);
  assert.equal(fs.readFileSync(chainFile, 'utf8'), fs.readFileSync(path.join(d.seed, 'amd', 'Genoa-cert_chain.pem'), 'utf8'));
  assert.equal(chainMeta.source, `file:${path.join(d.seed, 'amd', 'Genoa-cert_chain.pem')}`, 'the chain came from the reviewed pre-seed');
  assert.equal(chainMeta.sha256, sha(fs.readFileSync(chainFile)));
  assert.equal(k.calls.chain, 0, 'never a KDS chain'); assert.equal(k.calls.vcek, 0, 'the pre-seeded VCEK is used first');
  assert.equal(sha(fs.readFileSync(path.join(d.cache, 'Genoa', 'crl.der'))), sha(S.crls[400]));
  assert.ok(inspectCache(d.cache).every((e) => e.sidecarMatches)); assert.equal(sha(fs.readFileSync(path.join(d.seed, 'amd', 'Genoa-crl.der'))), sha(S.crlDer), 'the read-only pre-seed is never written');
});

test('fresh, warm, offline and restart: a warm cache verifies with KDS down and no network, also from a NEW instance (restart)', async () => {
  const d = dirs(); seed(d.seed, { crl: S.crls[400] }); const k = kds();
  assert.equal((await verify(provider(d, k, NOW), NOW)).status, 'verified');
  const first = { ...k.calls }; k.down = true;
  const warm = await verify(provider(d, k, LATER), LATER);           // new instance = provider restart, same cacheDir
  assert.equal(warm.status, 'verified', warm.reasons.join('\n')); assert.deepEqual(k.calls, first, 'no KDS call with a fresh warm cache');
  assert.equal(warm.claims.collateral.crl.cached, true); assert.equal(warm.claims.collateral.vcek.cached, true);
  // no-network provisioning with the cache: kds false never constructs the network adapter
  const d2 = dirs(); seed(d2.seed, { crl: S.crls[400] });
  const off = providerCollateral({ dir: d2.seed, cacheDir: d2.cache }, { http: () => assert.fail('no network adapter without kds'), roots: ROOTS, now: () => LATER });
  assert.equal((await verify(off, LATER)).status, 'verified');
});

test('stale + KDS outage: rejected (CRL required), never accepted; no CRL anywhere: rejected', async () => {
  const d = dirs(); seed(d.seed); const k = kds(); k.down = true;
  const v = await verify(provider(d, k, LATER), LATER);
  assert.equal(v.status, 'rejected'); assert.match(v.reasons.join('\n'), /CRL is stale/); assert.ok(k.calls.crl >= 1, 'KDS was tried first');
  const d2 = dirs(); seed(d2.seed, { crl: null }); const k2 = kds(); k2.down = true;
  const none = await verify(provider(d2, k2, NOW), NOW);
  assert.equal(none.status, 'rejected'); assert.match(none.reasons.join('\n'), /CRL: required by policy but none was supplied/);
});

test('restoration without restart: KDS back, or (no network) the operator replaces the seed CRL; the same instance verifies again', async () => {
  const d = dirs(); seed(d.seed); const k = kds(); k.down = true; const c = provider(d, k, LATER);
  assert.equal((await verify(c, LATER)).status, 'rejected');
  k.down = false;
  const back = await verify(c, LATER); assert.equal(back.status, 'verified', back.reasons.join('\n')); assert.equal(back.claims.collateral.crl.source, 'kds:crl');
  const d2 = dirs(); seed(d2.seed); const off = providerCollateral({ dir: d2.seed, cacheDir: d2.cache }, { roots: ROOTS, now: () => LATER });
  assert.equal((await verify(off, LATER)).status, 'rejected');
  seed(d2.seed, { crl: S.crls[400] });                               // operator refresh (host-collateral output), no restart
  const fixed = await verify(off, LATER); assert.equal(fixed.status, 'verified', fixed.reasons.join('\n'));
  const legacy = providerCollateral({ dir: d2.seed });             // and the unchanged no-cache provisioning reads it too
  assert.equal(legacy.kind, 'file'); assert.equal((await verify(legacy, LATER)).status, 'verified');
});

test('forged and revoked collateral are refused: a CRL under another ARK, a forged pre-seeded chain, another chip\'s VCEK, an authentic CRL revoking the ASK', async () => {
  // the forged fixture is a REAL CRL, validly signed by ANOTHER ARK (fresh key, same synthetic names): it authenticates under
  // its own ARK and fails the signature check under ours. Same issuer name, so only the signature distinguishes it.
  assert.ok(Buffer.isBuffer(FORGED.crlDer)); assert.notEqual(FORGED.arkFp, S.arkFp, 'independent ARK keys');
  const ours = parseAmdChain({ chainPem: S.chainPem, product: 'Genoa', now: LATER, roots: ROOTS });
  const theirs = parseAmdChain({ chainPem: FORGED.chainPem, product: 'Genoa', now: LATER, roots: new Map([['Genoa', FORGED.arkFp]]) });
  assert.ok(ours.ok && theirs.ok);
  assert.equal(checkCrlAuthentic({ crlDer: FORGED.crlDer, ark: theirs.ark, now: LATER }).ok, true, 'control: valid under its own ARK, and fresh at LATER');
  assert.equal(checkCrlAuthentic({ crlDer: FORGED.crlDer, ark: ours.ark, now: LATER }).why, 'CRL signature does not verify with the pinned ARK');
  // served fresh by "KDS" while the seed is stale: refused by the cache, never stored, and the verification rejects
  const d = dirs(); seed(d.seed); const k = kds({ crl: FORGED.crlDer }); const c = provider(d, k, LATER);
  const forged = await verify(c, LATER);
  assert.equal(k.calls.crl, 1, 'the forged CRL was actually served');
  assert.equal(forged.status, 'rejected'); assert.ok(c.events.some((e) => e.kind === 'upstream-refused' && /signature does not verify/.test(e.why)), 'refused for its signature');
  assert.equal(fs.existsSync(path.join(d.cache, 'Genoa', 'crl.der')), false, 'the forged CRL was not stored');
  assert.match(forged.reasons.join('\n'), /CRL: required by policy but none was supplied/);
  // a forged chain in the pre-seed (another ARK): not AMD's pinned (test) root, rejected; KDS is never asked for the chain
  const d2 = dirs(); seed(d2.seed, { chain: FORGED.chainPem, crl: S.crls[400] }); const k2 = kds();
  const badChain = await verify(provider(d2, k2, NOW), NOW);
  assert.equal(badChain.status, 'rejected'); assert.match(badChain.reasons.join('\n'), /AMD chain from file:.*failed authentication/); assert.equal(k2.calls.chain, 0);
  // another chip's AUTHENTIC VCEK planted in the pre-seeded slot: refused for this slot and never cached. The VCEK stays
  // pre-seed FIRST (no network for a seeded slot), so a wrong seed fails closed rather than falling through to KDS
  // (documented limitation: the operator re-runs host-collateral); KDS serves only slots the seed does not hold
  const d3 = dirs(); seed(d3.seed, { crl: S.crls[400], vcek: S.otherVceks[0].der }); const k3 = kds();
  const vk = await verify(provider(d3, k3, NOW), NOW);
  assert.equal(vk.status, 'rejected'); assert.match(vk.reasons.join('\n'), /VCEK unavailable: VCEK from file:.*failed authentication/); assert.equal(k3.calls.vcek, 0);
  assert.equal(fs.existsSync(path.join(d3.cache, 'Genoa', 'vcek', `${SLOT.chip}-${SLOT.tcb}.der`)), false, 'the wrong VCEK was not cached');
  const d4 = dirs(); seed(d4.seed, { crl: S.crls[400], vcek: null }); const k4 = kds();     // an unseeded slot: KDS supplies it
  const fromKds = await verify(provider(d4, k4, NOW), NOW);
  assert.equal(fromKds.status, 'verified', fromKds.reasons.join('\n')); assert.equal(fromKds.claims.collateral.vcek.source, 'kds:vcek');
  // an AUTHENTIC CRL that revokes the ASK, fresh from KDS: served (revocation is never hidden) and the verifier rejects
  const d5 = dirs(); seed(d5.seed); const k5 = kds({ crl: S.crlRevokingAsk });
  const rev = await verify(provider(d5, k5, LATER), LATER);
  assert.equal(rev.status, 'rejected'); assert.match(rev.reasons.join('\n'), /revoked/i);
});

test('defence in depth: the forged CRL delivered with NO cache in between is still rejected by the verifier\'s own signature check; the genuine fresh CRL in its place verifies', async () => {
  const bare = (crl) => memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: crl } });
  const v = await verify(bare(FORGED.crlDer), LATER);
  assert.equal(v.status, 'rejected'); assert.match(v.reasons.join('\n'), /CRL signature does not verify with the pinned ARK/);
  const ok = await verify(bare(S.crls[400]), LATER);
  assert.equal(ok.status, 'verified', ok.reasons.join('\n'));
});

test('configuration: legacy { dir } unchanged; { dir, kds: true } refused with the migration; cacheDir absolute and separate; nothing names a root', () => {
  const d = dirs(); seed(d.seed);
  assert.equal(providerCollateral({ dir: d.seed }).kind, 'file');
  assert.throws(() => providerCollateral({ dir: d.seed, kds: true }), /kds needs cacheDir.*attested-provider-collateral\.md/);
  assert.throws(() => providerCollateral({ dir: d.seed, cacheDir: 'cache', kds: true }), /cacheDir must be an absolute path/);
  assert.throws(() => providerCollateral({ dir: d.seed, cacheDir: d.seed }), /separate from dir/);
  assert.throws(() => providerCollateral({ dir: d.seed, cacheDir: path.join(d.seed, 'cache') }), /separate from dir/);
  assert.throws(() => providerCollateral({ dir: path.join(d.cache, 'seed'), cacheDir: d.cache }), /separate from dir/);
  assert.throws(() => providerCollateral({ dir: d.seed, cacheDir: d.cache, kds: 1 }), /boolean/);
  for (const k of ['roots', 'crl', 'ark', 'staleOk', 'maxStaleDays']) assert.throws(() => providerCollateral({ dir: d.seed, cacheDir: d.cache, [k]: 1 }), /\{ dir, cacheDir\?, kds\? \}/);
  assert.equal(providerCollateral({ dir: d.seed, cacheDir: d.cache, kds: true }, { http: () => kds() }).kind, 'cache');
  // through the provider's authority: the same refusal before any verifier exists, and the replica policy keeps its own guards
  const cfg = (collateral) => ({ chainAuthority: 'attested-verifier', attestedVerifier: { unsafeSigner: '0x' + '9a'.repeat(20), replicas: [], collateral } });
  assert.throws(() => providerChainAuthority(cfg({ dir: d.seed, kds: true })), /kds needs cacheDir/);
  assert.throws(() => providerChainAuthority(cfg({ dir: d.seed, cacheDir: d.cache, kds: true, crl: 'stale-ok' })), /\{ dir, cacheDir\?, kds\? \}/);
});
