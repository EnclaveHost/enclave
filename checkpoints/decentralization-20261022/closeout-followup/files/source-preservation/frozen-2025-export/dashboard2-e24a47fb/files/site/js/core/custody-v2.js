/* ============================================================
   Custody v2, owner side, in the browser (docs/security/secret-custody-v2.md).
   The owner's env map is encrypted IN THIS PAGE to the committee key Y read from
   EnclaveSecretVaultV2 and written by the owner's own wallet (one `update`). The
   relay and the host never receive a v2 value from this path. The code that
   encrypts, reads the chain and judges the vault is /vendor/custody-v2.js: the
   repository's custody/v2 owner, chain-reader, rules and reviewed-vault code,
   bundled same-origin (scripts/build-custody-v2-vendor.mjs).

   Which vault: ONLY the one the administrator's EnclaveAddressBook names under
   "secretVaultV2" (or an independent profile's own pin). There is no default:
   unlike the CLI this page never falls back to 0xE486. A named vault is used only
   after it is VERIFIED - it is in the reviewed table (network/custody-vaults.mjs)
   as a production vault, its code hash and immutables match at a block the RPCs
   agree on, and (book-named) the book still names it at that agreed block.
   Anything else is a precise state the panel shows - unset, unreviewed,
   unreadable, mismatch - and no v2 action exists in it. Nothing falls back to v1.

   What the committee IS is stated, never badged: t of W shares, its seats and
   how many are Enclave-operated. One seat, or every seat Enclave-operated, is a
   BOOTSTRAP, not decentralized custody.

   Who signs: the policy's owner (or, for a first write, the vault's
   beneficialOwnerOf - the ledger owner, or a SessionVault's owner). An EOA owner
   signs with the connected wallet. A contract owner (a Safe or passkey account)
   is refused here with the exact EIP-712 update it would sign (updateBySig): the
   dashboard does not drive contract-account signing for custody yet.
   ============================================================ */
import { SECRET_VAULT_V2_ADDRESS, ADDRESS_BOOK_ADDRESS, APP_CATALOG_RPCS, APP_CATALOG_CHAIN, INDEPENDENT } from "./config.js";

export const VENDOR_V2 = "../../vendor/custody-v2.js";
// The committee a FIRST v2 policy is sealed to unless the owner's policy already names one: the committee the Enclave
// seat created on Base at genesis (2026-10-14; cli/custody-v2.mjs PLATFORM_COMMITTEE_V2). It is shown with its exact
// t/W and seats before the owner admits anything; it is a single-seat Enclave bootstrap, and the panel says so.
export const CUSTODY_COMMITTEE_V2 = "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3";
export const BOOK_KEY_V2 = "secretVaultV2";
const ADDR = /^0x[0-9a-f]{40}$/, ZERO_ADDR = "0x" + "00".repeat(20), ID32 = /^0x[0-9a-f]{64}$/;
const lc = (x) => String(x || "").toLowerCase();
const short = (e) => String((e && (e.shortMessage || e.message)) || e).slice(0, 240);
const SESSION_OWNER_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const BOOK_ADDR_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "key", type: "bytes32" }], outputs: [{ type: "address" }] }];

export class CustodyV2Error extends Error {
  constructor(message, code, extra = {}){ super(message); this.name = "CustodyV2Error"; this.code = code; Object.assign(this, extra); }
}
const refuse = (message, code, extra) => { throw new CustodyV2Error(message, code, extra); };

