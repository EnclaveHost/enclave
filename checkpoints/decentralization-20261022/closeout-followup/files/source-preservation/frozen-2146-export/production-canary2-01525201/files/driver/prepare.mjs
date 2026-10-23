// Prepare ONE mutation: the exact calldata, built by the PINNED client code (custody/v2/owner.mjs buildBundleV2 +
// makeUpdateV2, custody/rules.mjs validateRules) from a chain state read at an agreed block. Pure apart from the
// injected `client` module set: no network, no keys. The prepared record (calldata included) lives in private/ until
// sent; the journal and output carry only its public summary and hashes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hashOf, sha256hex } from "./canonical.mjs";
import { ORIGINAL_VAULT_V2, COMMITTEE_4774, PROTECTED_POLICY_4E62 } from "./plan.mjs";

const tag = (t, n) => createHash(n === 48 ? "sha384" : "sha256").update(`enclave-custody-canary-decoy-${t}-v1`).digest("hex");
export const DECOY = Object.freeze({ measurement: tag("measurement", 48), runtimeId: tag("runtime", 32), appId: tag("app", 32) });
export const DECOY_SENDER = "0x000000000000000000000000000000000000dead"; // eth_call only; nobody can sign for it

// The pinned client code, loaded from the pinned repo path (hash-checked by the caller first).
export async function loadClient(repo) {
  const imp = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
  const viemEsm = path.join(repo, "node_modules/viem/_esm/index.js");
  if (!fs.existsSync(viemEsm)) throw new Error(`${viemEsm}: the pinned repo's viem is missing`);
  const [owner, rules, protocol, viem] = await Promise.all([imp("custody/v2/owner.mjs"), imp("custody/rules.mjs"), imp("custody/protocol.mjs"), import(pathToFileURL(viemEsm).href)]);
  return { owner, rules, protocol, viem };
}

export function rulesFor(image, variant) {
  const im = { platform: "sev-snp", measurement: image.measurement, runtimeId: image.runtimeId };
  const r = { v: 1, appId: image.appId, images: [im], minTcb: image.minTcb, vmpl: 0 };
  switch (variant) {
    case "image": return r;
    case "decoy-measurement": return { ...r, images: [{ ...im, measurement: DECOY.measurement }] };
    case "decoy-runtime": return { ...r, images: [{ ...im, runtimeId: DECOY.runtimeId }] };
    case "decoy-app": return { ...r, appId: DECOY.appId };
    default: throw new Error(`unknown rules variant ${variant}`);
  }
}

// chain: { block:{number,hash}, policy:{owner, policyRev, secretRev, committeeId, paused}, committee:{Y, epoch, t, W},
//          configText } — read through the agreed reader by the caller. Pricing, nonce and sending: sender.mjs.
// env: the marker values (in memory) when the step writes a bundle; never returned.
export function prepareMutation({ client, pins, step, chain, env = null }) {
  const m = step.mutation;
  if (!m || step.status !== "ready") throw new Error(`${step.id}: not a ready mutation step`);
  const id = m.ids[0];
  if (id === PROTECTED_POLICY_4E62) throw new Error("refusing the protected policy 0x4e62");
  if (BigInt(chain.policy.policyRev) !== BigInt(m.expectPolicyRev))
    throw new Error(`${step.id}: chain policyRev ${chain.policy.policyRev} is not the planned ${m.expectPolicyRev}; the plan is out of step, nothing prepared`);
  if (BigInt(chain.policy.policyRev) > 0n && String(chain.policy.owner).toLowerCase() !== m.from)
    throw new Error(`${step.id}: the policy owner is not the canary owner`);
  const committeeId = COMMITTEE_4774;
  const rules = client.rules.validateRules(rulesFor(pins.image, m.policy.rules));
  let bundle = null, secretRev = BigInt(chain.policy.secretRev);
  if (m.bundle) {
    if (!env || !Object.keys(env).length) throw new Error(`${step.id}: a bundle step needs its marker values`);
    if (!(chain.committee?.Y instanceof Uint8Array) || chain.committee.Y.length !== 33) throw new Error(`${step.id}: the committee key Y (33 bytes, as the reader returns it) was not read`);
    if (typeof chain.configText !== "string") throw new Error(`${step.id}: configText (from the lease envelope, \"\" for none) is required`);
    secretRev += 1n;
    bundle = client.owner.buildBundleV2({ chainId: 8453, vault: ORIGINAL_VAULT_V2, id, secretRev, committeeId, Y: chain.committee.Y, env, configText: chain.configText });
  }
  const update = client.owner.makeUpdateV2({ expectPolicyRev: BigInt(m.expectPolicyRev), policy: { committeeId, paused: m.policy.paused, rules }, bundle });
  const data = client.viem.encodeFunctionData({ abi: client.owner.UPDATE_V2_ABI, functionName: "update", args: [id, update] });
  const selector = client.viem.toFunctionSelector(client.owner.UPDATE_V2_ABI.find((f) => f.name === "update"));
  const calldataSha256 = sha256hex(Buffer.from(data.slice(2), "hex"));
  const summary = { id, expectPolicyRev: String(update.expectPolicyRev), setPolicy: update.setPolicy, committeeId: update.committeeId, paused: update.paused,
    rulesKeccak: client.viem.keccak256(update.rules), rulesVariant: m.policy.rules, setBundle: update.setBundle,
    bundleKeccak: update.setBundle ? client.viem.keccak256(update.bundle) : null, bundleBytes: bundle ? bundle.length : 0, nextSecretRev: String(secretRev),
    configSha256: bundle ? client.protocol.configSha256(chain.configText) : null, clear: update.clear };
  const prepared = { stepId: step.id, stepHash: step.stepHash, block: chain.block, calldataSha256, selector, summary };
  prepared.calldataRecordHash = hashOf("custody-canary-calldata-v1", prepared);
  return { prepared, tx: { chainId: 8453, from: m.from, to: m.target, data, value: 0n } };
}

// eth_call inputs for the chain-side refusal checks (never sent).
export function prepareSimulation({ client, pins, step, chain }) {
  const s = step.simulate;
  const rules = client.rules.validateRules(rulesFor(pins.image, "image"));
  const cur = BigInt(chain.policy.policyRev);
  if (cur < 1n) throw new Error(`${step.id}: needs an existing canary policy`);
  const expectPolicyRev = s.expectPolicyRev === "current-1" ? cur - 1n : cur;
  const update = client.owner.makeUpdateV2({ expectPolicyRev, policy: { committeeId: COMMITTEE_4774, paused: false, rules } });
  const data = client.viem.encodeFunctionData({ abi: client.owner.UPDATE_V2_ABI, functionName: "update", args: [s.id, update] });
  return { from: s.from === "decoy" ? DECOY_SENDER : String(pins.owner.address).toLowerCase(), to: ORIGINAL_VAULT_V2, data, expectRevert: s.expectRevert };
}

export function writePrivate(dir, name, value) {
  const file = path.join(dir, name);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, (k, v) => typeof v === "bigint" ? `n:${v}` : v, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return file;
}
