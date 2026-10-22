// The Android pVM custody rig shared by test/custody-v2-avf.test.mjs and the Go guest's end-to-end harness
// (test/helpers/avf-custody-e2e-server.mjs). REAL pieces: the custodian (createCustodianV2 with the AVF adapter), the v2
// protocol (committee shares by a real deal, a real owner bundle with its label proof, DLEQ partials, HPKE), Google's REAL
// attestation status list as fetched on 2026-10-21 (test/fixtures/google/attestation-status-20261021.json). SYNTHETIC
// pieces, and marked so: the AVF chain (an openssl CA standing in for Google's RKP; test/fixtures/avf-synthetic.mjs), which
// the custodian accepts only through createAvfCustody's test root pins, so every verdict says "synthetic"; and the chain
// state the custodian reads (an agreed read, in memory).   Needs openssl.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { haveOpenssl, tmpdir, makeCa, issueLeaf, extension, CODE, AUTH } from "../fixtures/avf-synthetic.mjs";
import { runtimeId } from "../../isolation/contract/runtime.mjs";
import * as v2 from "../../custody/v2/protocol.mjs";
import * as hpke from "../../custody/hpke.mjs";
import { createCustodianV2 } from "../../custody/v2/custodian.mjs";
import { createAvfCustody, avfReleaseChallenge, AVF_EVIDENCE_FORMAT } from "../../custody/v2/avf-evidence.mjs";
import { createAvfStatusList } from "../../custody/v2/avf-status.mjs";
import { canonicalAvfRules, AVF_RULES_FORMAT, AVF_TIER_ACK } from "../../custody/v2/avf-rules.mjs";
import { canonical, instanceSigMessage } from "../../relay/pvm-evidence-core.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const REAL_STATUS_FILE = path.join(HERE, "..", "fixtures", "google", "attestation-status-20261021.json");
export const options = { skip: !haveOpenssl && "openssl absent" };
export const sha = (b) => createHash("sha256").update(b).digest(), hex = (b) => Buffer.from(b).toString("hex"), b64 = (b) => Buffer.from(b).toString("base64");

// the pVM's real runtime identity (test/fixtures/pvm-v4/host-live-20261016.json) and self-test tuple
export const RUNTIME = { cache: "none", cpuFeatures: "baseline", execution: "interpreter", hostIsa: "aarch64", name: "wasmtime", targetIsa: "pulley64", version: "49.0.0", wx: "enforced" };
export const IDENTITY = canonical(RUNTIME).toString();
export const SELFTEST = "exec_pages=refused:EACCES wx=clean maps=1 scope=self";
export const RID = runtimeId(RUNTIME);
export const APP = "3577d2168a65f9d4e28d4cb4c955ed7937102a1f1701f123f5f3f6a85b423195";   // the real served component's sha256
export const CODE_HASH = hex(CODE), AUTH_HASH = hex(AUTH);                                // the SYNTHETIC APK (avf-synthetic.mjs)
export const CHAIN_ID = 8453, VAULT = "0x" + "5a".repeat(20), DEP = "0x" + "e7".repeat(32), COMMITTEE = "0x" + "cc".repeat(32);
export const ENDPOINT = "https://pixel10-pvm-cpu.example.org", OWNER = "0x" + "33".repeat(20);
export const operator = privateKeyToAccount("0x" + "42".repeat(32)), stranger = privateKeyToAccount("0x" + "43".repeat(32));
export const SECRETS = { API_KEY: "s3cret-value", DB_PASSWORD: "hunter2-but-longer" };
export const CONFIG_TEXT = '{"api":"$API_KEY","db":{"password":"${DB_PASSWORD}"}}';

export const avfRules = (over = {}) => ({ format: AVF_RULES_FORMAT, acceptTier: AVF_TIER_ACK, appId: APP,
  images: [{ codeHash: CODE_HASH, authorityHash: AUTH_HASH, runtimeId: hex(RID) }], ...over });