let _lib = null, _deps = null, _vault = null;
/** tests only: { lib, config: { vault, book, chainId, rpcs, independent }, now, sleep } */
export function _setForTests(deps){ _deps = deps; _vault = null; }
const lib = () => _deps?.lib ? Promise.resolve(_deps.lib) : (_lib ||= import(VENDOR_V2).catch((e) => { _lib = null; throw new CustodyV2Error("could not load the custody v2 client: " + short(e), "no_client"); }));
const sleep = (ms) => (_deps?.sleep || ((m) => new Promise((r) => setTimeout(r, m))))(ms);
function cfg(){
  if (_deps?.config) return _deps.config;
  return { vault: SECRET_VAULT_V2_ADDRESS, book: ADDRESS_BOOK_ADDRESS, chainId: APP_CATALOG_CHAIN, rpcs: APP_CATALOG_RPCS, independent: INDEPENDENT, committee: CUSTODY_COMMITTEE_V2 };
}
// the RPCs and agreement the reads use: an independent profile's own (never fewer routes or a weaker agreement than the
// rest of its dashboard), else up to three of the site's public RPCs, two of which must agree
function quorumOf(c){
  const ind = c.independent;
  if (ind && ind.state === "on"){
    const p = ind.profile;
    return { rpcs: [...p.rpcs], minAgree: Math.max(p.quorum, Math.floor(p.rpcs.length / 2) + 1), confirmations: p.confirmations, maxAgeSec: p.maxBlockAgeSeconds, source: "profile" };
  }
  const rpcs = c.rpcs.slice(0, 3);
  return { rpcs, minAgree: Math.min(2, rpcs.length), confirmations: 0, maxAgeSec: 120, source: "book" };
}

/**
 * The vault this page may use, judged now: { state, why, vault?, ... }.
 *   unset       nothing names a v2 vault (book key secretVaultV2 is zero/absent, or the profile pins none)
 *   unreviewed  the named address is not a reviewed PRODUCTION EnclaveSecretVaultV2 for this chain
 *   unreadable  the RPCs did not agree (or did not answer): nothing about the vault is known
 *   mismatch    its code, immutables or the book's agreed entry differ from what was reviewed / resolved
 *   verified    usable; `reader` is the agreed custody v2 reader for it
 * Only `verified` carries a reader. A state is recomputed per call unless it is a verified one for the same address.
 */
export async function vaultState(){
  const c = cfg(), q = quorumOf(c);
  const vault = lc(c.vault);
  if (!vault || vault === ZERO_ADDR)
    return { state: "unset", why: q.source === "profile" ? "your network profile pins no contracts.secretVaultV2" : "the EnclaveAddressBook names no " + BOOK_KEY_V2 + " (unset)" };
  if (!ADDR.test(vault)) return { state: "unreviewed", vault, why: "the configured custody v2 address is malformed" };
  const L = await lib();
  const reviewed = L.REVIEWED_CUSTODY_VAULTS[vault];
  if (!reviewed || reviewed.production !== true || reviewed.kind !== "book" || Number(reviewed.chainId) !== Number(c.chainId))
    return { state: "unreviewed", vault, why: reviewed ? "a reviewed non-production EnclaveSecretVaultV2 variant: no production committee or policy uses it"
                                                     : "not a reviewed EnclaveSecretVaultV2 (network/custody-vaults.mjs)" };
  if (q.minAgree < 2) return { state: "unreadable", vault, why: "custody needs at least two agreeing RPCs, and only " + q.rpcs.length + " is configured" };
  // the code identity is judged once per page and vault; the book's naming of it (below) is re-read on EVERY call, so an
  // administrator's rollback of secretVaultV2 stops this page's v2 actions at once
  let reader = _vault && _vault.vault === vault ? _vault.reader : null, identity = _vault && _vault.vault === vault ? _vault.identity : null;
  if (!reader) try {
    reader = L.createChainReaderV2({ rpcs: q.rpcs, vault, chainId: c.chainId, minAgree: q.minAgree, confirmations: q.confirmations, maxAgeSec: q.maxAgeSec,
                                     vaultKind: "book", book: reviewed.immutable.book, timeoutMs: 15000 });
  } catch (e) { return { state: "unreadable", vault, why: short(e) }; }
  if (!identity){
    let seen;
    try { seen = await reader.readVaultIdentity(); }
    catch (e) { return { state: "unreadable", vault, why: "the RPCs did not agree on the vault's code: " + short(e) }; }
    try { L.checkCustodyVaultIdentity(vault, seen); }
    catch (e) { return { state: "mismatch", vault, why: short(e) }; }
    identity = seen;
    _vault = { vault, reader, identity };
  }
  // book-named: the book must still name THIS vault at an agreed block (the page's own book resolve is one RPC's word)
  if (q.source === "book"){
    const book = lc(c.book);
    if (!ADDR.test(book) || book !== lc(reviewed.immutable.book))
      return { state: "mismatch", vault, why: "the site's address book " + (book || "(none)") + " is not the book this vault reads" };
    let named;
    try { named = lc((await reader.snapshot(async ({ call }) => ({ named: await call(book, BOOK_ADDR_ABI, "addr", [L.stringToHex(BOOK_KEY_V2, { size: 32 })]) }))).named); }
    catch (e) { return { state: "unreadable", vault, why: "the RPCs did not agree on the book's " + BOOK_KEY_V2 + ": " + short(e) }; }
    if (named === ZERO_ADDR) return { state: "unset", why: "the EnclaveAddressBook names no " + BOOK_KEY_V2 + " at the agreed block" };
    if (named !== vault) return { state: "mismatch", vault, why: "the book names " + named + " at the agreed block, not " + vault };
  }
  return { state: "verified", vault, reader, reviewed, source: q.source, rpcs: q.rpcs.length, minAgree: q.minAgree, codeHash: identity.codeHash };
}

