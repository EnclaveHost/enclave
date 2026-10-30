// The owner's side: encrypt an env map into a custody bundle for one committee epoch, and build the EnclaveSecretVault
// Update (sent as a transaction, or signed as EIP-712 and submitted by anyone, which is how a passkey-held deployment's
// ERC-1271 owner authorizes it without exposing a key). Isomorphic: the site runs this in the browser, the CLI in node.
// The plaintext and the data key never leave this function: what it returns is ciphertext, commitments and sealed shares.
//
// THE COMMITTEE KEYS MATTER. Shares are sealed to the member keys the caller passes; a bundle sealed to keys an attacker
// holds is readable by that attacker. Read them from the vault through more than one RPC (custody/chain.mjs, minAgree >= 2)
// and show the owner who the members are; the contract can check a bundle's shape, not whom its shares were sealed to.
import { encodeAbiParameters, keccak256, bytesToHex } from "viem";
import { concatBytes } from "@noble/hashes/utils";
import * as P from "./protocol.mjs";
import * as th from "./threshold.mjs";
import { canonicalRules } from "./rules.mjs";

// configText: the EXACT config text the app's values go into (P.configTextOf(the config value); "" for no config). The guest
// refuses any other (protocol.mjs configSha256), so the owner, not the relay, decides where the values may be substituted.
export function buildBundle({ chainId, vault, id, secretRev, committeeId, epoch, threshold, members, env, configText }) {
  if (!Array.isArray(members) || !members.length) throw new Error("buildBundle: the committee's members are required");
  if (typeof configText !== "string") throw new Error("buildBundle: configText (the config the values may go into, \"\" for none) is required");
  P.checkEnv(env);
  const v = String(vault).toLowerCase();
  const s = th.randomScalar();
  const { shares, commitments } = th.split(s, threshold, members.length);
  const dek = P.deriveDek(s, { chainId, vault: v, id, secretRev });
  const ciphertext = P.encryptBundle(dek, P.bundleAad({ chainId, vault: v, id, secretRev, c0: commitments[0] }), env, { configSha256: P.configSha256(configText) });
  const sealedShares = shares.map((sh, i) =>
    P.sealShareAtRest(P.fixed(members[i].encKey, 32, "member encKey"), { chainId, vault: v, id, secretRev, committeeId, epoch, index: i, commitments }, sh.y));
  dek.fill(0);
  return { ciphertext, commitments: concatBytes(...commitments), sealedShares };
}

export const UPDATE_COMPONENTS = [
  { name: "expectPolicyRev", type: "uint64" }, { name: "setPolicy", type: "bool" }, { name: "committeeId", type: "bytes32" },
  { name: "paused", type: "bool" }, { name: "rules", type: "bytes" }, { name: "putBundle", type: "bool" }, { name: "clearBundle", type: "bool" },
  { name: "epoch", type: "uint32" }, { name: "ciphertext", type: "bytes" }, { name: "commitments", type: "bytes" }, { name: "sealedShares", type: "bytes[]" },
];
export const UPDATE_ABI = [
  { type: "function", name: "update", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "u", type: "tuple", components: UPDATE_COMPONENTS }], outputs: [] },
  { type: "function", name: "updateBySig", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "u", type: "tuple", components: UPDATE_COMPONENTS }, { name: "deadline", type: "uint64" }, { name: "sig", type: "bytes" }], outputs: [] },
  { type: "function", name: "updateDigest", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "u", type: "tuple", components: UPDATE_COMPONENTS }, { name: "deadline", type: "uint64" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "claimPolicy", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "createCommittee", stateMutability: "nonpayable", inputs: [{ name: "salt", type: "bytes32" }, { name: "threshold", type: "uint8" },
    { name: "members", type: "tuple[]", components: [{ name: "operator", type: "address" }, { name: "encKey", type: "bytes32" }, { name: "endpoint", type: "string" }] }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "approveEpoch", stateMutability: "nonpayable", inputs: [{ name: "cid", type: "bytes32" }, { name: "threshold", type: "uint8" },
    { name: "members", type: "tuple[]", components: [{ name: "operator", type: "address" }, { name: "encKey", type: "bytes32" }, { name: "endpoint", type: "string" }] }], outputs: [] },
];

const ZERO32 = "0x" + "00".repeat(32);
// the Update struct (viem form). `policy`: { committeeId, paused, rules (object, canonicalized here) } or omitted;
// `bundle`: the buildBundle() output plus its epoch, or omitted; `clear`: destroy the bundle.
export function makeUpdate({ expectPolicyRev, policy = null, bundle = null, clear = false }) {
  if (bundle && clear) throw new Error("makeUpdate: a bundle and a clear are exclusive");
  return {
    expectPolicyRev: BigInt(expectPolicyRev),
    setPolicy: !!policy, committeeId: policy ? policy.committeeId : ZERO32, paused: policy ? !!policy.paused : false,
    rules: policy ? bytesToHex(canonicalRules(policy.rules)) : "0x",
    putBundle: !!bundle, clearBundle: !!clear, epoch: bundle ? bundle.epoch : 0,
    ciphertext: bundle ? bytesToHex(bundle.ciphertext) : "0x", commitments: bundle ? bytesToHex(bundle.commitments) : "0x",
    sealedShares: bundle ? bundle.sealedShares.map((x) => bytesToHex(x)) : [],
  };
}

// EIP-712 typed data for updateBySig (eth_signTypedData_v4; for a passkey owner, the digest is the WebAuthn challenge)
export const contentHash = (u) => keccak256(encodeAbiParameters([{ type: "tuple", components: UPDATE_COMPONENTS }], [u]));
export const updateTypedData = ({ chainId, vault, id, update, deadline }) => ({
  domain: { name: "EnclaveSecretVault", version: "1", chainId: Number(chainId), verifyingContract: vault },
  types: { Update: [{ name: "id", type: "bytes32" }, { name: "expectPolicyRev", type: "uint64" }, { name: "deadline", type: "uint64" }, { name: "contentHash", type: "bytes32" }] },
  primaryType: "Update",
  message: { id, expectPolicyRev: update.expectPolicyRev, deadline: BigInt(deadline), contentHash: contentHash(update) },
});
