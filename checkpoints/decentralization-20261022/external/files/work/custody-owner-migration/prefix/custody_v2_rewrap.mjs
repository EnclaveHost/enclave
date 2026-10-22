// OWNER-AUTHORIZED CUSTODY REWRAP (docs/security/custody-owner-rewrap.md): moving a deployment's secrets from one committee
// of the ORIGINAL vault (0xE486…) to another, when the old committee's measured daemon cannot approve new code and the
// owner may no longer hold the plaintext.
//
// The supported mechanism is the vault's and the old daemon's OWN release path, nothing new on their side:
//   1. the policy owner ADDS one image - the measured rewrap guest's (measurement, REWRAP_RUNTIME_ID) - to the policy's
//      rules with an ordinary owner update (same committee, same bundle, appId unchanged), and signs a REWRAP
//      AUTHORIZATION (EIP-712, this file) naming the exact source state, the destination committee and key, the lease
//      endpoint, the rewrap image and an expiry;
//   2. the rewrap guest, launched by the lease host with HOST_DATA = the deployment id, verifies that authorization
//      against the chain at ONE agreed block (the policy owner, an ERC-1271 owner's answer at that block, the source
//      revisions and bundle hash, the destination committee's key hash, code and machines, its own measurement and the
//      rules naming it), then runs a NORMAL v2 release from the source committee (challenges, binding, SNP evidence,
//      the lease operator's signature - every custodian check unchanged), combines the verified partials inside the TEE,
//      re-encrypts the same {env, configSha256} to the destination committee's Y for secretRev + 1, opens its own output
//      once with the encryption scalar to check the round trip, and returns ONLY that ciphertext and public facts;
//   3. the owner checks the result (label proof for the destination) and signs ONE switch update: committee =
//      destination, rules = the original rules (the rewrap image removed), bundle = the new ciphertext, guarded by
//      expectPolicyRev. Until then the old policy, rules, bundle and committee keep working unchanged.
// Nothing here bypasses an owner, an admin or a custodian check. A refused or interrupted run changes nothing on chain.
import { createHash, generateKeyPairSync } from "node:crypto";
import { hashTypedData, recoverTypedDataAddress, keccak256, encodeFunctionData, isAddress } from "viem";
import * as v2 from "./protocol.mjs";
import * as hpke from "../hpke.mjs";
import { checkEnv } from "../protocol.mjs";
import { parseRules, validateRules, canonicalRules } from "../rules.mjs";
import { runtimeId } from "../../isolation/contract/runtime.mjs";
import { VAULT_V2_ABI, ERC1271_ABI } from "./chain.mjs";
import { makeUpdateV2, UPDATE_V2_ABI, updateTypedDataV2 } from "./owner.mjs";

export const REWRAP_FORMAT = "enclave-custody-rewrap/1";
export const SNP_GUEST_FORMAT = "sev-snp-guest-domain-v1";
export const SNP_GUEST_ABI = "enclave-domain-abi/2";
// The runtime identity the rewrap image states in its evidence. The release format requires one; it is a fixed, versioned
// label. What the owner admits is the PAIR (this id, the image's launch measurement): the measurement pins every byte.
export const REWRAP_RUNTIME = Object.freeze({ name: "enclave-custody-rewrap", version: "1.0.0", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64",
  cpuFeatures: "baseline", wx: "enforced", cache: "none" });
export const REWRAP_RUNTIME_ID = runtimeId(REWRAP_RUNTIME).toString("hex");
export const MAX_AUTHORIZATION_SEC = 3 * 86400;     // an authorization outliving this is refused: a short, explicit window
export const ERC1271_MAGIC = "0x1626ba7e";

const HEX32 = /^0x[0-9a-f]{64}$/, ENDPOINT_RE = /^https:\/\/[a-z0-9.-]{1,253}(\/[A-Za-z0-9._~-]+){0,4}$/;
const lc = (s) => String(s).toLowerCase();
const sha256 = (b) => createHash("sha256").update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");
const ZERO = "0x" + "00".repeat(20);

export class RewrapRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const refuse = (code, message) => { throw new RewrapRefusal(code, message); };