async function verified(){
  const v = await vaultState();
  if (v.state !== "verified") refuse("custody v2 is " + v.state + ": " + v.why, "vault_" + v.state, { vaultState: v });
  return v;
}

/**
 * What a committee is, exactly: never a badge. Seats are counted as the vault and custody/v2/protocol.mjs seatLayout count
 * them: every Enclave-flagged machine is ONE Enclave seat (its replicas hold the same shares), each other machine its own
 * seat. n = 1 is a SINGLE-SEAT bootstrap. More seats are stated as such and never called decentralized or independent:
 * distinct registry hosts or operator addresses do not prove distinct operators or failure domains.
 */
export function describeCommittee(committee){
  if (!committee) return null;
  const machines = committee.machines.length, enclaveMachines = committee.machines.filter((m) => m.enclave).length;
  const otherSeats = machines - enclaveMachines, n = otherSeats + (enclaveMachines ? 1 : 0);
  const shares = committee.t + " of " + committee.W + " shares";
  const kind = n === 1 ? "single-seat-bootstrap" : "multi-seat";
  const label = n === 1
    ? "SINGLE-SEAT BOOTSTRAP: n = 1 seat (" + (enclaveMachines ? "the Enclave seat" : "one non-Enclave seat") + "), t = " + committee.t + " of W = " + committee.W + " shares, on "
      + machines + " machine" + (machines === 1 ? "" : "s holding the same shares") + " - protection rests on that one seat's TEE, attestation and software; this is not decentralized custody"
    : "n = " + n + " seats, t = " + committee.t + " of W = " + committee.W + " shares (" + (enclaveMachines ? "1 Enclave seat on " + enclaveMachines + " machine" + (enclaveMachines === 1 ? "" : "s") + " + " : "")
      + otherSeats + " other seat" + (otherSeats === 1 ? "" : "s") + ") - the vault does not show that the other seats are independent operators or separate failure domains";
  return { committeeId: committee.committeeId, epoch: committee.epoch, t: committee.t, W: committee.W, n, machines, enclaveMachines, otherSeats,
           endpoints: committee.machines.map((m) => ({ endpoint: m.endpoint, enclave: !!m.enclave })), kind, label };
}

