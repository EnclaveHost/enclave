// Android pVM recipients for custody v2 (custody/v2/avf-*.mjs; custodian.mjs `avf`). Two kinds of fixture, named in every
// test title:
//   REAL       the Pixel 10 Pro XL pVM's own AVF chain and v4 evidence (test/fixtures/pvm-v4/host-live-20261016.json: the
//              installed build, code hash ff559327...), and Google's attestation status list as fetched on 2026-10-21
//              (test/fixtures/google/attestation-status-20261021.json);
//   SYNTHETIC  an AVF chain under an openssl CA (test/fixtures/avf-synthetic.mjs), accepted only through the adapter's test
//              root pins, so every verdict says "synthetic". No custody release over a real AVF certificate can be made off
//              the device: the certificate is minted inside the pVM for the challenge it asks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import * as v2 from "../custody/v2/protocol.mjs";
import { parseRules } from "../custody/rules.mjs";
import { parseShieldRules } from "../custody/v2/shield-rules.mjs";
import { parseAvfRules, canonicalAvfRules, avfAdmittedImages, AVF_TIER_ACK } from "../custody/v2/avf-rules.mjs";
import { createAvfStatusList, parseStatusList, serialKey, chainSerials } from "../custody/v2/avf-status.mjs";
import { createAvfCustody, avfReleaseChallenge, AVF_EVIDENCE_FORMAT } from "../custody/v2/avf-evidence.mjs";
import { validateAvfOperator, avfCustodyFor, defaultAvfLimits, AVF_OPERATOR_FORMAT } from "../custody/v2/avf-operator.mjs";
import { custodianMeasured } from "../custody/v2/build-config.mjs";
import { policyRulesOf } from "../custody/v2/owner-secrets.mjs";
import { rulesFromObject, describeRules } from "../cli/custody-independent.mjs";
import { verifyAvfEvidence, GOOGLE_ATTESTATION_ROOT_SHA256 } from "../relay/avf-verify.mjs";
import { pvmEvidenceRules } from "../relay/pvm-evidence-core.mjs";
import * as R from "./helpers/avf-custody-rig.mjs";

const REAL_V4 = JSON.parse(fs.readFileSync(new URL("./fixtures/pvm-v4/host-live-20261016.json", import.meta.url)));
const realChain = () => REAL_V4.doc.chain.map((c) => Buffer.from(c, "base64"));
const sha = (b) => createHash("sha256").update(b).digest();

