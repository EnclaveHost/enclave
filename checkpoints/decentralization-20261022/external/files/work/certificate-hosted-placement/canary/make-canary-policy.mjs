#!/usr/bin/env node
// Hardware canary preparation (NOTHING applied): the Enclave Shield policy for the first real-hardware run, derived from the
// ACTUAL Shield-direct candidate record (isolation/m3/shield-direct-candidate-20261020/candidate.json) and the repository's
// pinned TPM EK roots (relay/fixtures/tpm-roots.pem: the AMD fTPM chain, byte-identical to the ekRoots of
// windows/installer/admitted-shield-policy.json). It pins ONLY the candidate's (VBS launch digest, RuntimeID): an old
// allowlist is never reused (docs/network/independent-shield-image.md, hardware gate 1). Validated with the production
// validators (relay/dns-challenge-shield.mjs validateShieldResponderPolicy, a real createShieldChallengeAuth and
// createAppZoneShield construction, relay/vbs-verify.mjs loadTpmRoots). Launcher-only (hvcert) evidence is not and cannot
// be admitted by this policy: every pair needs the guest's own VBS report.
//   node make-canary-policy.mjs <tree> <outdir>
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [tree, out] = process.argv.slice(2).map((p) => path.resolve(p));
if (!tree || !out) { console.error('usage: make-canary-policy.mjs <tree> <outdir>'); process.exit(2); }
const imp = (p) => import(pathToFileURL(path.join(tree, p)).href);
const {validateShieldResponderPolicy, createShieldChallengeAuth} = await imp('relay/dns-challenge-shield.mjs');
const {createAppZoneShield} = await imp('network/app-zone-shield.mjs');
const {loadTpmRoots} = await imp('relay/vbs-verify.mjs');
const rec = JSON.parse(fs.readFileSync(path.join(tree, 'isolation/m3/shield-direct-candidate-20261020/candidate.json'), 'utf8'));
const readme = fs.readFileSync(path.join(tree, 'isolation/m3/shield-direct-candidate-20261020/README.md'), 'utf8');
const digest = String(rec.candidate.digest).toLowerCase(), runtimeId = String(rec.runtimeId).toLowerCase();
const must = (ok, why) => { if (!ok) { console.error('refused: ' + why); process.exit(1); } };
must(/^[0-9a-f]{64}$/.test(digest) && /^[0-9a-f]{64}$/.test(runtimeId), 'the candidate record has no 64-hex VBS digest and RuntimeID');
must(readme.includes(`VBS digest: \`${digest}\``) && readme.includes(`RuntimeID: \`${runtimeId}\``), 'the candidate README and record disagree');
must(rec.hardwareActivated === false, 'the record no longer says not hardware-activated; re-review before reusing this preparation');
must(Array.isArray(rec.initrd?.frontBuildTags) && rec.initrd.frontBuildTags.includes('shielddirect') && rec.initrd.frontBuildTags.includes('bootstrapdirect'),
  'the candidate front was not built with the Shield-direct tags');
const roots = fs.readFileSync(path.join(tree, 'relay/fixtures/tpm-roots.pem'), 'utf8');
const admitted = JSON.parse(fs.readFileSync(path.join(tree, 'windows/installer/admitted-shield-policy.json'), 'utf8'));
must(admitted.ekRoots === roots, 'relay/fixtures/tpm-roots.pem is not the admitted policy\'s ekRoots');
must(!admitted.images.some((i) => i.measurement === digest), 'the candidate digest unexpectedly appears in the legacy admitted policy');
const anchors = loadTpmRoots(roots);
must(anchors.roots.length >= 1, 'no self-signed TPM root in the pinned bundle');
const policy = {schema: 'enclave-shield-app-policy/1', ekRoots: roots, platforms: 'attested', images: [{measurement: digest, runtimeId}]};
validateShieldResponderPolicy(policy);
const entry = async () => null, recoverSigner = async () => null;
createShieldChallengeAuth({policy, zone: 'canary.owner.example', registryEntry: entry, recoverSigner});
createAppZoneShield({policy, zone: 'app.enclave.host', registryEntry: entry, recoverSigner});
fs.mkdirSync(out, {recursive: true});
const bytes = Buffer.from(JSON.stringify(policy, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'shield-app-policy.candidate-6a3135a9.json'), bytes);
const sum = {policyFile: 'shield-app-policy.candidate-6a3135a9.json', policySha256: createHash('sha256').update(bytes).digest('hex'),
  candidate: {imageSha256: 'c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec', vbsDigest: digest, runtimeId, frontSourceCommit: rec.sourceCommit,
    frontBuildTags: rec.initrd.frontBuildTags, hardwareActivated: rec.hardwareActivated},
  ekRoots: {file: 'relay/fixtures/tpm-roots.pem', sha256: createHash('sha256').update(roots).digest('hex'), rootPins: anchors.pins, intermediates: anchors.intermediates.length},
  admits: 'only the guest\'s own VBS report from this exact image under a TPM session the verifier ran; never launcher-only (hvcert) evidence',
  validatedWith: ['validateShieldResponderPolicy', 'createShieldChallengeAuth', 'createAppZoneShield', 'loadTpmRoots']};
fs.writeFileSync(path.join(out, 'canary-policy-summary.json'), JSON.stringify(sum, null, 1) + '\n');
console.log(JSON.stringify(sum));
