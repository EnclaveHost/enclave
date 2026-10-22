/* ============================================================
   Independent dashboard SECRETS (custody v2; docs/security/custody-owner-read.md): the deployment owner's own values,
   read back through the deployment's committee (the custodians' owner read) and written to the profile's pinned
   EnclaveSecretVaultV2. No Enclave API, relay or Enclave-issued token is used: the chain is read at a block the
   profile's RPCs agree on, the custodians are called at the endpoints the vault names, and the vault and the
   custodians themselves enforce ownership, the ownerRead opt-in, pause and revisions.
   The protocol is NOT reimplemented here: /vendor/custody-v2.js (scripts/build-custody-v2-vendor.mjs) is the same
   owner-read client (custody/v2/owner-secrets.mjs), agreed chain reader, rules parsers and bundle code the custodians
   and the CLI (enclave --independent … secrets) run.
   Values: an owner read returns plaintext only into the caller's hands. Nothing here logs, stores (no localStorage,
   sessionStorage or IndexedDB) or copies a value; the ephemeral recipient key is zeroed by the client after each read.
   Who acts: the dashboard identity - the connected wallet (EIP-712 by eth_signTypedData_v4), or a verified passkey
   account (its Safe signs by ERC-1271 through its passkeys; its own calls are made by the Safe, sessions.js safeExecute).
   ============================================================ */
import { INDEPENDENT } from "./config.js";
import { Enclave, EnclaveError } from "./api.js";
import * as ID from "./identity.js";