/** The deployment's v2 state for the panel: { vault, policy|null, committee|null, ... }; never throws for a non-verified vault. */
export async function statusV2(id){
  const v = await vaultState();
  if (v.state !== "verified") return { vault: v, policy: null };
  id = lc(id);
  if (!ID32.test(id)) refuse("custody v2 needs an on-chain deployment id (bytes32)", "bad_id");
  const L = await lib();
  const st = await v.reader.readRelease({ id, endpoint: null });
  const pol = st.policy;
  let configSha256 = null, configNote = null;
  try { configSha256 = L.configSha256(L.configTextFromEnvelope(st.lease ? st.lease.envelope : "")); }
  catch (e) { configNote = short(e); }
  const base = { vault: v, beneficialOwner: st.beneficialOwner, leaseOwner: st.lease ? st.lease.owner : null, configSha256, configNote };
  if (!pol.policyRev) return { ...base, policy: null, committee: null };
  let rules = null, rulesError = null;
  try { rules = L.parseRules(pol.rules); } catch (e) { rulesError = short(e); }
  return { ...base,
    policy: { owner: pol.owner, policyRev: pol.policyRev, secretRev: pol.secretRev, paused: !!pol.paused, committeeId: pol.committeeId,
              hasBundle: st.bundle.data.length > 0, bundleBytes: st.bundle.data.length, rules, rulesError,
              ownerMoved: pol.owner !== st.beneficialOwner },
    committee: describeCommittee(st.committee) };
}

// The owner this page must sign as, at the agreed block, and whether the connected wallet is it (EOA only).
async function ownerCheck(v, st, signer){
  const owner = st.policy.policyRev ? st.policy.owner : st.beneficialOwner;
  if (!owner || owner === ZERO_ADDR) refuse("this deployment has no owner on the ledger the vault reads", "no_owner");
  if (st.policy.policyRev && st.policy.owner !== st.beneficialOwner)
    refuse("the ledger moved this deployment to " + st.beneficialOwner + ": only that owner's claimPolicy (which destroys the bundle) may follow - use the CLI", "owner_moved");
  // (the agreed reader merges an OBJECT result with its block facts: a bare value would be lost)
  const { code } = await v.reader.snapshot(async ({ code }) => ({ code: await code(owner) }));
  if (code && code !== "0x") {
    // A SessionVault the vault did NOT unwrap (the book names no sessionVaultFactory, so beneficialOwnerOf is the SessionVault
    // itself). The contracts WOULD accept a policy sent through SessionVault.ownerCall (msg.sender = the SessionVault), but
    // that pins the SessionVault as the policy owner: once the administrator configures the factory, the vault's owner
    // becomes the wallet, the pinned policy can no longer be updated, and only claimPolicy follows - which destroys its
    // bundle (test/custody-v2-dashboard-contract.test.mjs shows both). So the dashboard refuses and names the gate.
    let sessionOwner = null;
    try { sessionOwner = lc((await v.reader.snapshot(async ({ call }) => ({ owner: await call(owner, SESSION_OWNER_ABI, "owner", []) }))).owner); } catch { sessionOwner = null; }
    if (sessionOwner && ADDR.test(sessionOwner) && sessionOwner !== ZERO_ADDR)
      refuse("this deployment is held by the contract " + owner + " (it answers owner() = " + sessionOwner + ": a SessionVault?), and the address book names no "
        + "sessionVaultFactory, so the custody vault treats that contract itself as the owner. This dashboard does not create a v2 policy pinned to it: "
        + "after the administrator configures the factory the owner becomes " + sessionOwner + ", and a contract-pinned policy could then only be "
        + "claimed, which destroys its encrypted bundle. The administrator's sessionVaultFactory book entry is required first. Nothing was encrypted or sent",
        "session_vault_not_unwrapped", { owner, sessionOwner });
    refuse("the custody owner " + owner + " is a contract account (a Safe or passkey account): this dashboard does not sign custody updates for it yet. "
    + "That account must sign the vault's EIP-712 Update digest itself (updateBySig, custody/v2/owner.mjs updateTypedDataV2); nothing was encrypted or sent", "contract_owner", { owner });
  }
  const me = lc(signer && signer.address);
  if (!ADDR.test(me)) refuse("connect the owner's wallet first", "no_wallet");
  // a session key, a delegate or any other wallet is refused here, as the vault refuses it: only the custody owner signs
  if (me !== owner) refuse("the connected wallet " + me + " is not this deployment's custody owner " + owner + " (a session key never is): switch to that wallet", "not_owner", { owner });
  return owner;
}