// ---- Google's REAL status list, served to the custodian's own fetch (optionally with extra entries a test adds) ----
export const realStatusBytes = () => fs.readFileSync(REAL_STATUS_FILE);
export function statusFetch({ extra = {}, fail = false, bytes = null } = {}) {
  let calls = 0;
  const f = async () => {
    calls++;
    if (fail) throw new Error("network unreachable");
    let body = bytes || realStatusBytes();
    if (Object.keys(extra).length) { const d = JSON.parse(body); Object.assign(d.entries, extra); body = Buffer.from(JSON.stringify(d)); }
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  f.calls = () => calls;
  return f;
}

// ---- the SYNTHETIC AVF service: a CA, and a leaf over a challenge (AVmPayload_requestAttestation's stand-in) ----
export function avfWorld(dir = tmpdir("avf-custody-")) {
  const ca = makeCa(dir);
  return { dir, ...ca, attest(challenge, { code = CODE, auth = AUTH, secure = true } = {}) {
    const { leaf } = issueLeaf(dir, { ext: extension({ challenge: Buffer.from(challenge), code, auth, secure }) });
    return [leaf, ca.inter, ca.root];
  } };
}
// the VM's two Ed25519 keys (the boot's transport key; the instance key, INSTANCE-BINDING.md)
export function vmKeys() {
  const mk = () => { const k = generateKeyPairSync("ed25519"); return { privateKey: k.privateKey, spki: k.publicKey.export({ type: "spki", format: "der" }) }; };
  const transport = mk(), instance = mk();
  return { transport, instance, instanceId: sha(instance.spki) };
}
/** the release document exactly as isolation/m2/pvmcustody avf.go writes it */
export function avfDoc({ world, keys, binding, appId = APP, runtime = RUNTIME, identity = canonical(runtime).toString(), selftest = SELFTEST, attestOpts = {},
                         bendChallenge = false, signWith = null, over = {} }) {
  const challenge = avfReleaseChallenge({ binding: bendChallenge ? sha(Buffer.from("another binding")) : binding, instanceId: keys.instanceId, appId: Buffer.from(appId, "hex") });
  const chain = world.attest(challenge, attestOpts);
  const instanceSig = sign(null, instanceSigMessage(challenge), (signWith || keys.instance).privateKey);
  return { abi: "enclave-domain-abi/2", appSha256: appId, chain: chain.map(b64), format: AVF_EVIDENCE_FORMAT, identity, instanceKey: hex(keys.instance.spki),
           instanceSig: hex(instanceSig), runtime, selftest, spki: hex(keys.transport.spki), transportKey: b64(keys.transport.spki), ...over };
}

// ---- a committee: machines (Enclave flags) -> the seat layout, shares by a real deal of one secret, Feldman commitments ----
export function committee(flags) {
  const lay = v2.seatLayout(flags.map((e) => ({ enclave: e })));
  const g = v2.genesis();
  const W = lay.W, d = v2.deal({ x: g.shares[0].x, tNew: lay.t, newIndices: Array.from({ length: W }, (_, i) => i + 1) });
  const machines = flags.map((enclave, i) => { const kp = hpke.generateKeyPair(); return { enclave, kp, encKeyHex: hex(kp.publicKey), indices: lay.indicesOf(i) }; });
  return { lay, Y: g.Y, t: lay.t, commitments: d.commitments, machines, shareOf: (k) => d.sub.get(k) };
}
export function ownerBundle(com, { env = SECRETS, configText = CONFIG_TEXT } = {}) {
  const label = v2.labelOf({ chainId: CHAIN_ID, vault: VAULT, id: DEP, secretRev: 1n, committeeId: COMMITTEE });
  return { label, bundle: v2.encryptBundle({ Y: com.Y, label, env, configSha256: hex(sha(Buffer.from(configText))) }) };
}

// ---- custodians (the REAL createCustodianV2) over one agreed chain read ----
export function custodians(com, { rules = canonicalAvfRules(avfRules()), bundle, withAvf = true, statusList = null, avfNow = Date.now, owner = OWNER,
                                  endpointOperator = operator.address.toLowerCase(), runner = ENDPOINT, roots, liar = -1 } = {}) {
  const state = () => ({ blockNumber: 100n, blockTimestamp: Math.floor(Date.now() / 1000),
    policy: { owner, policyRev: 1n, secretRev: 1n, committeeId: COMMITTEE, paused: false, rules: Buffer.from(rules) },
    bundle: { committeeId: COMMITTEE, secretRev: 1n, data: bundle },
    committee: { epoch: 1, machines: com.machines.map((m) => ({ encKey: "0x" + m.encKeyHex })), commitments: Buffer.concat(com.commitments.map((c) => Buffer.from(c))) },
    beneficialOwner: owner, lease: { owner, runner: keccak256(toBytes(runner)).toLowerCase(), leaseUntil: Math.floor(Date.now() / 1000) + 3600 },
    endpointId: keccak256(toBytes(ENDPOINT)).toLowerCase(), endpointOperator });
  const list = statusList || createAvfStatusList({ fetchImpl: statusFetch() });
  return com.machines.map((m, i) => {
    const held = m.indices.map((k) => ({ k, x: i === liar ? (com.shareOf(k) + 1n) % v2.Q : com.shareOf(k) }));   // a liar: a wrong share
    const avf = withAvf ? createAvfCustody({ statusList: list, now: avfNow, rootPins: [roots.rootPin] }) : null;
    return createCustodianV2({ chainId: CHAIN_ID, vault: VAULT, encPrivateKey: m.kp.privateKey, shares: { get: () => held }, chain: { readRelease: async () => state() },
      verifiers: Object.freeze({ "sev-snp-guest-domain-v1": async () => ({ ok: false, reason: "SNP verifier: not SNP evidence" }) }), avf, log: () => {} });
  });
}

// ---- the guest, in JS (the Go client is the product; this drives the custodian directly) ----
export async function guestRequest(cs, { world, keys = vmKeys(), opSigner = operator, endpoint = ENDPOINT, doc = {}, runtime = RUNTIME } = {}) {
  const recipient = hpke.generateKeyPair();
  const chs = cs.map((c) => c.challenge({ client: "pvm" }));
  const challenges = chs.map((ch) => ({ encKey: Buffer.from(ch.encKey, "hex"), nonce: Buffer.from(ch.nonce, "hex") }));
  const binding = v2.releaseBinding({ chainId: CHAIN_ID, vault: VAULT, id: DEP, policyRev: 1n, secretRev: 1n, committeeId: COMMITTEE, epoch: 1, challenges,
    runtimeId: new Uint8Array(runtimeId(runtime)), transportSpki: new Uint8Array(keys.transport.spki), recipientKey: recipient.publicKey });
  const evidence = avfDoc({ world, keys, binding, runtime, ...doc });
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const sig = await opSigner.signMessage({ message: v2.operatorMessage({ chainId: CHAIN_ID, vault: VAULT, id: DEP, endpoint, binding, expiry }) });
  return { req: { v: 2, id: DEP, endpoint, committeeId: COMMITTEE, policyRev: "1", secretRev: "1", epoch: 1, recipientKey: hex(recipient.publicKey),
                  challenges: chs.map((c) => ({ encKey: c.encKey, nonce: c.nonce })), operator: { expiry, sig }, evidence }, recipient, binding, keys };
}
/** open one custodian's answer and verify every partial (the guest's step 3) -> [{k, D}] */
export function openAnswer(ans, { recipient, binding, bundle, com }) {
  const recs = v2.openPartials({ recipientPrivate: recipient.privateKey, binding, encKey: Buffer.from(ans.encKey, "hex"), count: ans.count, sealed: Buffer.from(ans.sealed, "base64") });
  const R = v2.parseBundle(bundle).R;
  return recs.map((record) => v2.verifyPartial({ record, R, binding, commitments: com.commitments }));
}