export const VENDOR = "/vendor/custody-v2.js";
const ADDR = /^0x[0-9a-f]{40}$/, ZERO_ADDR = /^0x0{40}$/, ID32 = /^0x[0-9a-f]{64}$/, ZERO32 = "0x" + "00".repeat(32);
const READBACK_MS = 120000;
const lower = (x) => String(x || "").toLowerCase();
const short = (e) => String((e && (e.shortMessage || e.message)) || e).slice(0, 240);
const refuse = (message, code) => { throw Object.assign(new EnclaveError(message, 0), { code }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _vendor = null;
/** the custody v2 browser bundle (loaded on first use) */
export function vendor(){
  return (_vendor ||= import(VENDOR).catch((e) => { _vendor = null; throw new EnclaveError("Could not load the custody client: " + short(e), 0); }));
}

/** the profile's pinned vault, or a precise refusal */
export function pinnedVault(){
  if (INDEPENDENT.state !== "on") refuse("Secrets in independent mode need an active network profile (Settings → independent mode).", "no_profile");
  const v = lower(INDEPENDENT.profile.contracts && INDEPENDENT.profile.contracts.secretVaultV2);
  if (!ADDR.test(v) || ZERO_ADDR.test(v))
    refuse("Your network profile pins no custody vault (contracts.secretVaultV2), so this dashboard has no custody to read or write. Add the reviewed EnclaveSecretVaultV2 to the profile.", "no_vault");
  return v;
}

let _r = null;
/* the custody chain reader over the profile's RPCs: custody/v2/chain.mjs createChainReaderV2, an explicit majority */
async function custody(){
  const C = await vendor(), vault = pinnedVault(), p = INDEPENDENT.profile;
  if (_r && _r.vault === vault) return _r;
  const minAgree = Math.max(p.quorum, Math.floor(p.rpcs.length / 2) + 1);
  const reader = C.createChainReaderV2({ rpcs: [...p.rpcs], vault, chainId: p.chainId, minAgree, confirmations: p.confirmations,
                                         maxAgeSec: p.maxBlockAgeSeconds, timeoutMs: 15000 });
  _r = { C, vault, reader, minAgree, verified: null };
  return _r;
}

/* The pinned vault's immutable bindings, at an agreed block, against the profile's own pins (the CLI's --contract-pins
   rule): its ledger, its host registry and, when pinned, its session factory. The browser profile carries no code hash,
   so the code itself is not reviewed here (stated in the status). Checked once per page. */
async function verifyVault(r){
  if (r.verified) return r.verified;
  const IC = await import("./independent-chain.js"), q = IC.reader(), snap = await q.snapshot(), pins = INDEPENDENT.profile.contracts;
  const code = await q.code(snap, r.vault);
  if (!code || code === "0x") refuse("The pinned custody vault " + r.vault + " has no code on this chain: refusing it.", "vault_missing");
  const want = [["deploymentLedger", pins.deployments], ["hostRegistry", pins.registry],
                ...(pins.sessionVaultFactory && !ZERO_ADDR.test(lower(pins.sessionVaultFactory)) ? [["sessionVaultFactory", pins.sessionVaultFactory]] : [])];
  for (const [fn, expected] of want){
    let got;
    try { got = r.C.decodeFunctionResult({ abi: r.C.VAULT_V2_ABI, functionName: fn, data: await q.call(snap, r.vault, r.C.encodeFunctionData({ abi: r.C.VAULT_V2_ABI, functionName: fn })) }); }
    catch (e){ refuse("The pinned custody vault did not answer " + fn + " at an agreed block (" + short(e) + "): refusing it.", "vault_unreadable"); }
    if (lower(got) !== lower(expected)) refuse("The pinned custody vault's " + fn + " is " + lower(got) + ", not your profile's " + lower(expected) + ": refusing this vault.", "vault_mismatch");
  }
  return (r.verified = { block: snap.number, checked: want.map(([fn]) => fn) });
}

/** who this dashboard acts as, without any prompt: { kind: "wallet"|"account", address } (address null when unknown). A stored
    passkey account identity is re-verified on chain first (a page load), as every account action does. */
export async function identityAddress(){
  if (ID.currentIdentity().kind === "account") await ID.ensureIdentity().catch(() => {});
  const i = ID.currentIdentity();
  if (i.kind === "account") return { kind: "account", address: ID.actingOwner(null), state: i.state };
  return { kind: "wallet", address: Enclave.address ? lower(Enclave.address) : null, state: "verified" };
}
const whoText = (me) => (me.kind === "account" ? "your passkey account " : "your wallet ") + (me.address || "(none)");

/* The acting owner and its signer, for an action. A passkey account must be verified; nothing falls back to the wallet. */
async function actor(){
  const S = await import("./sessions.js");
  if (ID.currentIdentity().kind === "account"){
    const g = await S.grantOwner();
    return { kind: "account", address: lower(g.owner), signer: { address: lower(g.owner), signTypedData: (t) => g.signer.signTypedData(t) } };
  }
  if (!Enclave.provider || !Enclave.address) refuse("Connect the wallet that owns this deployment's custody policy.", "no_wallet");
  const o = (await S.sdk()).ownerFromProvider(Enclave.provider, Enclave.address);
  return { kind: "wallet", address: lower(Enclave.address), signer: { address: lower(Enclave.address), signTypedData: (t) => o.signTypedData(t) } };
}

/** ONE agreed read of the deployment's custody: { id, vault, st (readRelease), verified } */
export async function readState(id){
  id = lower(id);
  if (!ID32.test(id)) refuse("Not a deployment id.", "bad_id");
  const r = await custody(), verified = await verifyVault(r);
  let st;
  try { st = await r.reader.readRelease({ id, endpoint: null }); }
  catch (e){ refuse("The profile's chain endpoints did not agree on this deployment's custody (" + short(e) + "); nothing was read.", "chain"); }
  return { id, vault: r.vault, st, verified, minAgree: r.minAgree, rpcs: INDEPENDENT.profile.rpcs.length };
}

/** the status the panel shows: everything from the one agreed read, plus how the ownerRead opt-in reads */
export async function describe(s, me = null){
  me ||= await identityAddress();
  const C = await vendor(), st = s.st, pol = st.policy, exists = pol.policyRev > 0n;
  let rules = null, rulesError = null;
  if (exists) { try { rules = C.policyRulesOf(pol.rules); } catch (e){ rulesError = short(e); } }
  const com = st.committee;
  return {
    id: s.id, vault: s.vault, block: String(st.blockNumber), agreeing: s.minAgree + " of " + s.rpcs + " RPCs", vaultChecked: s.verified.checked,
    exists, owner: exists ? pol.owner : null, beneficialOwner: st.beneficialOwner, me,
    transferred: exists && st.beneficialOwner !== pol.owner, mine: !!me.address && (exists ? pol.owner === me.address : st.beneficialOwner === me.address),
    claimable: exists && st.beneficialOwner !== pol.owner && !!me.address && st.beneficialOwner === me.address,
    policyRev: String(pol.policyRev), secretRev: String(pol.secretRev), paused: exists && pol.paused, committeeId: exists ? pol.committeeId : null,
    committee: com ? { t: com.t, n: com.machines.length, epoch: com.epoch, enclaveSeats: com.machines.filter((m) => m.enclave).length,
                       endpoints: com.machines.map((m) => m.endpoint) } : null,
    kind: rules ? rules.kind : null, ownerRead: !!(rules && rules.ownerRead), ownerReadKey: rules ? (rules.rules.ownerRead === undefined ? "absent" : String(rules.rules.ownerRead)) : null,
    rulesError, stored: st.bundle.data.length > 0, bundleBytes: st.bundle.data.length,
  };
}

/* Precise refusals before anything is signed or sent. `read`: the action needs an owner read. */
async function gate(s, me, { read = false, create = false } = {}){
  const d = await describe(s, me);
  if (create){
    if (d.exists) refuse("This deployment already has a custody policy (revision " + d.policyRev + "): edit it instead.", "exists");
    if (d.beneficialOwner !== me.address) refuse("Only this deployment's owner " + (d.beneficialOwner || "(nobody)") + " can create its custody policy; this dashboard acts as " + whoText(me) + ".", "not_owner");
    return d;
  }
  if (!d.exists) refuse("No custody policy for this deployment yet: create one (as its owner) before storing values.", "no_policy");
  if (d.transferred) refuse("The ledger now names " + d.beneficialOwner + " as this deployment's owner, but its custody policy still belongs to " + d.owner
    + ": nothing can be read or written until the new owner claims custody, which destroys the stored values.", "transferred");
  if (d.owner !== me.address) refuse("This deployment's custody policy belongs to " + d.owner + "; this dashboard acts as " + whoText(me) + ". Switch to the owner's identity.", "not_owner");
  if (read){
    if (d.rulesError) refuse("The policy's rules do not parse (" + d.rulesError + "), so no owner read is possible.", "bad_rules");
    if (d.paused) refuse("Custody is paused for this deployment: its custodians release nothing, to you either. Resume it to list, show or edit single values; Replace all and Clear still work while paused.", "paused");
    if (!d.ownerRead) refuse("This policy's rules do not allow an owner read (ownerRead is " + (d.ownerReadKey === "absent" ? "absent, which means off" : "off")
      + "). Listing, showing and single-value edits need it: turn on owner read (a visible policy change, one signature), or use Replace all / Clear, which need no read.", "owner_read_disabled");
    if (!d.stored) refuse("No values are stored for this deployment, so there is nothing to read: use Replace all to store a set.", "empty");
  }
  return d;
}

/* ---- the custodian transport: https only, no credentials, no redirects, bounded ---- */
export function custodianFetch({ fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 20000, maxBytes = 1 << 20 } = {}){
  return async (url, body) => {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("custodian endpoints are https");
    let r;
    try {
      r = await fetchImpl(u.href, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
                                    headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e){ throw new Error("unreachable (" + (e && e.name === "TimeoutError" ? "timed out" : "network or CORS refusal") + ")"); }
    const text = await r.text();
    if (text.length > maxBytes) throw new Error("answer too large");
    let j; try { j = JSON.parse(text); } catch { throw new Error("HTTP " + r.status + " (not JSON)"); }
    if (!r.ok) throw Object.assign(new Error((j.error || "HTTP " + r.status) + ": " + String(j.message || "").slice(0, 200)), { code: j.error });
    return j;
  };
}

// what a custodian's refusal code means for the owner (the raw codes and endpoints are kept in the message's detail)
const READ_HINTS = [
  [/owner_read_disabled/, "the custodians read this policy's rules as not allowing an owner read"],
  [/\bpaused\b/, "the custodians see the policy as paused"],
  [/owner_mismatch/, "the custodians see the ledger's owner differ from the policy's owner (a transfer)"],
  [/stale_revision|wrong_committee|stale_epoch|chain_rollback/, "the custodians read a different custody state (it changed since this page read it, or their chain view differs): re-open to read again"],
  [/owner_sig/, "the custodians did not accept the owner's signature for this request (another signer, another recipient key, or the account's ERC-1271 refused it)"],
  [/bad_challenge|not_challenged|bad_expiry/, "a custodian did not accept the request's challenge or expiry (expired, already used, or issued for another purpose)"],
  [/bad_request/, "a custodian refused the request's form"],
  [/rate_limited/, "the owner-read budget for this deployment is spent (30 reads per 10 minutes per custodian); retry later"],
  [/not_found|HTTP 404|HTTP 405/, "custodians answered as code without owner read: they need the custodian image that serves it"],
  [/proof does not verify|answered as another key|ghash|aes\/gcm|invalid tag|partial/i, "a custodian's answer failed verification (its proof or its sealing) and was not used"],
  [/unreachable/, "custodians could not be reached"],
];
function explainRead(e, t){
  const m = short(e);
  if (!/insufficient custodians|no custodian issued/.test(m)) return e instanceof EnclaveError ? e : Object.assign(new EnclaveError("The owner read failed: " + m, 0), { code: "read_failed" });
  const why = READ_HINTS.filter(([re]) => re.test(m)).map(([, h]) => h);
  return Object.assign(new EnclaveError("Your values could not be read: fewer than the " + (t || "required") + " custodians the committee needs gave a valid answer"
    + (why.length ? " (" + why.join("; ") + ")" : "") + ". Nothing was changed. Detail: " + m, 0), { code: "insufficient", detail: m });
}

/* the owner read itself (custody/v2/owner-secrets.mjs readOwnerSecrets): plaintext into the caller's hands only */
async function ownerRead(s, me){
  const C = await vendor();
  try {
    return await C.readOwnerSecrets({ chainId: INDEPENDENT.profile.chainId, vault: s.vault, id: s.id, state: s.st, owner: me.signer, post: custodianFetch() });
  } catch (e){ throw explainRead(e, s.st.committee && s.st.committee.t); }
}

const utf8len = (v) => new TextEncoder().encode(v).length;
/** names and value sizes only (one owner read); the values are dropped before this returns */
export async function listSecrets(id){
  const me = await actor(), s = await readState(id);
  await gate(s, me, { read: true });
  const r = await ownerRead(s, me);
  const sizes = r.names.map((n) => [n, utf8len(r.env[n])]);
  return { names: r.names, sizes, secretRev: String(r.secretRev), policyRev: String(r.policyRev), answered: r.answered, block: String(s.st.blockNumber) };
}
/** the values themselves (an explicit "reveal": a fresh owner read). The caller shows them and discards them. */
export async function revealSecrets(id){
  const me = await actor(), s = await readState(id);
  await gate(s, me, { read: true });
  const r = await ownerRead(s, me);
  return { env: r.env, names: r.names, secretRev: String(r.secretRev), answered: r.answered };
}

/* config commitment for a write without a read: { mode: "inline" | "none" | "text", text } (as the CLI's --config-file /
   --no-config / the deployment's inline config) */
function configTextFor(C, config, st){
  const mode = config && config.mode;
  if (mode === "none") return "";
  if (mode === "text"){
    let o; try { o = JSON.parse(String(config.text || "")); } catch { refuse("The config you named is not JSON.", "bad_config"); }
    return C.configTextOf(o);
  }
  try { return C.configTextFromEnvelope(st.lease ? st.lease.envelope : ""); }
  catch (e){ refuse(short(e).replace(/ \(CLI: --config-file\)/, " (paste it below)").replace(/, or --no-config if it has none/, ", or choose “no config” if it has none") + ".", "config_needed"); }
}

/* ---- writes: the owner's own call to the vault, then an exact readback ---- */
async function stalePrecheck(s){
  const r = await custody();
  const now = await r.reader.readRelease({ id: s.id, endpoint: null });
  if (now.policy.policyRev !== s.st.policy.policyRev)
    refuse("Someone changed this deployment's custody after this page read it (policy revision " + s.st.policy.policyRev + " → " + now.policy.policyRev
      + "); nothing was sent and nothing changed. Re-open Secrets to read the current state and apply your change again.", "stale");
}
async function send(me, s, data){
  if (me.kind === "account"){
    await stalePrecheck(s);
    const S = await import("./sessions.js");
    return S.safeExecute({ to: s.vault, data });                 // the Safe calls the vault itself: msg.sender is the policy owner
  }
  const IC = await import("./independent-chain.js"), q = IC.reader(), snap = await q.snapshot();
  try { await q.call(snap, s.vault, data, { from: me.address }); }
  catch (e){
    if (e && e.revert){ await stalePrecheck(s); refuse("The vault refuses this update for " + whoText(me) + " (checked at block " + snap.number + "); nothing was sent.", "refused"); }
    refuse("The chain endpoints did not agree, so the update could not be checked (" + short(e) + "); nothing was sent.", "chain");
  }
  const { sendTx } = await import("./wallet.js"), { waitReceipt } = await import("./chain.js");
  const hash = await sendTx(s.vault, data, "0x0");
  await waitReceipt(hash);
  return hash;
}
/* read back through the agreed reader until the revision moved, then require EXACTLY what was written */
async function readBack(s, expect, { owner = null } = {}){
  const r = await custody(), before = s.st.policy, until = Date.now() + READBACK_MS;
  let last = "no agreed read yet";
  while (Date.now() < until){
    let now;
    try { now = await r.reader.readRelease({ id: s.id, endpoint: null }); } catch (e){ last = short(e); await sleep(1000); continue; }
    const p = now.policy;
    if (p.policyRev === before.policyRev){ last = "the agreed block " + now.blockNumber + " does not show the write yet"; await sleep(1000); continue; }
    const wrong = [];
    if (p.policyRev !== before.policyRev + 1n) wrong.push("policy revision " + p.policyRev + ", expected " + (before.policyRev + 1n));
    if (owner && p.owner !== owner) wrong.push("owner " + p.owner);
    for (const [k, v] of Object.entries(expect)){
      const got = k === "rules" ? r.C.bytesToHex(p.rules) : k === "bundle" ? r.C.bytesToHex(now.bundle.data) : k === "secretRev" ? p.secretRev : p[k];
      if (lower(got) !== lower(v)) wrong.push(k + (k === "bundle" || k === "rules" ? " (" + (String(got).length - 2) / 2 + " bytes)" : " " + got));
    }
    if (wrong.length) refuse("The vault at agreed block " + now.blockNumber + " does not show exactly this write (" + wrong.join("; ") + "): another change may have landed. Re-open Secrets and check.", "readback");
    return now;
  }
  refuse("The update was sent, but no agreed read confirmed it within " + Math.round(READBACK_MS / 1000) + " s (" + last + "). Do not resend: re-open Secrets to check.", "readback_timeout");
}
async function writeUpdate(me, s, update, expect, opts){
  const C = await vendor();
  const data = C.encodeFunctionData({ abi: C.UPDATE_V2_ABI, functionName: "update", args: [s.id, update] });
  const tx = await send(me, s, data);
  const after = await readBack(s, expect, opts);
  return { tx, block: String(after.blockNumber), policyRev: String(after.policy.policyRev), secretRev: String(after.policy.secretRev), after };
}

/**
 * editSecrets(id, { op, pairs, keys, config })
 *   op "set"      merge KEY=VALUE pairs into the current values (an owner read at revision N; written with expectPolicyRev N)
 *      "rm"       remove exactly these keys (each must exist)
 *      "replace"  exactly `pairs`, nothing read; `config` names the config the values may be substituted into
 *      "clear"    the vault's clear
 * -> { names, policyRev, secretRev, block, tx }
 */
export async function editSecrets(id, { op, pairs = {}, keys = [], config = null } = {}){
  const C = await vendor(), me = await actor(), s = await readState(id), pol = s.st.policy;
  const unchanged = { committeeId: pol.committeeId, paused: pol.paused, rules: C.bytesToHex(pol.rules) };
  if (op === "clear"){
    await gate(s, me);
    if (!s.st.bundle.data.length) return { names: [], policyRev: String(pol.policyRev), secretRev: String(pol.secretRev), block: String(s.st.blockNumber), tx: null, noop: true };
    const update = { expectPolicyRev: pol.policyRev, setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: false, bundle: "0x", clear: true };
    return { names: [], ...(await writeUpdate(me, s, update, { ...unchanged, secretRev: pol.secretRev + 1n, bundle: "0x" })) };
  }
  let read, env, configSha256;
  if (op === "replace"){
    await gate(s, me);
    if (!Object.keys(pairs).length) refuse("Nothing to store: enter at least one KEY=value (Clear removes every value).", "empty_set");
    configSha256 = C.configSha256(configTextFor(C, config, s.st));
    read = { policyRev: pol.policyRev, secretRev: pol.secretRev, committeeId: pol.committeeId };
    env = C.planSecretsEdit({ op: "replace", pairs });
  } else if (op === "set" || op === "rm"){
    await gate(s, me, { read: true });
    if (op === "set" && !Object.keys(pairs).length) refuse("Nothing to set: enter at least one KEY=value.", "empty_set");
    read = await ownerRead(s, me);
    configSha256 = read.configSha256;
    try { env = C.planSecretsEdit({ op, current: read.env, pairs, keys }); } catch (e){ refuse(short(e), "bad_edit"); }
  } else refuse("Unknown secrets edit.", "bad_edit");
  const { update, expect } = C.ownerEditUpdate({ chainId: INDEPENDENT.profile.chainId, vault: s.vault, id: s.id, read, committee: s.st.committee, env, configSha256 });
  const done = await writeUpdate(me, s, update, { ...unchanged, ...expect });
  return { names: Object.keys(env).sort(), ...done };
}

/* rules bytes re-encoded by their own format, after the owner's explicit change (the CLI's rulesFromObject) */
async function encodeRules(o){
  const C = await vendor();
  if (o && o.format === C.SHIELD_RULES_FORMAT){ C.validateShieldRules(o); return C.canonicalShieldRules(o); }
  C.validateRules(o); return C.canonicalRules(o);
}
/** turn the explicit ownerRead opt-in on or off: the rules re-encoded with the key; the committee, pause and values unchanged */
export async function setOwnerRead(id, on){
  const C = await vendor(), me = await actor(), s = await readState(id), pol = s.st.policy;
  const d = await gate(s, me);
  if (d.rulesError) refuse("The policy's rules do not parse (" + d.rulesError + "); replace them with the CLI (custody set --rules).", "bad_rules");
  const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pol.rules));
  const rules = C.bytesToHex(await encodeRules({ ...o, ownerRead: !!on }));
  const update = { expectPolicyRev: pol.policyRev, setPolicy: true, committeeId: pol.committeeId, paused: pol.paused, rules, setBundle: false, bundle: "0x", clear: false };
  return writeUpdate(me, s, update, { rules, committeeId: pol.committeeId, paused: pol.paused, secretRev: pol.secretRev, bundle: C.bytesToHex(s.st.bundle.data) });
}
/** pause or resume: the policy's own rule BYTES verbatim (never re-encoded), the committee and values unchanged */
export async function setPaused(id, paused){
  const C = await vendor(), me = await actor(), s = await readState(id), pol = s.st.policy;
  await gate(s, me);
  const rules = C.bytesToHex(pol.rules);
  const update = { expectPolicyRev: pol.policyRev, setPolicy: true, committeeId: pol.committeeId, paused: !!paused, rules, setBundle: false, bundle: "0x", clear: false };
  return writeUpdate(me, s, update, { rules, committeeId: pol.committeeId, paused: !!paused, secretRev: pol.secretRev, bundle: C.bytesToHex(s.st.bundle.data) });
}
/** the ledger's new owner takes over a moved policy (claimPolicy): the old values are destroyed, the policy is paused */
export async function claimCustody(id){
  const C = await vendor(), me = await actor(), s = await readState(id), d = await describe(s, me);
  if (!d.transferred) refuse("Nothing to claim: the ledger still gives this policy to its owner.", "nothing_to_claim");
  if (d.beneficialOwner !== me.address) refuse("Only the ledger's current owner " + d.beneficialOwner + " may claim this policy; this dashboard acts as " + whoText(me) + ".", "not_owner");
  const tx = await send(me, s, C.encodeFunctionData({ abi: C.UPDATE_V2_ABI, functionName: "claimPolicy", args: [s.id] }));
  const after = await readBack(s, { paused: true, secretRev: s.st.policy.secretRev + 1n, bundle: "0x" }, { owner: me.address });
  return { tx, block: String(after.blockNumber), policyRev: String(after.policy.policyRev) };
}

/** a committee's seat layout (agreed read), for choosing one: { committeeId, t, n, epoch, seats: [{ endpoint, enclave }] } */
export async function committeeLayout(committeeId){
  committeeId = lower(committeeId);
  if (!ID32.test(committeeId)) refuse("A committee id is 32 bytes of hex (0x…).", "bad_committee");
  const r = await custody(); await verifyVault(r);
  const { committee } = await r.reader.readCommittee({ committeeId });
  if (!committee) refuse("No committee " + committeeId + " in the pinned vault.", "no_committee");
  return { committeeId, t: committee.t, n: committee.machines.length, epoch: committee.epoch, seats: committee.machines.map((m) => ({ endpoint: m.endpoint, enclave: !!m.enclave })) };
}

/**
 * createPolicy(id, { rulesText, committeeId, ownerRead, pairs, config, allowEnclaveSeat })
 *   The first custody policy of a deployment, by its ledger owner: the rules (SNP custody rules, or Enclave Shield rules
 *   with their explicit acceptTier), the committee, the EXPLICIT owner-read choice (written as the rules' ownerRead key
 *   only when on, so "off" is the classic rule bytes), and the first values, encrypted here to the committee's key.
 */
export async function createPolicy(id, { rulesText, committeeId, ownerRead = false, pairs = {}, config = null, allowEnclaveSeat = false } = {}){
  const C = await vendor(), me = await actor(), s = await readState(id);
  await gate(s, me, { create: true });
  let o; try { o = JSON.parse(String(rulesText || "")); } catch { refuse("The rules are not JSON.", "bad_rules"); }
  if (!o || typeof o !== "object" || Array.isArray(o)) refuse("The rules are not a JSON object.", "bad_rules");
  const { ownerRead: _drop, ...base } = o;
  let rulesBytes;
  try { rulesBytes = await encodeRules(ownerRead ? { ...base, ownerRead: true } : base); } catch (e){ refuse("The rules are not valid: " + short(e), "bad_rules"); }
  const lay = await committeeLayout(committeeId);
  const enclaveSeats = lay.seats.filter((x) => x.enclave);
  if (enclaveSeats.length && !allowEnclaveSeat)
    refuse("Committee " + lay.committeeId.slice(0, 10) + "… has " + enclaveSeats.length + " Enclave-operated seat(s) (" + enclaveSeats.map((x) => x.endpoint).join(", ") + "): allow it explicitly, or choose an independent committee.", "enclave_seat");
  if (!Object.keys(pairs).length) refuse("Enter at least one KEY=value to store.", "empty_set");
  C.checkEnv(pairs);
  const r = await custody(), { committee } = await r.reader.readCommittee({ committeeId: lay.committeeId });
  const secretRev = s.st.policy.secretRev + 1n;
  const bundle = C.encryptBundle({ Y: committee.Y, label: C.labelOf({ chainId: INDEPENDENT.profile.chainId, vault: s.vault, id: s.id, secretRev, committeeId: lay.committeeId }),
                                   env: pairs, configSha256: C.configSha256(configTextFor(C, config, s.st)) });
  const rules = C.bytesToHex(rulesBytes), bundleHex = C.bytesToHex(bundle);
  const update = { expectPolicyRev: 0n, setPolicy: true, committeeId: lay.committeeId, paused: false, rules, setBundle: true, bundle: bundleHex, clear: false };
  const done = await writeUpdate(me, s, update, { rules, committeeId: lay.committeeId, paused: false, secretRev, bundle: bundleHex }, { owner: me.address });
  return { names: Object.keys(pairs).sort(), ownerRead: !!ownerRead, ...done };
}
