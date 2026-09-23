#!/usr/bin/env node
// M2 negative tests (isolation/DESIGN.md section 10): forged and unsigned attestation evidence, judged by
// the same judge() the client runs. No VM is needed: a host that wants a client to trust ITS key writes
// the report itself, so the forgeries here are built from nothing, field by field.
//
// usage: node negative.mjs --measurement <hex> --app-sha <hex> [--genuine <doc.json saved by client --save>]
// Prints PASS/FAIL per case; exits 1 on any FAIL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { judge } from './judge.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const measurement = opt('--measurement'), appSha = opt('--app-sha');
if (!measurement || !appSha) { console.error('usage: negative.mjs --measurement <hex> --app-sha <hex> [--genuine <doc.json>]'); process.exit(2); }
const want = (mode) => ({ measurement, appSha, mode });
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); if (!ok) fails++; };
const spkiOf = (pub) => pub.export({ type: 'spki', format: 'der' });

// the host's own TLS key: what a host that terminates TLS would want the client to accept
const hostSpki = spkiOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey);
const domainSpki = spkiOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey);
const nonce = randomBytes(32);
const bind = (spki, n = nonce, app = appSha) =>
  Buffer.concat([createHash('sha256').update(Buffer.concat([spki, n])).digest(), Buffer.from(app, 'hex')]);

// a v5 SNP report with every field a verifier reads set to a value it accepts
function forge({ reportData, policy = 0x30000n, vmpl = 0, meas = measurement }) {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(5, 0x00);
  r.writeBigUInt64LE(policy, 0x08);
  r.writeUInt32LE(vmpl, 0x30);
  reportData.copy(r, 0x50);
  Buffer.from(meas, 'hex').copy(r, 0x90);
  randomBytes(64).copy(r, 0x1a0);                                   // a chip id AMD never issued
  return r;
}
const t1doc = (report, certs) => ({ tier: 'T1', format: 'sev-snp-guest-domain-v1', report: report.toString('base64'),
  ...(certs ? { certs: certs.toString('base64') } : {}) });

// An attacker "VCEK": a self-signed P-384 certificate claiming to be SEV-Milan. It signs the forged
// report exactly as a PSP would (ECDSA P-384 over bytes 0..0x2a0, r and s little-endian at 0x2a0) and
// travels in the certificate table the host controls anyway.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm2neg-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:secp384r1', '-nodes',
  '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '1', '-subj', '/CN=SEV-Milan'], { stdio: 'ignore' });