async function sendUpdate(v, signer, id, update, onStep, what){
  const L = await lib();
  const data = L.encodeFunctionData({ abi: L.UPDATE_V2_ABI, functionName: "update", args: [id, update] });
  onStep({ step: "sign", needsOwnerSignature: true, text: "owner signature: one transaction to the vault " + v.vault + " (" + what + ")" });
  const hash = await signer.sendTx(v.vault, data);
  onStep({ step: "confirm", text: "waiting for the transaction " + String(hash).slice(0, 12) + "… to be mined" });
  await signer.waitReceipt(hash);
  return hash;
}

/**
 * The rules a FIRST v2 policy would admit, from the relay's public prediction, plus the committee they would be sealed to.
 * Shown to the owner, who admits them explicitly: the rules decide which code may receive the values.
 */
export async function planFirstPolicy(id, prediction){
  const v = await verified(), L = await lib();
  const rules = L.rulesFromPrediction(prediction);
  const firstCommittee = lc(cfg().committee || CUSTODY_COMMITTEE_V2);
  const { committee } = await v.reader.readCommittee({ committeeId: firstCommittee });
  if (!committee) refuse("the vault has no committee " + firstCommittee.slice(0, 10) + "…: no new v2 policy can be made", "no_committee");
  return { rules, committee: describeCommittee(committee) };
}

/**
 * Encrypt `env` (a COMPLETE set: it replaces the stored one) in this page and store it in the vault with one owner
 * transaction; then read it back. Rotation of values is the same call with the new set (secretRev + 1).
 * A first policy needs `admittedRules` (planFirstPolicy, explicitly admitted). An existing policy keeps its committee,
 * rules and pause state: only the bundle changes. -> { secretRev, policyRev, committee, configSha256, tx }
 */
// The config the values may be substituted into (the guest refuses any other): read off the chain when the deployment's
// options envelope carries it inline. A config at a CID or the catalog version's own is NOT taken from anyone's word here:
// the owner names that exact JSON (`configOverride: { json }`) or states there is none (`{ none: true }`), as the CLI's
// --config-file / --no-config. A wrong one makes the app refuse the values; it never sends them anywhere else.
function configTextFor(L, st, configOverride){
  try { return L.configTextFromEnvelope(st.lease ? st.lease.envelope : ""); }
  catch (e) {
    if (configOverride && configOverride.none === true) return "";
    if (configOverride && typeof configOverride.json === "string"){
      try { return L.configTextOf(configOverride.json); } catch { refuse("the config you named is not JSON", "config_bad"); }
    }
    refuse(short(e).replace(/ \(CLI: [^)]*\)/, "").replace(/, or --no-config if it has none/, "") + " - name that exact config JSON, or state that it has none, before saving", "config_unbound");
  }
}