// ---------------------------------------------------------------------------------------------------------------- rules
test("AVF rules: a distinct owner-committed format; SNP and Shield rules never parse as AVF rules, nor the reverse", () => {
  const r = R.avfRules();
  assert.deepEqual(parseAvfRules(canonicalAvfRules(r)), JSON.parse(Buffer.from(canonicalAvfRules(r)).toString()));
  assert.throws(() => parseRules(canonicalAvfRules(r)), /unknown key|required/);
  assert.throws(() => parseShieldRules(canonicalAvfRules(r)), /unknown key|format|required/);
  const snp = { v: 1, appId: R.APP, images: [{ platform: "sev-snp", measurement: "ab".repeat(48), runtimeId: R.hex(R.RID) }], minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
  assert.throws(() => parseAvfRules(JSON.stringify(snp)), /unknown key|required/);
  // custody/rules.mjs is unchanged: "avf-pvm" inside SNP rules is still refused by name
  assert.throws(() => parseRules(JSON.stringify({ ...snp, images: [{ platform: "avf-pvm", measurement: "ab".repeat(48), runtimeId: R.hex(R.RID) }] })), /Android pVM/);
  assert.throws(() => parseAvfRules(canonicalAvfRules({ ...r, acceptTier: AVF_TIER_ACK.replace("revocation-checked", "unchecked") })), /acceptTier/);
  assert.throws(() => canonicalAvfRules({ ...r, images: [{ ...r.images[0], authorityHash: "ab".repeat(32) }] }), /128 lowercase hex/);
  assert.throws(() => canonicalAvfRules({ ...r, instances: [] }), /instances/);
  assert.throws(() => canonicalAvfRules({ ...r, images: [r.images[0], r.images[0]] }), /repeats/);
  assert.deepEqual(avfAdmittedImages(r, R.hex(R.RID)), [{ codeHash: R.CODE_HASH, authorityHash: R.AUTH_HASH }]);
  assert.deepEqual(avfAdmittedImages(r, "00".repeat(32)), []);
  // the owner-read path reads AVF rules by their own format
  assert.equal(policyRulesOf(canonicalAvfRules({ ...r, ownerRead: true })).kind, "avf");
  assert.equal(policyRulesOf(canonicalAvfRules({ ...r, ownerRead: true })).ownerRead, true);
  assert.equal(policyRulesOf(canonicalAvfRules(r)).ownerRead, false);
  // the owner's CLI (enclave --independent custody set --rules) writes them by their own format and reads them back as such
  const w = rulesFromObject({ ...r, ownerRead: true });
  assert.equal(w.kind, "avf");
  assert.deepEqual(Buffer.from(w.bytes), Buffer.from(canonicalAvfRules({ ...r, ownerRead: true })));
  assert.equal(describeRules(w.bytes).kind, "avf");
  assert.match(describeRules(w.bytes).tier, /android-avf-pvm\/pkvm\/google-rkp\/revocation-checked \(Android pVM rules\)/);
});

// ------------------------------------------------------------------------------------------------- REAL: status list
test("REAL Google attestation status list (2026-10-21): parses strictly; serial keys normalize as Google writes them", () => {
  const bytes = R.realStatusBytes();
  assert.equal(sha(bytes).toString("hex"), "e59e67bf6dac42bd0a2fda963a3a85c09d6db6fd4742ae06d7d760c7c4ee80c8");
  const m = parseStatusList(bytes);
  assert.equal(m.size, 1763);
  assert.ok([...m.values()].every((e) => e.status === "REVOKED"));
  assert.equal(serialKey("00C35747A084470C3135AEEFE2B8D40CD6"), "c35747a084470c3135aeefe2b8d40cd6");
  assert.ok(m.has("c35747a084470c3135aeefe2b8d40cd6"));
  assert.throws(() => parseStatusList(Buffer.from('{"entries":{"zz":{"status":"REVOKED"}}}')), /non-hex/);
  assert.throws(() => parseStatusList(Buffer.from('{"entries":[]}')), /no entries/);
  assert.throws(() => parseStatusList(Buffer.from('{"entries":{"ab":{}}}')), /no status/);
});

test("REAL Pixel 10 Pro XL chain against the REAL status list: not revoked; listing its intermediate revokes it; no list = unknown", async () => {
  const serials = chainSerials(realChain());
  assert.equal(serials.length, REAL_V4.doc.chain.length);
  const good = createAvfStatusList({ fetchImpl: R.statusFetch() });
  assert.equal((await good.check(serials)).state, "good");
  const inter = new X509Certificate(realChain()[1]);
  const revoked = createAvfStatusList({ fetchImpl: R.statusFetch({ extra: { [serialKey(inter.serialNumber)]: { status: "REVOKED", reason: "KEY_COMPROMISE" } } }) });
  const r = await revoked.check(serials);
  assert.equal(r.state, "revoked"); assert.match(r.reason, /REVOKED \(KEY_COMPROMISE\)/);
  const suspended = createAvfStatusList({ fetchImpl: R.statusFetch({ extra: { [serials[0]]: { status: "SUSPENDED" } } }) });
  assert.equal((await suspended.check(serials)).state, "revoked", "any listed status refuses");
  // the list cannot be read: unknown, never good (fail closed)
  const down = createAvfStatusList({ fetchImpl: R.statusFetch({ fail: true }) });
  const u = await down.check(serials);
  assert.equal(u.state, "unknown"); assert.match(u.reason, /unavailable/);
  // a good copy serves until maxAge, then refuses even while the network is down
  let t = Date.parse("2026-10-21T03:00:00Z"); const flaky = R.statusFetch(); let fail = false;
  const aging = createAvfStatusList({ fetchImpl: async (...a) => { if (fail) throw new Error("down"); return flaky(...a); }, now: () => t, maxAgeMs: 3600_000 });
  assert.equal((await aging.check(serials)).state, "good");
  fail = true; t += 40 * 60_000;
  assert.equal((await aging.check(serials)).state, "good", "a 40-minute-old copy still serves while a refresh fails");
  t += 30 * 60_000;
  assert.equal((await aging.check(serials)).state, "unknown", "past maxAge: refused");
  assert.throws(() => createAvfStatusList({ maxAgeMs: 2 * 86400_000 }), /maxAgeMs/);
});

// ------------------------------------------------------------------------------------------------ REAL: AVF verifier
test("REAL Pixel chain: genuine under Google's pinned roots for its own relay challenge; replayed as custody evidence it is refused AT THE CHALLENGE", async () => {
  // the chain is real: its own challenge (Bind3 || app over the relay's nonce) verifies at its capture time
  const rules = pvmEvidenceRules({ sha256: (b) => sha(b), ed25519Verify: () => true, isP256Spki: () => true, verifyAvf: verifyAvfEvidence });
  const rid = rules.runtimeId(JSON.parse(REAL_V4.doc.identity));
  const iid = rules.instanceIdOf(Buffer.from(REAL_V4.doc.instanceKey, "hex"));
  const challenge = Buffer.concat([rules.bind3(Buffer.from(REAL_V4.doc.spki, "hex"), Buffer.from(REAL_V4.nonce, "hex"), rid, iid), Buffer.from(REAL_V4.appSha256, "hex")]);
  const at = Date.parse(REAL_V4.capturedAt);
  const own = verifyAvfEvidence({ chain: realChain(), challenge }, { allowedCodeHashes: [REAL_V4.codeHash], allowedAuthorityHashes: [REAL_V4.authorityHash], now: at });
  assert.equal(own.ok, true, own.reasons.join("; "));
  assert.equal(own.measurement, REAL_V4.codeHash);
  // the same real chain, carried into a custody release: every check before the challenge passes on real bytes (Google
  // root, signatures, dates at capture, CA bits), and the challenge (which names THIS release's binding) refuses it
  const custody = createAvfCustody({ statusList: createAvfStatusList({ fetchImpl: R.statusFetch() }), now: () => at });
  const d = REAL_V4.doc;
  const doc = { abi: "enclave-domain-abi/2", appSha256: d.app, chain: d.chain, format: AVF_EVIDENCE_FORMAT, identity: d.identity, instanceKey: d.instanceKey,
                instanceSig: d.instanceSig, runtime: JSON.parse(d.identity), selftest: d.selftest, spki: d.spki, transportKey: Buffer.from(d.spki, "hex").toString("base64") };
  const v = await custody.verify({ doc, allowedMeasurements: [{ codeHash: REAL_V4.codeHash, authorityHash: REAL_V4.authorityHash }], binding: sha(Buffer.from("a release")),
                                   appId: Buffer.from(d.app, "hex"), rules: {} });
  assert.equal(v.ok, false);
  assert.match(v.reason, /attestationChallenge does not match ours/);
  assert.doesNotMatch(v.reason, /synthetic/, "production pins: Google's roots");
  // today (2026-10-21) the same chain is past its RKP validity: the custodian's own clock refuses it before anything else
  const today = createAvfCustody({ statusList: createAvfStatusList({ fetchImpl: R.statusFetch() }), now: () => Date.parse("2026-10-21T03:00:00Z") });
  const t = await today.verify({ doc, allowedMeasurements: [{ codeHash: REAL_V4.codeHash, authorityHash: REAL_V4.authorityHash }], binding: sha(Buffer.from("a release")),
                                 appId: Buffer.from(d.app, "hex"), rules: {} });
  assert.equal(t.ok, false);
  assert.match(t.reason, /expired|attestationChallenge/);
  assert.ok([...GOOGLE_ATTESTATION_ROOT_SHA256.values()].includes(new X509Certificate(realChain().at(-1)).fingerprint256.replace(/:/g, "").toLowerCase()), "the real chain's root is a pinned Google root");
});

// ---------------------------------------------------------------------------------------------- operator / measured
test("AVF operator opt-in: measured, validated twice, absent by default (the measured text is unchanged without it)", () => {
  const cfg = { format: AVF_OPERATOR_FORMAT, acceptTier: AVF_TIER_ACK, limits: defaultAvfLimits() };
  assert.deepEqual(validateAvfOperator(cfg), cfg);
  assert.throws(() => validateAvfOperator({ ...cfg, rootPins: ["ab".repeat(32)] }), /unknown key/, "no operator-chosen roots");
  assert.throws(() => validateAvfOperator({ ...cfg, limits: { ...cfg.limits, statusMaxAgeSec: 7 * 86400 } }), /statusMaxAgeSec/);
  assert.throws(() => validateAvfOperator({ ...cfg, acceptTier: "android" }), /acceptTier/);
  const vault = "0x" + "5a".repeat(20), hostOwnership = "0x" + "6b".repeat(20);
  const off = custodianMeasured({ vault, hostOwnership });
  assert.equal("avfRecipients" in off.measured, false);
  const on = custodianMeasured({ vault, hostOwnership, avfRecipients: cfg });
  assert.deepEqual(on.measured.avfRecipients, cfg);
  assert.throws(() => custodianMeasured({ vault, hostOwnership, transport: "tunnel", avfRecipients: cfg }), /needs --transport direct/);
  assert.equal(avfCustodyFor(null), null);
  const a = avfCustodyFor(cfg, { fetchImpl: R.statusFetch() });
  assert.equal(a.tier, "avf-pvm"); assert.equal(a.synthetic, false);
});

// ------------------------------------------------------------------------------------- SYNTHETIC: the custodian path
const world = R.options.skip ? null : R.avfWorld();
function rig({ flags = [true, false, false, false], ...opts } = {}) {
  const com = R.committee(flags), { label, bundle } = R.ownerBundle(com);
  const cs = R.custodians(com, { bundle, roots: world, ...opts });
  return { com, label, bundle, cs };
}
async function releaseAll(r, reqOpts = {}) {
  const g = await R.guestRequest(r.cs, { world, ...reqOpts });
  const answers = [];
  for (const c of r.cs) answers.push(await c.release(g.req).then((a) => ({ ok: true, a }), (e) => ({ ok: false, e })));
  return { g, answers };
}

test("SYNTHETIC AVF chain: a pVM release through REAL custodians (4 machines, Enclave seat, t=3) opens the owner's values; verdicts say synthetic", R.options, async () => {
  const r = rig();
  assert.equal(r.com.t, 3);
  const { g, answers } = await releaseAll(r);
  for (const x of answers) assert.equal(x.ok, true, x.e && x.e.message);
  const verified = answers.flatMap((x) => R.openAnswer(x.a, { recipient: g.recipient, binding: g.binding, bundle: r.bundle, com: r.com }));
  const S = v2.combine(verified.slice(0, 3), 3);
  const opened = v2.decryptBundle({ S, label: r.label, bundle: r.bundle });
  assert.deepEqual(opened.env, R.SECRETS);
  assert.equal(opened.configSha256, sha(Buffer.from(R.CONFIG_TEXT)).toString("hex"));
});

test("SYNTHETIC AVF chain: every refusal names its reason (format, rules, app, pair, runtime, instance, signature, challenge, nonce, debug VM)", R.options, async () => {
  const code = async (r, reqOpts) => { const { answers } = await releaseAll(r, reqOpts); const x = answers[0]; assert.equal(x.ok, false, "must refuse"); return `${x.e.code}: ${x.e.message}`; };
  // no adapter installed: the custodian is exactly as before (AVF rules do not parse as SNP rules; under SNP rules the
  // AVF format has no verifier)
  const snpRules = JSON.stringify({ v: 1, appId: R.APP, images: [{ platform: "sev-snp", measurement: "ab".repeat(48), runtimeId: R.hex(R.RID) }], minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 });
  assert.match(await code(rig({ withAvf: false })), /bad_rules: The deployment's rules do not parse: rules: unknown key/);
  assert.match(await code(rig({ withAvf: false, rules: Buffer.from(snpRules) })), /unsupported_evidence/);
  // SNP rules on chain with the adapter installed: an AVF document is not admitted by them
  assert.match(await code(rig({ rules: Buffer.from(snpRules) })), /bad_rules: .*Android pVM/);
  assert.match(await code(rig(), { doc: { appId: "ee".repeat(32) } }), /evidence_refused: .*another app/);
  // the APK's authority admitted, but with another code hash: the PAIR is checked, not the two lists
  const pairRules = R.avfRules({ images: [{ codeHash: "11".repeat(32), authorityHash: R.AUTH_HASH, runtimeId: R.hex(R.RID) }, { codeHash: R.CODE_HASH, authorityHash: "22".repeat(64), runtimeId: R.hex(R.RID) }] });
  assert.match(await code(rig({ rules: canonicalAvfRules(pairRules) })), /evidence_refused: .*(pair|unpinned authority)/);
  assert.match(await code(rig({ rules: canonicalAvfRules(R.avfRules({ images: [{ codeHash: R.CODE_HASH, authorityHash: R.AUTH_HASH, runtimeId: "77".repeat(32) }] })) })), /runtime_not_admitted/);
  assert.match(await code(rig({ rules: canonicalAvfRules(R.avfRules({ instances: ["88".repeat(32)] })) })), /evidence_refused: .*not one the owner bound/);
  const other = R.vmKeys();
  assert.match(await code(rig(), { doc: { signWith: other.instance } }), /evidence_refused: .*instanceSig/);
  assert.match(await code(rig(), { doc: { bendChallenge: true } }), /evidence_refused: .*attestationChallenge/);
  assert.match(await code(rig(), { doc: { over: { nonce: "00".repeat(32) } } }), /evidence_refused: .*nonce/);
  assert.match(await code(rig(), { doc: { attestOpts: { secure: false } } }), /evidence_refused: .*isVmSecure=false/);
  assert.match(await code(rig(), { doc: { selftest: "exec_pages=allowed wx=dirty maps=1 scope=self" } }), /evidence_refused: .*wx=/);
  assert.match(await code(rig(), { doc: { identity: JSON.stringify({ ...R.RUNTIME, version: "49.0.0 " }) } }), /evidence_refused: .*canonical/);
  // the operator: the lease holder's registered operator, as for every platform
  assert.match(await code(rig(), { opSigner: R.stranger }), /operator_sig/);
  // every refusal from a test-root verifier says synthetic
  assert.match(await code(rig(), { doc: { bendChallenge: true } }), /synthetic roots/);
});

test("SYNTHETIC AVF chain + REAL status list: a revoked chain certificate, or no fresh list, refuses the release", R.options, async () => {
  // which serial the synthetic intermediate has: list it (as Google would list a compromised RKP intermediate)
  const interSerial = serialKey(new X509Certificate(world.inter).serialNumber);
  const revoked = createAvfStatusList({ fetchImpl: R.statusFetch({ extra: { [interSerial]: { status: "REVOKED", reason: "KEY_COMPROMISE" } } }) });
  const r1 = rig({ statusList: revoked });
  const { answers } = await releaseAll(r1);
  assert.ok(answers.every((x) => !x.ok && /REVOKED \(KEY_COMPROMISE\)/.test(x.e.message)));
  const down = createAvfStatusList({ fetchImpl: R.statusFetch({ fail: true }) });
  const r2 = rig({ statusList: down });
  const b = await releaseAll(r2);
  assert.ok(b.answers.every((x) => !x.ok && /revocation unknown/.test(x.e.message)));
});

test("SYNTHETIC AVF chain: a release document is single-use (each custodian's challenge is consumed)", R.options, async () => {
  const r = rig();
  const { g, answers } = await releaseAll(r);
  assert.ok(answers.every((x) => x.ok));
  await assert.rejects(r.cs[0].release(g.req), (e) => e.code === "bad_challenge");
});

test("the challenge bytes: SHA-256(domain || binding || InstanceID) || AppID (the Go guest pins the same vector file)", () => {
  const vec = JSON.parse(fs.readFileSync(new URL("./fixtures/avf-custody-challenge-vector.json", import.meta.url)));
  const [binding, instanceId, appId] = ["binding", "instance", "app"].map((s) => sha(Buffer.from(s)));
  assert.deepEqual([vec.binding, vec.instanceId, vec.appId], [binding, instanceId, appId].map((b) => b.toString("hex")));
  const c = avfReleaseChallenge({ binding, instanceId, appId });
  assert.equal(c.subarray(0, 32).toString("hex"), sha(Buffer.concat([Buffer.from("enclave-custody-avf-v1\n"), binding, instanceId])).toString("hex"));
  assert.equal(c.toString("hex"), vec.challenge);
});
