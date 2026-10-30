// `enclave custody …`: the owner's side of secret custody (docs/security/secret-custody.md). The env map is encrypted HERE,
// on the owner's machine, to the deployment's custodian committee and written to EnclaveSecretVault on Base; nothing
// readable leaves this process, and the relay never sees a value.
//
//   enclave custody status  <id>
//   enclave custody set     <id> KEY=VALUE… [--file .env] [--rules rules.json | --rules-from-relay --admit] [--committee 0x…]
//                           [--config-file app-config.json | --no-config]
//   enclave custody migrate <id> (same options)                       relay copy -> custody, then cleared
//
// --config-file: the EXACT config JSON the app's values are substituted into (committed in the bundle; the guest refuses any
// other). Without it, a config inline in the deployment's envelope is read from the chain; anything else must be named.
//   enclave custody pause   <id> | resume <id>
//
// The vault: ENCLAVE_SECRET_VAULT, else the address book's "secretVault". The committee: --committee, else the policy's
// current one, else ENCLAVE_CUSTODY_COMMITTEE. `set` replaces the WHOLE set (custody cannot read the current values back
// to merge into: keep your source of truth, e.g. the .env file, yourself).
import { buildBundle, makeUpdate, UPDATE_ABI } from "../custody/owner.mjs";
import { createChainReader } from "../custody/chain.mjs";
import { configTextOf, configTextFromEnvelope, configSha256 } from "../custody/protocol.mjs";
import { validateRules, parseRules, rulesFromPrediction, DEFAULT_MIN_TCB } from "../custody/rules.mjs";
export { rulesFromPrediction, DEFAULT_MIN_TCB };

// the platform's bootstrap committee (docs/security/secret-custody.md: NOT decentralized; replaced by resharing), used when
// nothing else names a committee
export const PLATFORM_COMMITTEE = "0xf14080496fbb6f12aee6577fd3f0fdc2ba1226a159b727dbfc8bf0de07fe4f9c";

const USAGE = "usage: enclave custody status <id>\n"
  + "     | enclave custody set <id> KEY=VALUE… [--file .env] [--rules rules.json | --rules-from-relay --admit] [--committee 0x…] [--config-file app-config.json | --no-config]\n"
  + "     | enclave custody migrate <id> [--rules rules.json | --rules-from-relay --admit] [--committee 0x…] [--config-file app-config.json | --no-config]\n"
  + "     | enclave custody pause <id> | enclave custody resume <id>\n"
  + "  add --v2 to any of them for custody v2: the host-run committee (EnclaveSecretVaultV2; docs/security/secret-custody-v2.md)";

