// The owner's side of writing custody v2 secrets through a REMOTE independent MCP adapter. This runs on the owner's own
// machine: the values are sealed HERE before anything is sent, and the adapter receives only the ciphertext and the
// revision guard.
//
// The RECIPIENT is never taken from the adapter. Encrypting locally to a key the adapter names would hand the values to
// whoever chose that key, so:
//   1. expected = local set_secrets {id, action: "prepare"}: the owner's OWN independent server (its reviewed profile,
//      the admin AddressBook bindings, its agreeing RPC quorum at one confirmed block) reads the vault, the deployment's
//      policy, the committee it names with that committee's key, the revisions and the config commitment.
//   2. hint = the adapter's set_secrets {id, action: "prepare"}. sealForRemote(hint, env, { expected }) seals to
//      `expected` only. It refuses before sealing if any security field of the hint differs: chain, vault, deployment,
//      committee, committee key, either revision, owner or config commitment.
//   3. write = the adapter's set_secrets {id, action: "write", sealedBundle, expectPolicyRev}. verifyRemoteUpdate(write,
//      { expected, sealedBundle }) decodes the returned transaction. It must be exactly update(id, {that bundle, that
//      guard, no policy change}) to that vault on that chain before the owner signs it.
//   clear needs no recipient: verifyRemoteClear(answer, plan) compares the adapter's clear with the owner's own CLEAR PLAN
//   (the local server's clear, from its quorum): an exact guarded update, or a no-op only when nothing is stored.
// `env` is the WHOLE map: a merge needs the current values, which only the owner's own client can read (the committee's
// owner read: the local MCP server's get_secrets, or `enclave --independent … secrets ls --show`).
// The seal is the existing custody v2 encryption (custody/v2/protocol.mjs labelOf + encryptBundle), byte for byte what the
// CLI and a local server write.
import { decodeFunctionData } from "viem";
import * as v2 from "../custody/v2/protocol.mjs";
import { checkEnv } from "../custody/protocol.mjs";
import { UPDATE_V2_ABI } from "../custody/v2/owner.mjs";

const HEX = (n) => new RegExp(`^0x[0-9a-f]{${n}}$`);
const ZERO32 = "0x" + "00".repeat(32);
export class RecipientError extends Error { constructor(m) { super(m); this.name = "RecipientError"; } }
/** Every field a seal or its vault update depends on; a hint must equal the client's own read in each. */
export const SEALING_FIELDS = Object.freeze(["chainId", "vault", "id", "committeeId", "committeeY", "nextSecretRev", "expectPolicyRev", "owner"]);

function factsOf(x, what) {
  const s = x?.sealing || x;
  if (!s || typeof s !== "object") throw new RecipientError(`${what}: no sealing facts`);
  const f = { chainId: Number(s.chainId), vault: String(s.vault || "").toLowerCase(), id: String(s.id || "").toLowerCase(), committeeId: String(s.committeeId || "").toLowerCase(),
    committeeY: String(s.committeeY || "").toLowerCase(), nextSecretRev: String(s.nextSecretRev ?? ""), expectPolicyRev: String(s.expectPolicyRev ?? ""),
    owner: String(s.owner || "").toLowerCase(), configSha256: s.configSha256 ?? null };
  if (!HEX(40).test(f.vault) || !HEX(64).test(f.id) || !HEX(64).test(f.committeeId) || f.committeeId === ZERO32) throw new RecipientError(`${what} lacks the vault, id or committee`);
  if (!/^0x0[23][0-9a-f]{64}$/.test(f.committeeY)) throw new RecipientError(`${what}: the committee key is not a compressed point`);
  if (!Number.isSafeInteger(f.chainId) || !/^\d+$/.test(f.nextSecretRev) || !/^\d+$/.test(f.expectPolicyRev) || !HEX(40).test(f.owner))
    throw new RecipientError(`${what} lacks the chain, revision, guard or owner`);
  if (f.configSha256 !== null && !/^[0-9a-f]{64}$/.test(String(f.configSha256))) throw new RecipientError(`${what}: configSha256 is not 64 hex`);
  return f;
}

/**
 * hint: the adapter's prepare answer; env: { NAME: value } (the whole map)
 * expected: the owner's own client's prepare answer (local set_secrets {id, action: "prepare"}): REQUIRED
 * id: the deployment the owner means (optional; the caller's own request, compared with both)
 * configSha256: the exact config the values go into (optional: default the client's own commitment)
 * -> { sealedBundle, expectPolicyRev }
 */
export function sealForRemote(hint, env, { expected, id, configSha256 } = {}) {
  if (!expected) throw new RecipientError("sealForRemote needs the sealing facts the owner's own client read (local set_secrets {id, action: \"prepare\"}): a remote answer alone never names the recipient");
  const want = factsOf(expected, "the owner's own read");
  const got = factsOf(hint, "the adapter's prepare answer");
  if (id !== undefined && String(id).toLowerCase() !== want.id) throw new RecipientError(`the owner's own read is for ${want.id}, not the requested deployment ${String(id).toLowerCase()}`);
  for (const k of SEALING_FIELDS) if (got[k] !== want[k])
    throw new RecipientError(`the adapter's prepare answer names ${k} ${String(got[k]).slice(0, 20)}, the owner's own quorum read ${String(want[k]).slice(0, 20)}: nothing was sealed or sent`);
  const cfg = configSha256 ?? want.configSha256;
  if (!/^[0-9a-f]{64}$/.test(String(cfg || ""))) throw new RecipientError("no config commitment: pass { configSha256 } (sha256 of the exact config the values go into)");
  if (configSha256 === undefined && got.configSha256 !== null && got.configSha256 !== want.configSha256)
    throw new RecipientError("the adapter's config commitment differs from the owner's own read: nothing was sealed or sent");
  checkEnv(env);
  if (!Object.keys(env).length) throw new RecipientError("an empty map is a clear: use set_secrets {id, action: \"clear\"}");
  const label = v2.labelOf({ chainId: want.chainId, vault: want.vault, id: want.id, secretRev: BigInt(want.nextSecretRev), committeeId: want.committeeId });
  const bundle = v2.encryptBundle({ Y: new Uint8Array(Buffer.from(want.committeeY.slice(2), "hex")), label, env, configSha256: cfg });
  return { sealedBundle: "0x" + Buffer.from(bundle).toString("hex"), expectPolicyRev: want.expectPolicyRev };
}