const fakeVcekKey = fs.readFileSync(`${tmp}/k.pem`);
const fakeVcekDer = Buffer.from(fs.readFileSync(`${tmp}/c.pem`, 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
fs.rmSync(tmp, { recursive: true });
function signReport(r) {
  const sig = sign('sha384', r.subarray(0, 0x2a0), { key: fakeVcekKey, dsaEncoding: 'ieee-p1363' });   // r||s, big-endian
  Buffer.from(sig.subarray(0, 48)).reverse().copy(r, 0x2a0);
  Buffer.from(sig.subarray(48, 96)).reverse().copy(r, 0x2a0 + 0x48);
  return r;
}
function auxblob(vcekDer) {       // the GUID table configfs-tsm returns: {guid, offset, length}, zero-terminated
  const hdr = Buffer.alloc(48);
  Buffer.from('63da758de6644564adc5f4b93be8accd', 'hex').copy(hdr, 0);
  hdr.writeUInt32LE(48, 16);
  hdr.writeUInt32LE(vcekDer.length, 20);
  return Buffer.concat([hdr, vcekDer]);
}

const J = (doc, spki, mode, n = nonce) => judge(doc, spki, n, want(mode));
const unsignedForHost = t1doc(forge({ reportData: bind(hostSpki) }));

// N1: every field forged to vouch for the HOST's key, and no signature at all
let t = await J(unsignedForHost, hostSpki, 'trusted');
check('N1 unsigned forgery for the host key: trusted mode REJECTS, gate closed', t.verdict === 'reject' && !t.gateOpen, t.reasons.at(-1));
let l = await J(unsignedForHost, hostSpki, 'lab-unsigned');
check('N1b same forgery in lab-unsigned: "unauthenticated", never "attested" (the lab diagnostic cannot tell a forgery)',
  l.verdict === 'unauthenticated' && l.reasons.some((s) => s.startsWith('UNAUTHENTICATED')), l.verdict);

// N2: forged AND signed, by a key the host made, with that key's "VCEK" in the certificate table
const signedFake = t1doc(signReport(forge({ reportData: bind(hostSpki) })), auxblob(fakeVcekDer));
t = await J(signedFake, hostSpki, 'trusted');
check('N2 forgery signed with a host-made VCEK: REJECTED on the chain to AMD\'s pinned root, not on the signature',
  t.verdict === 'reject' && !t.gateOpen && /chain/.test(t.reasons.at(-1))
    && !/signature over the report is invalid|cert-chain verification error/.test(t.reasons.at(-1)), t.reasons.at(-1));
l = await J(signedFake, hostSpki, 'lab-unsigned');
check('N2b the same in lab-unsigned: a chain that is offered and fails is a REJECT there too', l.verdict === 'reject', l.reasons.at(-1));
const tampered = t1doc(signReport(forge({ reportData: bind(hostSpki) })), auxblob(fakeVcekDer));
const raw = Buffer.from(tampered.report, 'base64'); raw[0x10] ^= 1; tampered.report = raw.toString('base64');   // family_id: no field check reads it
t = await J(tampered, hostSpki, 'trusted');
check('N2c one signed byte changed after signing: REJECTED on the signature', t.verdict === 'reject' && /signature over the report is invalid/.test(t.reasons.at(-1)), t.reasons.at(-1));

// N3-N6: field checks still refuse bad fields even in the lab diagnostic
l = await J(t1doc(forge({ reportData: bind(hostSpki), policy: 0x30000n | (1n << 19n) })), hostSpki, 'lab-unsigned');
check('N3 DEBUG in the guest policy: REJECTED', l.verdict === 'reject' && /DEBUG/.test(l.reasons.at(-1)), l.reasons.at(-1));
l = await J(t1doc(forge({ reportData: bind(hostSpki), meas: 'ab'.repeat(48) })), hostSpki, 'lab-unsigned');
check('N4 measurement not on the allowlist: REJECTED', l.verdict === 'reject' && /allowlist/.test(l.reasons.at(-1)), l.reasons.at(-1));
l = await J(t1doc(forge({ reportData: bind(hostSpki, nonce, 'cd'.repeat(32)) })), hostSpki, 'lab-unsigned');
check('N5 report_data names another app: REJECTED', l.verdict === 'reject' && /name the expected app/.test(l.reasons.at(-1)), l.reasons.at(-1));
l = await J(t1doc(forge({ reportData: bind(domainSpki) })), hostSpki, 'lab-unsigned');
check('N6 report binds the domain key but the handshake showed the host key: REJECTED', l.verdict === 'reject' && /does not bind/.test(l.reasons.at(-1)), l.reasons.at(-1));
l = await J(t1doc(forge({ reportData: bind(hostSpki) })), hostSpki, 'lab-unsigned', randomBytes(32));
check('N6b report for another nonce (replay): REJECTED', l.verdict === 'reject' && /does not bind/.test(l.reasons.at(-1)), l.reasons.at(-1));

// N7-N8: the T0 path is its own explicit mode, never trusted
const t0doc = { tier: 'T0', format: 'none', reason: 'T0 domain' };
const [a, b, c] = await Promise.all(['trusted', 'lab-unsigned', 't0-diagnostic'].map((m) => J(t0doc, hostSpki, m)));
check('N7 a T0 domain: gate closed in trusted and lab-unsigned, open only in t0-diagnostic, never "attested"',
  !a.gateOpen && !b.gateOpen && c.gateOpen && [a, b, c].every((x) => x.verdict === 'not-attested'));
t = await J(unsignedForHost, hostSpki, 't0-diagnostic');
check('N8 a T1 document in t0-diagnostic mode: REJECTED (the modes do not mix)', t.verdict === 'reject' && !t.gateOpen, t.reasons.at(-1));

// N9: the genuine report from a live SNP domain (client --save), when there is one
if (opt('--genuine')) {
  const g = JSON.parse(fs.readFileSync(opt('--genuine'), 'utf8'));
  const gs = Buffer.from(g.spki, 'base64'), gn = Buffer.from(g.nonce, 'hex');
  t = await judge(g.doc, gs, gn, want('trusted'));
  l = await judge(g.doc, gs, gn, want('lab-unsigned'));
  console.log(`evidence: genuine report, trusted: ${t.verdict} (${t.reasons.at(-1)})`);
  console.log(`evidence: genuine report, lab-unsigned: ${l.verdict}`);
  check('N9 the genuine report: "attested" only with the AMD chain verified; otherwise trusted mode refuses it',
    t.verdict === 'attested' ? t.reasons.some((s) => s.startsWith('AMD signature chain verified')) : (t.verdict === 'reject' && !t.gateOpen));
  check('N9b the genuine report in lab-unsigned is never better than "unauthenticated" without the chain',
    t.verdict === 'attested' || l.verdict === 'unauthenticated', l.verdict);
}
console.log(fails ? `NEGATIVE: ${fails} FAILED` : 'NEGATIVE: ALL PASS');
process.exit(fails ? 1 : 0);