// ---------------------------------------------------------------- the owner's authorization (EIP-712)
export const REWRAP_TYPES = Object.freeze({ Rewrap: [
  { name: "id", type: "bytes32" },
  { name: "sourcePolicyRev", type: "uint64" },       // the policy revision AFTER the owner's update that admits the image
  { name: "sourceSecretRev", type: "uint64" },
  { name: "sourceCommitteeId", type: "bytes32" },
  { name: "sourceBundleHash", type: "bytes32" },     // keccak256 of the stored (ciphertext) bundle
  { name: "destCommitteeId", type: "bytes32" },
  { name: "destKeyHash", type: "bytes32" },          // keccak256 of the destination committee's Y as the owner saw it
  { name: "destCodeMeasurement", type: "bytes32" },  // sha256 of the custodian launch measurement every destination machine runs
  { name: "destSecretRev", type: "uint64" },         // = sourceSecretRev + 1: what the switch update's setBundle makes it
  { name: "leaseEndpoint", type: "string" },         // the lease host the guest runs on (the release's endpoint)
  { name: "rewrapMeasurement", type: "bytes32" },    // sha256 of the rewrap image's launch measurement
  { name: "rewrapRuntimeId", type: "bytes32" },
  { name: "expiry", type: "uint64" }] });

/** -> the normalized authorization (lowercase hex, BigInt revisions); throws on any malformed field */
export function normalizeAuthorization(a) {
  const keys = REWRAP_TYPES.Rewrap.map((f) => f.name);
  if (!a || typeof a !== "object" || Array.isArray(a)) refuse("bad_authorization", "the authorization is not an object");
  for (const k of Object.keys(a)) if (!keys.includes(k)) refuse("bad_authorization", `unknown field ${JSON.stringify(k)}`);
  const out = {};
  for (const { name, type } of REWRAP_TYPES.Rewrap) {
    const v = a[name];
    if (v === undefined || v === null) refuse("bad_authorization", `${name} is required`);
    if (type === "bytes32") { if (!HEX32.test(lc(v))) refuse("bad_authorization", `${name} must be 32 bytes of hex`); out[name] = lc(v); }
    else if (type === "uint64") {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(String(v))) refuse("bad_authorization", `${name} must be a non-negative integer`);
      out[name] = BigInt(v); if (out[name] >= 1n << 64n) refuse("bad_authorization", `${name} is out of range`);
    } else { if (typeof v !== "string" || !ENDPOINT_RE.test(v)) refuse("bad_authorization", `${name} must be an https origin (optional path)`); out[name] = v; }
  }
  if (out.sourcePolicyRev < 1n || out.sourceSecretRev < 1n) refuse("bad_authorization", "the source policy and bundle must exist");
  if (out.destSecretRev !== out.sourceSecretRev + 1n) refuse("bad_authorization", "destSecretRev must be sourceSecretRev + 1 (the switch's setBundle)");
  if (out.destCommitteeId === out.sourceCommitteeId) refuse("bad_authorization", "the destination is the source committee");
  if (out.rewrapRuntimeId !== "0x" + REWRAP_RUNTIME_ID) refuse("bad_authorization", "rewrapRuntimeId is not this rewrap runtime's");
  return out;
}
const asMessage = (a) => ({ ...a });
export function rewrapTypedData({ chainId, vault, authorization }) {
  const a = normalizeAuthorization(authorization);
  if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0) refuse("bad_authorization", "chainId");
  if (!isAddress(String(vault))) refuse("bad_authorization", "vault");
  return { domain: { name: "EnclaveCustodyRewrap", version: "1", chainId: Number(chainId), verifyingContract: lc(vault) },
           types: REWRAP_TYPES, primaryType: "Rewrap", message: asMessage(a) };
}
export const rewrapDigest = (x) => hashTypedData(rewrapTypedData(x));
/** JSON-safe form of an authorization (BigInt -> decimal string) */
export const authorizationJson = (a) => Object.fromEntries(Object.entries(normalizeAuthorization(a)).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

// ---------------------------------------------------------------- facts at ONE agreed block (guest side)
// chain: custody/v2/chain.mjs createChainReaderV2(...) - its snapshot() runs fn on every RPC at one agreed block and returns
// the majority answer merged with { blockNumber, blockHash, blockTimestamp }.
export async function readRewrapFacts(chain, { vault, digest, signature, authorization }) {
  const a = normalizeAuthorization(authorization);
  return chain.snapshot(async ({ call, code }) => {
    const [policy, bundle, beneficialOwner] = await Promise.all([call(vault, VAULT_V2_ABI, "policyOf", [a.id]), call(vault, VAULT_V2_ABI, "bundleOf", [a.id]),
      call(vault, VAULT_V2_ABI, "beneficialOwnerOf", [a.id]).catch(() => null)]);
    const committee = async (cid) => {
      const [Y, epoch, t, W] = await call(vault, VAULT_V2_ABI, "committeeOf", [cid]);
      if (!Number(epoch)) return null;
      const [[machines, enclave], commitments] = await Promise.all([call(vault, VAULT_V2_ABI, "machinesOf", [cid, epoch]), call(vault, VAULT_V2_ABI, "commitmentsOf", [cid, epoch])]);
      return { committeeId: lc(cid), Y: lc(Y), epoch: Number(epoch), t: Number(t), W: Number(W), commitments: lc(commitments),
               machines: machines.map((m, i) => ({ identity: lc(m.identity), encKey: lc(m.encKey), endpoint: m.endpoint, registryId: lc(m.registryId), measurement: lc(m.measurement), enclave: enclave[i] })) };
    };
    const [owner, policyRev, secretRev, committeeId, paused, rules] = policy;
    const [source, dest, destCodeActiveAt] = await Promise.all([committee(committeeId), committee(a.destCommitteeId),
      call(vault, VAULT_V2_ABI, "codeActiveAt", [a.destCommitteeId, a.destCodeMeasurement])]);
    const ownerCode = lc(owner) === ZERO ? "0x" : await code(owner);
    let erc1271 = null;
    if (ownerCode && ownerCode !== "0x") {
      try { erc1271 = lc(await call(owner, ERC1271_ABI, "isValidSignature", [digest, signature])); } catch { erc1271 = "revert"; }
    }
    return { policy: { owner: lc(owner), policyRev: policyRev.toString(), secretRev: secretRev.toString(), committeeId: lc(committeeId), paused, rules: lc(rules) },
             bundle: { committeeId: lc(bundle[0]), secretRev: bundle[1].toString(), data: lc(bundle[2]) },
             beneficialOwner: beneficialOwner ? lc(beneficialOwner) : null, source, dest, destCodeActiveAt: Number(destCodeActiveAt),
             ownerIsContract: !!ownerCode && ownerCode !== "0x", erc1271 };
  });
}

/**
 * The guest's decision BEFORE any release: every authenticated field against the facts of one agreed block, and the guest's
 * own report. self: { measurement (48-byte hex, from its own SNP report), hostData (32-byte hex, from that report) }.
 * -> { a, sourceRules } or throws RewrapRefusal. Recovering the EOA signature is async (viem), hence async.
 */
export async function judgeRewrap({ chainId, vault, authorization, signature, facts, self }) {
  const a = normalizeAuthorization(authorization);
  const now = BigInt(facts.blockTimestamp);
  if (a.expiry <= now) refuse("expired", "the authorization has expired (chain time)");
  if (a.expiry > now + BigInt(MAX_AUTHORIZATION_SEC)) refuse("bad_authorization", `the authorization outlives ${MAX_AUTHORIZATION_SEC} s`);
  const p = facts.policy;
  if (BigInt(p.policyRev) === 0n || p.owner === ZERO) refuse("no_policy", "the deployment has no policy");
  if (BigInt(p.policyRev) !== a.sourcePolicyRev) refuse("stale_revision", `the policy is at revision ${p.policyRev}, the authorization names ${a.sourcePolicyRev}`);
  if (BigInt(p.secretRev) !== a.sourceSecretRev) refuse("stale_revision", `the bundle is at revision ${p.secretRev}, the authorization names ${a.sourceSecretRev}`);
  if (p.committeeId !== a.sourceCommitteeId) refuse("wrong_committee", "the policy names another committee than the authorization's source");
  if (p.paused) refuse("paused", "the owner paused releases");
  if (!facts.beneficialOwner || facts.beneficialOwner !== p.owner) refuse("owner_mismatch", "the ledger no longer names the policy's owner");
  const b = facts.bundle;
  if (b.committeeId !== a.sourceCommitteeId || BigInt(b.secretRev) !== a.sourceSecretRev || b.data === "0x") refuse("no_bundle", "no bundle at the source revision");
  if (keccak256(b.data) !== a.sourceBundleHash) refuse("bundle_mismatch", "the stored bundle is not the one the owner authorized");
  // the owner's signature: an EOA by recovery, a contract owner by its ERC-1271 answer at THIS block
  const td = rewrapTypedData({ chainId, vault, authorization: a });
  if (facts.ownerIsContract) {
    if (facts.erc1271 !== ERC1271_MAGIC) refuse("bad_signature", "the contract owner does not accept the authorization (ERC-1271)");
  } else {
    let who = null; try { who = lc(await recoverTypedDataAddress({ ...td, signature })); } catch { who = null; }
    if (who !== p.owner) refuse("bad_signature", "the authorization is not signed by the policy owner");
  }
  // this guest is the image the owner admitted, launched for this deployment
  const meas = lc(self.measurement), mhash = "0x" + hex(sha256(Buffer.from(meas, "hex")));
  if (mhash !== a.rewrapMeasurement) refuse("wrong_image", "this guest's launch measurement is not the authorized rewrap image");
  if ("0x" + lc(self.hostData) !== a.id) refuse("wrong_deployment", "this guest was not launched for the authorized deployment (HOST_DATA)");
  let rules; try { rules = parseRules(Buffer.from(p.rules.slice(2), "hex")); } catch (e) { refuse("bad_rules", `the policy's rules do not parse: ${e.message}`); }
  if (!rules.images.some((im) => im.platform === "sev-snp" && im.measurement === meas && im.runtimeId === REWRAP_RUNTIME_ID))
    refuse("not_admitted", "the policy's rules do not admit this rewrap image");
  // the destination: an existing committee of THIS vault, the key the owner saw, every machine on the authorized code
  const d = facts.dest;
  if (!d) refuse("no_destination", "the destination committee does not exist in this vault");
  if (keccak256(d.Y) !== a.destKeyHash) refuse("destination_key", "the destination committee's key is not the one the owner authorized");
  if (!facts.destCodeActiveAt || BigInt(facts.destCodeActiveAt) > now) refuse("destination_code", "the authorized custodian code is not active in the destination committee");
  if (!d.machines.length || d.machines.some((m) => m.measurement !== a.destCodeMeasurement)) refuse("destination_code", "a destination machine runs other code than the authorized");
  if (!facts.source) refuse("no_source", "the source committee is not active");
  return { a, sourceRules: rules };
}

// ---------------------------------------------------------------- the admin's platform host policy (guest side)
/**
 * The original custodian image cannot enforce the platform host policy, so the rewrap guest enforces it for ITS OWN lease
 * host before asking for anything: the same gate (network/platform-host-policy.mjs) and the same host facts the corrected
 * custodian uses at release (chain.readRelease with hostPolicy). An admin ban, an allowlist miss or a deregistered host
 * refuses; a node behind the anchor refreshes once. "unanchored" means the admin has not activated a policy: today's
 * behavior, so it proceeds (the activation rule of network/platform-host-policy-config.mjs). hostGate null: not measured.
 */
export async function checkLeaseHost({ chain, hostGate, id, endpoint }) {
  if (!hostGate) return { admit: true, status: "off" };
  const decide = async () => {
    const s = await chain.readRelease({ id, endpoint });
    if (!s.platform || !s.endpointId) refuse("host_policy_unreadable", "the platform host policy facts were not read");
    return hostGate.decideHost({ ...s.platform.hosts[s.endpointId], endpoint }, s.platform);
  };
  let g = await decide();
  if (!g.admit && ["behind", "authority"].includes(g.status)) { await hostGate.refresh().catch(() => {}); g = await decide(); }
  if (g.admit || g.status === "unanchored") return g;
  refuse(["behind", "anchor", "authority", "authority-unread"].includes(g.status) ? "host_policy_undecided" : "host_refused", `Platform host policy: ${g.reason}`);
}

// ---------------------------------------------------------------- the release (guest side): the normal v2 protocol
/**
 * One v2 release from the source committee, exactly as an app guest makes it. Every custodian check is the custodian's.
 * fetchJson(url, body) -> json; attester: { runtime, transportSpki, evidence(binding, appId) }; operatorSign({ message, expiry })
 * -> signature by the lease host's registry operator (the host holds that key; it is not secret-bearing for the app).
 * -> { env, configSha256 } (plaintext: stays inside this process)
 */
export async function releaseFromSource({ chainId, vault, id, endpoint, appId, facts, attester, operatorSign, fetchJson, now = () => Date.now(), log = () => {} }) {
  const com = facts.source, policy = facts.policy;
  const answered = (await Promise.allSettled(com.machines.map(async (m) => ({ m, ...(await fetchJson(`${m.endpoint}/v2/custody/challenge`, {})) }))))
    .flatMap((r) => (r.status === "fulfilled" && /^[0-9a-f]{64}$/.test(String(r.value.encKey)) && /^[0-9a-f]{64}$/.test(String(r.value.nonce)) && lc("0x" + r.value.encKey) === r.value.m.encKey ? [r.value] : []));
  if (!answered.length) refuse("custodians_unreachable", "no source custodian answered a challenge");
  const challenges = answered.map((c) => ({ encKey: Buffer.from(c.encKey, "hex"), nonce: Buffer.from(c.nonce, "hex") }));
  const recipient = hpke.generateKeyPair();
  const binding = v2.releaseBinding({ chainId, vault, id, policyRev: BigInt(policy.policyRev), secretRev: BigInt(policy.secretRev), committeeId: com.committeeId,
    epoch: com.epoch, challenges, runtimeId: new Uint8Array(runtimeId(attester.runtime)), transportSpki: attester.transportSpki, recipientKey: recipient.publicKey });
  const evidence = await attester.evidence(binding, appId);       // report_data = binding ‖ the rules' AppID
  const expiry = Math.floor(now() / 1000) + 300;
  const sig = await operatorSign({ message: v2.operatorMessage({ chainId, vault, id, endpoint, binding, expiry }), expiry, binding: hex(binding) });
  const commitments = []; const C = Buffer.from(com.commitments.slice(2), "hex"); for (let i = 0; i < C.length; i += 33) commitments.push(C.subarray(i, i + 33));
  const R = v2.parseBundle(Buffer.from(facts.bundle.data.slice(2), "hex")).R;
  const byIndex = new Map();
  const req = { v: 2, id, endpoint, committeeId: com.committeeId, epoch: com.epoch, policyRev: String(policy.policyRev), secretRev: String(policy.secretRev),
    recipientKey: hex(recipient.publicKey), challenges: answered.map((c) => ({ encKey: c.encKey, nonce: c.nonce })), operator: { sig, expiry }, evidence };
  for (const c of answered) {
    let r; try { r = await fetchJson(`${c.m.endpoint}/v2/custody/release`, req); } catch (e) { log(`custodian ${c.m.identity.slice(0, 10)} refused: ${String(e.message).slice(0, 160)}`); continue; }
    try {
      const recs = v2.openPartials({ recipientPrivate: recipient.privateKey, binding, encKey: Buffer.from(c.encKey, "hex"), count: Number(r.count), sealed: Buffer.from(String(r.sealed), "base64") });
      const ver = recs.map((record) => v2.verifyPartial({ record, R, binding, commitments }));
      for (const p of ver) if (!byIndex.has(p.k)) byIndex.set(p.k, p);
    } catch (e) { log(`custodian ${c.m.identity.slice(0, 10)}: a partial did not verify; dropped`); }
    if (byIndex.size >= com.t) break;
  }
  if (byIndex.size < com.t) refuse("release_refused", `only ${byIndex.size} of ${com.t} verified share indices were released`);
  const S = v2.combine([...byIndex.values()].slice(0, com.t), com.t);
  return v2.decryptBundle({ S, label: v2.labelOf({ chainId, vault, id, secretRev: BigInt(policy.secretRev), committeeId: com.committeeId }),
                            bundle: Buffer.from(facts.bundle.data.slice(2), "hex") });
}

/**
 * Re-encrypt to the destination: the same { env, configSha256 } under the destination's Y and label (secretRev + 1), with
 * the encryption scalar kept only long enough to open the output once and compare it with the input.
 * -> bundle bytes (ciphertext only)
 */
export function sealForDestination({ chainId, vault, a, destY, payload }) {
  checkEnv(payload.env);
  const label = v2.labelOf({ chainId, vault, id: a.id, secretRev: a.destSecretRev, committeeId: a.destCommitteeId });
  const r = v2.randomScalar();
  const bundle = v2.encryptBundle({ Y: destY, label, env: payload.env, configSha256: payload.configSha256, _r: r });
  const back = v2.decryptBundle({ S: v2.pointOf(destY, "destination key").multiply(r), label, bundle });
  if (JSON.stringify(back) !== JSON.stringify({ env: payload.env, configSha256: payload.configSha256 })) refuse("self_check", "the new bundle does not open to the released payload");
  if (!v2.verifyLabelProof(bundle, label)) refuse("self_check", "the new bundle's label proof does not verify");
  return { bundle, label };
}

/**
 * The whole guest run. -> the RESULT: public facts and the destination ciphertext. Never the payload.
 * io: { chain, fetchJson, attester, operatorSign, self, now, log }
 */
export async function runRewrap({ chainId, vault, authorization, signature, io }) {
  const a0 = normalizeAuthorization(authorization);
  const digest = rewrapDigest({ chainId, vault, authorization: a0 });
  const facts = await readRewrapFacts(io.chain, { vault, digest, signature, authorization: a0 });
  const { a, sourceRules } = await judgeRewrap({ chainId, vault, authorization: a0, signature, facts, self: io.self });
  const host = await checkLeaseHost({ chain: io.chain, hostGate: io.hostGate || null, id: a.id, endpoint: a.leaseEndpoint });
  io.log?.(`lease host ${a.leaseEndpoint}: platform host policy ${host.status}`);
  io.log?.(`authorized: ${a.id.slice(0, 18)}… rev ${a.sourcePolicyRev}/${a.sourceSecretRev} ${a.sourceCommitteeId.slice(0, 12)}… -> ${a.destCommitteeId.slice(0, 12)}… at block ${facts.blockNumber}`);
  let payload = await releaseFromSource({ chainId, vault, id: a.id, endpoint: a.leaseEndpoint, appId: Buffer.from(sourceRules.appId, "hex"), facts, attester: io.attester, operatorSign: io.operatorSign,
    fetchJson: io.fetchJson, now: io.now, log: io.log });
  let sealed;
  try { sealed = sealForDestination({ chainId, vault, a, destY: Buffer.from(facts.dest.Y.slice(2), "hex"), payload }); }
  finally { payload = null; }                       // the plaintext's only references end here
  const bundleHex = "0x" + hex(sealed.bundle);
  return { format: REWRAP_FORMAT, chainId: Number(chainId), vault: lc(vault), authorizationDigest: digest, authorization: authorizationJson(a),
           checkedAtBlock: { number: String(facts.blockNumber), hash: facts.blockHash },
           destination: { committeeId: a.destCommitteeId, secretRev: a.destSecretRev.toString(), label: "0x" + hex(sealed.label) },
           bundle: bundleHex, bundleHash: keccak256(bundleHex), bundleBytes: sealed.bundle.length };
}

/** the result object may carry nothing but these keys and these shapes: a defense against a future edit leaking a payload */
export function assertResultShape(r) {
  const keys = ["format", "chainId", "vault", "authorizationDigest", "authorization", "checkedAtBlock", "destination", "bundle", "bundleHash", "bundleBytes"];
  if (!r || JSON.stringify(Object.keys(r).sort()) !== JSON.stringify([...keys].sort())) refuse("bad_result", "unexpected result fields");
  if (r.format !== REWRAP_FORMAT || !/^0x[0-9a-f]+$/.test(r.bundle) || keccak256(r.bundle) !== r.bundleHash) refuse("bad_result", "malformed result");
  return r;
}

// ---------------------------------------------------------------- the owner's side (CLI / tooling, outside any TEE)
const rulesBytes = (hexRules) => Buffer.from(String(hexRules).slice(2), "hex");
/**
 * The plan from the CURRENT public state (facts as readRewrapFacts / chain.readRelease return them) and the measured image:
 *   admit   : the owner update adding the rewrap image to the rules (same committee, same pause, bundle untouched)
 *   authorization : the fields to sign (EIP-712) for the revision that update creates
 *   rollback: the owner update restoring the original rules if the owner abandons the migration BEFORE the switch
 * The original rules must re-encode to exactly the bytes on chain (else nothing is planned: the owner would be signing
 * something else than what it has).
 */
export function planRewrap({ policy, bundle, dest, destCodeMeasurement, leaseEndpoint, rewrapMeasurement, expiry }) {
  const original = parseRules(rulesBytes(policy.rules));
  if (lc("0x" + hex(canonicalRules(original))) !== lc(policy.rules)) refuse("rules_encoding", "the policy's rules do not re-encode to the same bytes; plan by hand");
  if ("ownerRead" in original) refuse("rules_encoding", "the policy's rules carry ownerRead, which the original custodian image cannot parse");
  if (!/^[0-9a-f]{96}$/.test(rewrapMeasurement)) refuse("bad_plan", "rewrapMeasurement must be the 48-byte launch measurement (96 hex)");
  const image = { platform: "sev-snp", measurement: rewrapMeasurement, runtimeId: REWRAP_RUNTIME_ID };
  if (original.images.some((im) => im.measurement === image.measurement && im.runtimeId === image.runtimeId)) refuse("bad_plan", "the rewrap image is already admitted");
  const withImage = validateRules({ ...original, images: [...original.images, image] });
  const cur = BigInt(policy.policyRev);
  const admit = makeUpdateV2({ expectPolicyRev: cur, policy: { committeeId: policy.committeeId, paused: policy.paused, rules: withImage } });
  const authorization = authorizationJson({ id: policy.id, sourcePolicyRev: (cur + 1n).toString(), sourceSecretRev: String(policy.secretRev),
    sourceCommitteeId: policy.committeeId, sourceBundleHash: keccak256(bundle.data), destCommitteeId: dest.committeeId, destKeyHash: keccak256(dest.Y),
    destCodeMeasurement, destSecretRev: (BigInt(policy.secretRev) + 1n).toString(), leaseEndpoint, rewrapMeasurement: "0x" + hex(sha256(Buffer.from(rewrapMeasurement, "hex"))),
    rewrapRuntimeId: "0x" + REWRAP_RUNTIME_ID, expiry: String(expiry) });
  const rollback = makeUpdateV2({ expectPolicyRev: cur + 1n, policy: { committeeId: policy.committeeId, paused: policy.paused, rules: original } });
  return { originalRules: original, admit, authorization, rollback };
}

/**
 * The owner's check of a guest's result, then the ONE switch update: destination committee, the ORIGINAL rules (the
 * rewrap image removed), the new bundle; expectPolicyRev = the authorized source revision, so a policy that moved since
 * is never switched. -> { switchUpdate }
 */
export function checkResultAndSwitch({ chainId, vault, authorization, result, originalRules, paused = false }) {
  const a = normalizeAuthorization(authorization);
  assertResultShape(result);
  if (result.authorizationDigest !== rewrapDigest({ chainId, vault, authorization: a })) refuse("bad_result", "the result answers another authorization");
  if (result.chainId !== Number(chainId) || result.vault !== lc(vault)) refuse("bad_result", "the result is for another chain or vault");
  const label = v2.labelOf({ chainId, vault, id: a.id, secretRev: a.destSecretRev, committeeId: a.destCommitteeId });
  const bundle = Buffer.from(result.bundle.slice(2), "hex");
  if (!v2.verifyLabelProof(bundle, label)) refuse("bad_result", "the bundle is not labelled for the authorized destination and revision");
  const switchUpdate = makeUpdateV2({ expectPolicyRev: a.sourcePolicyRev, policy: { committeeId: a.destCommitteeId, paused, rules: validateRules(originalRules) }, bundle });
  return { switchUpdate };
}

/** unsigned owner transactions: `update` from the owner EOA, or the EIP-712 for `updateBySig` (EOA or ERC-1271 owner) */
export function ownerUpdateRequests({ chainId, vault, id, update, deadline }) {
  return { update: { to: lc(vault), data: encodeFunctionData({ abi: UPDATE_V2_ABI, functionName: "update", args: [id, update] }), value: "0" },
           updateBySig: { typedData: updateTypedDataV2({ chainId, vault, id, update, deadline }), deadline: String(deadline) } };
}

/** a P-256 transport key for the evidence document (the release binds its SPKI; the rewrap guest serves nothing over it) */
export function transportKey() {
  return new Uint8Array(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }));
}
