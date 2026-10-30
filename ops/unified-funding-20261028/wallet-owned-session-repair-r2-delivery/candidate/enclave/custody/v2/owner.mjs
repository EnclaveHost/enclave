// Owner side of custody v2 (browser and CLI): encrypt an env map to a COMMITTEE KEY and build the vault update.
// No shares are dealt by the owner: the committee already holds the key (docs/security/secret-custody-v2.md §4.2).
import { keccak256, encodeAbiParameters, bytesToHex } from "viem";
import * as v2 from "./protocol.mjs";
import { configSha256, checkEnv } from "../protocol.mjs";
import { canonicalRules } from "../rules.mjs";

// Y: the committee key (33 bytes, from committeeOf); -> the bundle bytes for the vault
export function buildBundleV2({ chainId, vault, id, secretRev, committeeId, Y, env, configText }) {
  if (typeof configText !== "string") throw new Error("buildBundleV2: configText (the config the values may go into, \"\" for none) is required");
  checkEnv(env);
  const label = v2.labelOf({ chainId, vault: String(vault).toLowerCase(), id, secretRev, committeeId });
  return v2.encryptBundle({ Y, label, env, configSha256: configSha256(configText) });
}

export const UPDATE_V2_COMPONENTS = [
  { name: "expectPolicyRev", type: "uint64" }, { name: "setPolicy", type: "bool" }, { name: "committeeId", type: "bytes32" },
  { name: "paused", type: "bool" }, { name: "rules", type: "bytes" }, { name: "setBundle", type: "bool" }, { name: "bundle", type: "bytes" }, { name: "clear", type: "bool" },
];
export const UPDATE_V2_ABI = [
  { type: "function", name: "update", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "u", type: "tuple", components: UPDATE_V2_COMPONENTS }], outputs: [] },
  { type: "function", name: "updateBySig", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "u", type: "tuple", components: UPDATE_V2_COMPONENTS }, { name: "deadline", type: "uint64" }, { name: "sig", type: "bytes" }], outputs: [] },
  { type: "function", name: "updateDigest", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "u", type: "tuple", components: UPDATE_V2_COMPONENTS }, { name: "deadline", type: "uint64" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "claimPolicy", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
];
const ZERO32 = "0x" + "00".repeat(32);
// `policy`: { committeeId, paused, rules (object) } or omitted; `bundle`: bytes from buildBundleV2, or omitted; `clear`.
// A bundle needs the policy's committee: pass policy too when the policy is new or its committee changes.
export function makeUpdateV2({ expectPolicyRev, policy = null, bundle = null, clear = false }) {
  if (bundle && clear) throw new Error("makeUpdateV2: a bundle and a clear are exclusive");
  return {
    expectPolicyRev: BigInt(expectPolicyRev),
    setPolicy: !!policy, committeeId: policy ? policy.committeeId : ZERO32, paused: policy ? !!policy.paused : false,
    rules: policy ? bytesToHex(canonicalRules(policy.rules)) : "0x",
    setBundle: !!bundle, bundle: bundle ? bytesToHex(bundle) : "0x", clear: !!clear,
  };
}
export const contentHashV2 = (u) => keccak256(encodeAbiParameters([{ type: "tuple", components: UPDATE_V2_COMPONENTS }], [u]));
export const updateTypedDataV2 = ({ chainId, vault, id, update, deadline }) => ({
  domain: { name: "EnclaveSecretVaultV2", version: "1", chainId: Number(chainId), verifyingContract: vault },
  types: { Update: [{ name: "id", type: "bytes32" }, { name: "expectPolicyRev", type: "uint64" }, { name: "deadline", type: "uint64" }, { name: "contentHash", type: "bytes32" }] },
  primaryType: "Update",
  message: { id, expectPolicyRev: update.expectPolicyRev, deadline: BigInt(deadline), contentHash: contentHashV2(update) },
});