export async function cmdCustody(rest, h) {
  const sub = rest.shift();
  if (!["status", "set", "migrate", "pause", "resume"].includes(sub || "")) throw new Error(USAGE);
  const f = h.flags(rest, { bool: ["--rules-from-relay", "--admit", "--no-config", "--v2"], val: ["--file", "--rules", "--committee", "--config-file"] });
  if (!f._[0]) throw new Error(USAGE);
  if (f.v2) { const { cmdCustodyV2 } = await import("./custody-v2.mjs"); return cmdCustodyV2(sub, f, h); }
  const account = h.loadKey();
  const id = (await h.resolveId(f._[0], account)).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("custody needs an on-chain deployment (bytes32 id)");
  const vault = (await h.vaultAddress()).toLowerCase();
  const clients = h.pubEachClients();
  const minAgree = Math.min(2, clients.length);
  if (minAgree < 2) h.warn("! one RPC configured: the committee keys your secrets are sealed to are only as trustworthy as it (pass --rpc a,b)");
  const reader = createChainReader({ clients, vault, minAgree });
  const chainId = h.chainId;
  const st = await reader.readState({ id });
  const pol = st.policy;

  if (sub === "status") {
    if (pol.policyRev === 0n) return h.say(`no custody policy for ${h.short(id)}: its secrets (if any) are relay-held (enclave custody migrate ${h.short(id)})`);
    const out = { vault, id, owner: pol.owner, policyRev: String(pol.policyRev), secretRev: String(pol.secretRev), paused: pol.paused,
                  committee: pol.committeeId, epoch: st.bundle.epoch, bundleBytes: st.bundle.ciphertext.length,
                  threshold: st.committee?.threshold ?? null, custodians: (st.committee?.members || []).map((m) => m.endpoint),
                  rules: (() => { try { return parseRules(pol.rules); } catch (e) { return `UNPARSEABLE: ${e.message}`; } })() };
    if (h.json) return h.jout(out);
    for (const [k, v] of Object.entries(out)) h.say(`${k.padEnd(12)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
    return;
  }

  // the policy this update writes
  const committeeId = String(f.committee || (pol.policyRev ? pol.committeeId : "") || h.env.ENCLAVE_CUSTODY_COMMITTEE || PLATFORM_COMMITTEE).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(committeeId)) throw new Error("no custodian committee: pass --committee 0x… (or set ENCLAVE_CUSTODY_COMMITTEE)");
  let rules;
  if (f.rules) rules = validateRules(JSON.parse(h.readFile(f.rules)));
  else if (f["rules-from-relay"]) {
    // the relay's prediction decides WHICH CODE may receive the values, so it is shown and admitted explicitly, never
    // taken silently (review H3); reproduce it independently first (docs/security/secret-custody.md §5.4)
    rules = rulesFromPrediction(await h.api("GET", `/v1/expected-guest?id=${id}`));
    h.say(`the relay predicts app ${rules.appId} and these images for this version (reproduce them before admitting):`);
    for (const im of rules.images) h.say(`  ${im.platform}  measurement ${im.measurement}  runtime ${im.runtimeId}`);
    if (!f.admit) throw new Error("not admitted: re-run with --admit once you have checked these images (or pass --rules with your own)");
  }
  else if (pol.policyRev) rules = parseRules(pol.rules);
  else throw new Error("no rules yet: pass --rules rules.json, or --rules-from-relay to admit the relay's public prediction for this version");

  if (sub === "pause" || sub === "resume") {
    if (!pol.policyRev) throw new Error("no custody policy to pause or resume");
    await h.sendTx(account, { address: vault, abi: UPDATE_ABI, functionName: "update",
      args: [id, makeUpdate({ expectPolicyRev: pol.policyRev, policy: { committeeId: pol.committeeId, paused: sub === "pause", rules } })] });
    return h.say(sub === "pause" ? "paused: custodians release nothing for this deployment until you resume" : "resumed");
  }

  let env;
  if (sub === "set") {
    env = h.secretsKv(f._.slice(1), f.file);
    if (!Object.keys(env).length) throw new Error("nothing to set: pass KEY=VALUE arguments and/or --file .env (custody replaces the whole set)");
  } else {   // migrate: the relay's copy, read by the owner signature as today
    const r = await h.relayRead(id);
    env = r.env || {};
    if (!Object.keys(env).length) throw new Error("the relay holds no secrets for this deployment: nothing to migrate (use enclave custody set)");
    h.say(`migrating ${Object.keys(env).length} secret(s) from the relay (rev ${r.rev}): ${Object.keys(env).sort().join(", ")}`);
  }

  // the config the values may go into (the guest refuses any other, so the relay cannot redirect them; review H2)
  const configText = f["config-file"] ? configTextOf(JSON.parse(h.readFile(f["config-file"])))
    : f["no-config"] ? "" : configTextFromEnvelope(st.lease ? st.lease.envelope : "");
  h.say(`the values may only be substituted into the config with sha256 ${configSha256(configText).slice(0, 16)}… (${configText ? configText.length + " bytes" : "no config"}); a different config makes the app refuse them`);
  // seal to the committee's CURRENT epoch, as the agreeing RPCs state it
  const { epoch } = await reader.readCommittee({ committeeId });
  if (!epoch) throw new Error(`no committee ${committeeId} in the vault`);
  const ep = await reader.readEpoch({ committeeId, epoch });
  h.say(`sealing to committee ${committeeId.slice(0, 10)}… epoch ${epoch}: ${ep.threshold} of ${ep.members.length} — ${ep.members.map((m) => m.endpoint).join(", ")}`);
  const bundle = buildBundle({ chainId, vault, id, secretRev: pol.secretRev + 1n, committeeId, epoch, threshold: ep.threshold, members: ep.members, env, configText });
  await h.sendTx(account, { address: vault, abi: UPDATE_ABI, functionName: "update",
    args: [id, makeUpdate({ expectPolicyRev: pol.policyRev, policy: { committeeId, paused: false, rules }, bundle: { ...bundle, epoch } })] });
  // read it back through the agreeing RPCs before anything else changes
  let after;
  for (let i = 0; i < 20; i++) {
    after = await reader.readState({ id });
    if (after.policy.secretRev === pol.secretRev + 1n) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (after.policy.secretRev !== pol.secretRev + 1n || Buffer.compare(Buffer.from(after.bundle.ciphertext), Buffer.from(bundle.ciphertext)) !== 0)
    throw new Error("the vault does not show the bundle just written; nothing else was changed (re-run status)");
  h.say(`custody: secrets revision ${after.policy.secretRev}, policy revision ${after.policy.policyRev}`);

  if (sub === "migrate") {
    // the relay must know the deployment is custody-held BEFORE its copy goes: a relay without custody would then release
    // nothing at all, and the app would start without its secrets
    const ex = await h.api("POST", "/v1/secrets/exists", { body: { id } }).catch(() => null);
    if (!ex || ex.custody !== true) {
      h.say("! the relay does not report this deployment as custody-held yet (its CUSTODY_VAULT is not this vault, or not set):");
      h.say("  its plaintext copy was NOT cleared. Re-run `enclave custody migrate` once it does, or clear it with `enclave secrets clear`.");
      return;
    }
    await h.relayClear(id);
    h.say("the relay's plaintext copy is deleted.");
    h.say("! the relay held these values in a form its operator could read: ROTATE each credential at its issuer, then `enclave custody set` the new values.");
  }
  h.say(`a running app picks them up on its next start: enclave restart ${h.short(id)}`);
}
