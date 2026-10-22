// The owner's side of writing custody v2 secrets through a REMOTE independent MCP adapter. This runs on the owner's own
// machine: the values are sealed HERE, to the committee's public key, before anything is sent. The adapter receives only
// the ciphertext and the revision guard.
//   1. set_secrets {id, action: "prepare"} on the adapter      -> `sealing` (public: committee key, label fields,
//                                                               next revision, the deployment's config commitment)
//   2. sealForRemote(sealing, env)  (this file, locally)       -> { sealedBundle, expectPolicyRev }
//   3. set_secrets {id, action: "write", sealedBundle, expectPolicyRev} on the adapter -> the vault update the owner sends
// `env` is the WHOLE map: a merge needs the current values, which only the owner's own client can read (the committee's
// owner read: the local MCP server's get_secrets, or `enclave --independent … secrets ls --show`).
// The seal is the existing custody v2 encryption (custody/v2/protocol.mjs labelOf + encryptBundle), byte for byte what the
// CLI and a local server write.
import * as v2 from "../custody/v2/protocol.mjs";
import { checkEnv } from "../custody/protocol.mjs";

const HEX = (n) => new RegExp(`^0x[0-9a-f]{${n}}$`);
/** sealing: the adapter's prepare answer (its `sealing` object, or the whole answer); env: { NAME: value } */
export function sealForRemote(sealing, env, { configSha256 } = {}) {
  const s = sealing?.sealing || sealing;
  if (!s || typeof s !== "object") throw new Error("sealForRemote needs the adapter's prepare answer");
  const vault = String(s.vault || "").toLowerCase(), id = String(s.id || "").toLowerCase(), committeeId = String(s.committeeId || "").toLowerCase();
  if (!HEX(40).test(vault) || !HEX(64).test(id) || !HEX(64).test(committeeId)) throw new Error("the prepare answer lacks the vault, id or committee");
  if (!/^0x0[23][0-9a-f]{64}$/.test(String(s.committeeY || ""))) throw new Error("the prepare answer's committee key is not a compressed point");
  if (!Number.isSafeInteger(Number(s.chainId)) || !/^\d+$/.test(String(s.nextSecretRev)) || !/^\d+$/.test(String(s.expectPolicyRev)))
    throw new Error("the prepare answer lacks the chain, revision or guard");
  const cfg = configSha256 ?? s.configSha256;
  if (!/^[0-9a-f]{64}$/.test(String(cfg || ""))) throw new Error("no config commitment: pass { configSha256 } (sha256 of the exact config the values go into)");
  checkEnv(env);
  if (!Object.keys(env).length) throw new Error("an empty map is a clear: use set_secrets {id, action: \"clear\"}");
  const Y = Buffer.from(String(s.committeeY).slice(2), "hex");
  const label = v2.labelOf({ chainId: Number(s.chainId), vault, id, secretRev: BigInt(s.nextSecretRev), committeeId });
  const bundle = v2.encryptBundle({ Y: new Uint8Array(Y), label, env, configSha256: cfg });
  return { sealedBundle: "0x" + Buffer.from(bundle).toString("hex"), expectPolicyRev: String(s.expectPolicyRev) };
}