/**
 * A clear needs no recipient, so it is judged against the owner's own CLEAR PLAN instead of sealing facts. The plan is
 * the local server's set_secrets {id, payload: '{"clear":true}'}, read from the owner's quorum: either exactly one
 * guarded clear update, or a verified no-op (nothing stored). The adapter's clear answer must be the same:
 *   - a no-op only when the owner's own read shows nothing stored (a false no-op would leave the values in custody);
 *   - otherwise byte for byte the owner's own update (chain, vault, value 0, update(id, the owner's guard, clear only)).
 * -> the transaction to sign, or null for a verified no-op
 */
export function verifyRemoteClear(answer, plan) {
  const want = plan?.transactions, got = answer?.transactions;
  if (!Array.isArray(want) || want.length > 1) throw new RecipientError("no clear plan from the owner's own read");
  if (!want.length) {
    if (Array.isArray(got) && !got.length) return null;
    throw new RecipientError("the adapter answers a clear update, but the owner's own read shows nothing stored: refusing it");
  }
  if (!Array.isArray(got) || got.length !== 1)
    throw new RecipientError("the adapter answers no clear update, but the owner's own read shows values stored: refusing a false no-op");
  const w = want[0], g = got[0];
  let u;
  try { u = decodeFunctionData({ abi: UPDATE_V2_ABI, data: w.data }); } catch { throw new RecipientError("the owner's own clear plan is not a vault update"); }
  const x = u.args[1];
  if (u.functionName !== "update" || x.clear !== true || x.setBundle !== false || x.setPolicy !== false || x.paused !== false || x.rules !== "0x" || x.bundle !== "0x" || String(x.committeeId).toLowerCase() !== ZERO32)
    throw new RecipientError("the owner's own clear plan is not exactly a clear");
  for (const [k, same] of [["chain", Number(g.chainId) === Number(w.chainId)], ["vault", String(g.to || "").toLowerCase() === String(w.to).toLowerCase()],
    ["value", BigInt(g.value ?? 0) === BigInt(w.value ?? 0)], ["update (deployment, guard or fields)", String(g.data || "").toLowerCase() === String(w.data).toLowerCase()]])
    if (!same) throw new RecipientError(`the adapter's clear differs from the owner's own plan in its ${k}: the owner must not sign it`);
  return g;
}

/**
 * The adapter's write or clear answer, checked before the owner signs anything: exactly one transaction, value 0, on the
 * expected chain, to the expected vault, update(expected id, {expected guard, no policy, committee or pause change, and
 * exactly this bundle | exactly a clear}). -> the transaction
 */
export function verifyRemoteUpdate(answer, { expected, sealedBundle = null, clear = false } = {}) {
  const want = factsOf(expected, "the owner's own read");
  const txs = answer?.transactions;
  if (!Array.isArray(txs) || txs.length !== 1) throw new RecipientError("the adapter's update answer is not exactly one transaction");
  const t = txs[0];
  if (Number(t.chainId) !== want.chainId) throw new RecipientError(`the adapter's update is for chain ${t.chainId}, not ${want.chainId}`);
  if (String(t.to || "").toLowerCase() !== want.vault) throw new RecipientError(`the adapter's update goes to ${t.to}, not the owner's vault ${want.vault}`);
  if (BigInt(t.value ?? 0) !== 0n) throw new RecipientError("the adapter's update carries value");
  let call;
  try { call = decodeFunctionData({ abi: UPDATE_V2_ABI, data: t.data }); } catch { throw new RecipientError("the adapter's update is not a vault update"); }
  if (call.functionName !== "update") throw new RecipientError(`the adapter returned ${call.functionName}, not update`);
  const [tid, u] = call.args;
  const bad = (what) => { throw new RecipientError(`the adapter's update ${what}: the owner must not sign it`); };
  if (String(tid).toLowerCase() !== want.id) bad(`is for deployment ${tid}`);
  if (u.expectPolicyRev !== BigInt(want.expectPolicyRev)) bad(`guards revision ${u.expectPolicyRev}, not ${want.expectPolicyRev}`);
  if (u.setPolicy !== false || String(u.committeeId).toLowerCase() !== ZERO32 || u.paused !== false || u.rules !== "0x") bad("changes the policy, committee, rules or pause");
  if (clear) { if (u.clear !== true || u.setBundle !== false || u.bundle !== "0x") bad("is not exactly a clear"); }
  else if (u.clear !== false || u.setBundle !== true || String(u.bundle).toLowerCase() !== String(sealedBundle || "").toLowerCase()) bad("does not carry exactly the bundle sealed here");
  return t;
}