export async function saveV2({ id, env, admittedRules = null, configOverride = null, signer, onStep = () => {} }){
  const v = await verified(), L = await lib();
  id = lc(id);
  if (!ID32.test(id)) refuse("custody v2 needs an on-chain deployment id (bytes32)", "bad_id");
  L.checkEnv(env);
  if (!Object.keys(env).length) refuse("custody stores a complete set: add KEY=value lines", "empty_set");
  onStep({ step: "read", text: "reading the vault at a block " + v.minAgree + " of " + v.rpcs + " RPCs agree on…" });
  const st = await v.reader.readRelease({ id, endpoint: null });
  const pol = st.policy;
  await ownerCheck(v, st, signer);
  const first = !pol.policyRev;
  const committeeId = first ? lc(cfg().committee || CUSTODY_COMMITTEE_V2) : pol.committeeId;
  let rules = null;
  if (first){
    if (!admittedRules) refuse("this deployment has no v2 custody rules yet: admit the predicted images first", "rules_not_admitted");
    rules = L.validateRules(admittedRules);
  }
  const { committee } = await v.reader.readCommittee({ committeeId });
  if (!committee) refuse("the vault has no committee " + committeeId.slice(0, 10) + "…", "no_committee");
  const desc = describeCommittee(committee);
  const configText = configTextFor(L, st, configOverride);
  const secretRev = pol.secretRev + 1n;
  onStep({ step: "encrypt", text: "encrypting " + Object.keys(env).length + " value(s) in this browser to committee " + committeeId.slice(0, 10) + "… (" + desc.label + ")" });
  const bundle = L.buildBundleV2({ chainId: Number(cfg().chainId), vault: v.vault, id, secretRev, committeeId, Y: committee.Y, env, configText });
  const update = L.makeUpdateV2({ expectPolicyRev: pol.policyRev, ...(first ? { policy: { committeeId, paused: false, rules } } : {}), bundle });
  const tx = await sendUpdate(v, signer, id, update, onStep, first ? "a new v2 policy and its first bundle" : "secrets revision " + secretRev);
  // read back: the vault must show THIS bundle at the next secret revision, or nothing is claimed
  onStep({ step: "verify", text: "reading the vault back…" });
  let after = null;
  for (let i = 0; i < 20; i++){
    after = await v.reader.readRelease({ id, endpoint: null });
    if (after.policy.secretRev >= secretRev) break;
    await sleep(1500);
  }
  if (!after || after.policy.secretRev !== secretRev || !sameBytes(after.bundle.data, bundle))
    refuse("the vault does not show the bundle just written (re-read the status before trying again)", "readback_mismatch", { tx });
  return { secretRev: after.policy.secretRev, policyRev: after.policy.policyRev, committee: desc, configSha256: L.configSha256(configText), tx };
}

/** Pause (custodians release nothing for this deployment) or resume, with one owner transaction; read back. */
export async function setPausedV2({ id, paused, signer, onStep = () => {} }){
  const v = await verified(), L = await lib();
  id = lc(id);
  const st = await v.reader.readRelease({ id, endpoint: null });
  const pol = st.policy;
  if (!pol.policyRev) refuse("no v2 custody policy to pause or resume", "no_policy");
  await ownerCheck(v, st, signer);
  if (!!pol.paused === !!paused) return { paused: !!pol.paused, policyRev: pol.policyRev, unchanged: true };
  const update = L.makeUpdateV2({ expectPolicyRev: pol.policyRev, policy: { committeeId: pol.committeeId, paused: !!paused, rules: L.parseRules(pol.rules) } });
  const tx = await sendUpdate(v, signer, id, update, onStep, paused ? "pause" : "resume");
  let after = null;
  for (let i = 0; i < 20; i++){
    after = await v.reader.readRelease({ id, endpoint: null });
    if (after.policy.policyRev > pol.policyRev) break;
    await sleep(1500);
  }
  if (!after || after.policy.policyRev !== pol.policyRev + 1n || !!after.policy.paused !== !!paused)
    refuse("the vault does not show the " + (paused ? "pause" : "resume") + " just written", "readback_mismatch", { tx });
  return { paused: !!after.policy.paused, policyRev: after.policy.policyRev, tx };
}

