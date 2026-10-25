// The v1 custodian daemon's configuration from its environment, as a PURE function (no file, key or network access) so the
// chain-source rules are testable: custodian-daemon.mjs config() calls it and turns a throw into its usual die().
//   CUSTODY_CHAIN_SOURCE unset or "quorum": exactly the legacy rules (CUSTODY_RPCS, CUSTODY_MIN_AGREE default 2); any
//     verifier variable present (even blank) is refused.
//   CUSTODY_CHAIN_SOURCE=verifier: CUSTODY_CHAIN_VERIFIER required; CUSTODY_RPCS and CUSTODY_MIN_AGREE must be ABSENT - a
//     present-but-blank value is refused too (a blank variable is a configuration mistake, never "no fallback").
import path from "node:path";

const present = (env, k) => Object.prototype.hasOwnProperty.call(env, k) && env[k] !== undefined;
const bad = (m) => Object.assign(new Error(m), { code: "bad_config" });

export function custodianConfigFromEnv(env) {
  const vault = String(env.CUSTODY_VAULT || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(vault)) throw bad("CUSTODY_VAULT must be the vault's address");
  const maxAgeSec = env.CUSTODY_MAX_AGE_SEC === "off" ? null : parseInt(env.CUSTODY_MAX_AGE_SEC || "120", 10);
  const chainId = parseInt(env.CUSTODY_CHAIN_ID || "8453", 10), stateDir = path.resolve(env.CUSTODY_STATE_DIR || "custodian-state");
  const chainSource = present(env, "CUSTODY_CHAIN_SOURCE") ? String(env.CUSTODY_CHAIN_SOURCE).trim() : "quorum";
  if (chainSource === "verifier") {
    const mixed = ["CUSTODY_RPCS", "CUSTODY_MIN_AGREE"].filter((k) => present(env, k));
    if (mixed.length) throw bad(`CUSTODY_CHAIN_SOURCE=verifier: ${mixed.join(", ")} must be unset, not blank (the local verifier is the one chain authority)`);
    const verifier = String(env.CUSTODY_CHAIN_VERIFIER || "").trim();
    if (!verifier) throw bad("CUSTODY_CHAIN_SOURCE=verifier needs CUSTODY_CHAIN_VERIFIER (the local verifier URL)");
    const txBackend = present(env, "CUSTODY_TX_BACKEND") ? String(env.CUSTODY_TX_BACKEND).trim() : "";
    if (present(env, "CUSTODY_TX_BACKEND") && !txBackend) throw bad("CUSTODY_TX_BACKEND is blank: unset it (reads only) or name the own backend");
    return { vault, chainSource, verifier, txBackend: txBackend || null, maxAgeSec, chainId, stateDir };
  }
  if (chainSource !== "quorum") throw bad("CUSTODY_CHAIN_SOURCE must be quorum (default) or verifier");
  const stray = ["CUSTODY_CHAIN_VERIFIER", "CUSTODY_TX_BACKEND"].filter((k) => present(env, k));
  if (stray.length) throw bad(`${stray.join(", ")} set but CUSTODY_CHAIN_SOURCE is not verifier`);
  const rpcs = String(env.CUSTODY_RPCS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const minAgree = parseInt(env.CUSTODY_MIN_AGREE || "2", 10);
  if (rpcs.length < minAgree) throw bad(`CUSTODY_RPCS names ${rpcs.length} RPC(s) and CUSTODY_MIN_AGREE is ${minAgree}`);
  return { vault, rpcs, minAgree, maxAgeSec, chainId, stateDir };
}