/**
 * MIGRATION of the relay's plaintext copy into custody v2, in the order that never loses the values:
 *   1. the owner reveals the relay copy (the relay's own owner-signed read; those values were already on the relay);
 *   2. they are encrypted HERE and stored in v2 (saveV2, read back);
 *   3. the relay's copy is NOT touched here - deleting it is a separate, explicit owner step (clearRelayCopyV2).
 * `relay`: { read(id) -> { env, rev }, exists(id) -> { custody } }.
 */
export async function migrateFromRelayV2({ id, relay, signer, admittedRules = null, configOverride = null, onStep = () => {} }){
  // a v2 set that already exists is never replaced by the relay's (older) copy: the owner saves a new set instead
  const now = await statusV2(id);
  if (now.vault.state !== "verified") refuse("custody v2 is " + now.vault.state + ": " + now.vault.why, "vault_" + now.vault.state, { vaultState: now.vault });
  if (now.policy && now.policy.hasBundle)
    refuse("custody v2 already holds a set for this deployment (secrets revision " + now.policy.secretRev + "): migrating the relay's copy would replace it. "
      + "Delete the relay's old copy instead, or save a new complete set", "v2_already_holds");
  // the config binding is settled BEFORE the owner signs the relay read (no signature is spent on a save that cannot happen)
  if (now.configNote && !(configOverride && (configOverride.none === true || typeof configOverride.json === "string")))
    refuse(now.configNote.replace(/ \(CLI: [^)]*\)/, "").replace(/, or --no-config if it has none/, "") + " - name that exact config JSON, or state that it has none, before migrating", "config_unbound");
  const r = await relay.read(id);
  const env = (r && r.env) || {};
  if (!Object.keys(env).length) refuse("the relay holds no secrets for this deployment: nothing to migrate", "nothing_to_migrate");
  onStep({ step: "relay-read", text: "the relay's copy (rev " + r.rev + "): " + Object.keys(env).sort().join(", ") });
  const saved = await saveV2({ id, env, admittedRules, configOverride, signer, onStep });
  const oldCopy = await relayCopyState({ id, relay });
  return { ...saved, migratedNames: Object.keys(env).sort(), relayRev: r.rev, oldCopy };
}

/** What can be said about the relay's old plaintext copy: { state: "present"|"present-relay-not-custody-aware"|"unknown", why } */
export async function relayCopyState({ id, relay }){
  let ex = null;
  try { ex = await relay.exists(id); } catch (e) { return { state: "unknown", why: "the relay did not answer: " + short(e) }; }
  if (!ex || ex.custody !== true)
    return { state: "present-relay-not-custody-aware", why: "the relay does not report this deployment as custody-held, so its plaintext copy cannot be deleted from here yet" };
  return { state: "present", why: "the relay still holds its old plaintext copy until you delete it" };
}

/**
 * Delete the relay's old plaintext copy - ONLY after the v2 bundle is on chain (re-read now) and the relay itself reports
 * the deployment custody-held. `relay.clear(id)` is the relay's owner-signed clear. Returns what is known afterwards; it
 * never claims more than the relay's answer: backups, logs or replicas the relay operator keeps are outside this page.
 */
export async function clearRelayCopyV2({ id, relay }){
  const v = await verified();
  id = lc(id);
  const st = await v.reader.readRelease({ id, endpoint: null });
  if (!st.policy.policyRev || !st.bundle.data.length)
    refuse("there is no v2 bundle for this deployment: the relay's copy is the only one, so it is not deleted", "no_v2_bundle");
  const ex = await relay.exists(id).catch(() => null);
  if (!ex || ex.custody !== true)
    refuse("the relay does not report this deployment as custody-held: its copy is kept (deleting it now could leave the app with no values)", "relay_not_custody_aware");
  const r = await relay.clear(id);
  return { state: "relay-reports-deleted", relayRev: r && r.rev, why: "the relay answered that its stored copy is deleted. Backups, logs or replicas outside the relay's live store are not verifiable from this page: rotate those credentials at their issuers" };
}

function sameBytes(a, b){
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
