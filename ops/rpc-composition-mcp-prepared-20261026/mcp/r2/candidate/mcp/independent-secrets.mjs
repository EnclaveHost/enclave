// set_secrets / get_secrets in independent mode: custody v2 with the owner read (docs/security/custody-owner-read.md),
// through the EXISTING owner-side helpers (custody/v2/owner-secrets.mjs readOwnerSecrets, planSecretsEdit,
// ownerEditUpdate). There is no relay copy and no new protocol.
//
// The division of authority stays as it is:
//   - the OWNER's wallet signs the committee's OwnerRead (EIP-712, the vault's domain) and sends the vault Update. An EOA
//     or a contract owner (ERC-1271) both work; custodians verify the signature at one agreed block.
//   - The server holds no owner key and never signs. The owner signer readOwnerSecrets is given is a SUSPENDED one: step 1
//     returns the exact typed data the helper asked to sign; step 2 delivers the wallet's signature and the helper goes on.
//   - The ephemeral recipient key is generated, used and zeroed INSIDE the helper. It never leaves this process.
//
// Which process may see values:
//   - local (stdio / loopback): this process IS the owner's own client, exactly like `enclave --independent … secrets`.
//     Values exist only in its memory and in the answer to the owner's agent, as the hosted get_secrets returned them.
//   - remote adapter: an untrusted intermediary with its OWN schema (remoteSchemas). It advertises no plaintext,
//     owner-read signature or readToken argument, and holds no recipient key. Its operations are:
//       * prepare  - public sealing inputs from the id alone. They are a HINT: the recipient is never taken from a remote
//                    answer. The owner's client reads the same facts from its own reviewed profile and quorum (the
//                    local set_secrets {id, action: "prepare"}), seals only to those, and refuses any difference;
//       * clear;
//       * write    - a bundle the owner's client sealed BEFORE sending (mcp/remote-secrets-client.mjs sealForRemote).
//                    The client checks the returned update field by field (verifyRemoteUpdate) before the owner signs.
//     Any other argument is refused with one static message, before anything is parsed, read, stored or forwarded.
//     The guarantee covers the supported client path. An arbitrary caller can always send bytes; they are refused
//     unread.
//
// The constraints are the ones the custody design imposes, never weakened here:
//   - the policy must opt in (ownerRead: true) for any read, merge or rm;
//   - paused releases nothing, owner reads included (replace and clear still write);
//   - after a ledger transfer only `custody claim` by the new owner;
//   - every edit is guarded by the exact revision it read (the vault's StaleRevision).
import { randomBytes } from "node:crypto";
import { encodeFunctionData, getAddress } from "viem";
import { currentScope, IndependentError } from "./independent.mjs";

const lc = (s) => String(s || "").toLowerCase();
const ZERO32 = "0x" + "00".repeat(32);
const ID = /^0x[0-9a-f]{64}$/;
const PENDING_MS = 115_000;   // within the helper's 120 s OwnerRead expiry and the custodians' 120 s challenge life
const short = (x) => x.slice(0, 10) + "…";

const handoff = (id, what) => ({
  local: `run the independent MCP server locally (stdio: node mcp/server.mjs --config FILE) as the owner's own client, or the CLI: enclave --independent … secrets ${what} ${id}`,
  why: "a remote adapter is not the owner's client: it holds no owner-read recipient key and accepts no plaintext value (its schema has no such argument)",
});

/** The pinned custody vault, judged at the call's block: book-bound (the production vault) or pinned-authority. */
async function custodyContext(B, id) {
  const { VAULT_V2_ABI, createChainReaderV2 } = await import("../custody/v2/chain.mjs");
  const { leaseReaderClients } = await import("../cli/independent.mjs");
  const trust = B.authority.trust, chain = B.authority.chain, s = currentScope();
  // custody v2 reads its own k-of-n reader (custody/v2/chain.mjs) and stays REFUSED under a verifier selection until custody v2
  // has its own separately qualified measurement: nothing is read, nothing is substituted
  if (chain.authority === "verifier")
    throw new IndependentError("custody", `profile ${B.authority.name} reads the chain through its local verifier: custody v2 secrets are not served under it (custody v2 stays refused until separately qualified); nothing was read`);
  const vault = lc(trust.pins.secretVaultV2);
  if (!/^0x[0-9a-f]{40}$/.test(vault) || /^0x0{40}$/.test(vault))
    throw new IndependentError("config", `profile ${B.authority.name} pins no secretVaultV2: custody v2 secrets are unavailable in this profile`);
  const b = await s.bindings();
  if (trust.profile?.contracts?.secretVaultV2) {
    const w = trust.profile.contracts.secretVaultV2;
    if (lc(w.address) !== vault) throw new IndependentError("bindings", "the pinned vault is not the reviewed profile's secretVaultV2");
    if ((await s.code(vault)) !== w.codeHash) throw new IndependentError("bindings", `secretVaultV2 at ${vault} does not carry the reviewed code; refusing`);
  }
  // book-bound: the vault reads the admin's AddressBook at each call - it must be the very book these bindings came from
  let kind = "book", book = null;
  try { book = lc(await B.read(vault, VAULT_V2_ABI, "book")); } catch (e) { if (!e.agreedRevert) throw e; kind = "pinned"; }
  if (kind === "book" && book !== lc(b.book)) throw new IndependentError("bindings", `the custody vault reads the address book ${book}, not the ${b.book} this profile's bindings resolve`);
  if (kind === "pinned") {
    for (const [fn, want] of [["deploymentLedger", b.deployments], ["hostRegistry", b.registry]])
      if (lc(await B.read(vault, VAULT_V2_ABI, fn)) !== lc(want)) throw new IndependentError("bindings", `the vault's ${fn} is not this profile's ${fn === "deploymentLedger" ? "ledger" : "registry"}`);
  }
  const clients = leaseReaderClients(chain);
  const reader = createChainReaderV2({ clients, vault, vaultKind: kind, ...(kind === "book" ? { book } : {}), chainId: chain.chainId,
    minAgree: Math.max(trust.quorum, Math.floor(clients.length / 2) + 1), confirmations: trust.confirmations,
    maxAgeSec: Math.round(trust.maxBlockAgeMs / 1000), timeoutMs: 15000 });
  const st = await reader.readRelease({ id, endpoint: null });
  const pol = st.policy;
  if (!pol || !pol.policyRev)
    throw new IndependentError("custody", `no custody v2 policy for ${short(id)}: the owner creates one first with their own rules and committee (enclave --independent … custody set ${id} … --rules FILE --committee 0x… --owner-read on)`);
  if (lc(st.beneficialOwner) !== lc(pol.owner))
    throw new IndependentError("custody", `the ledger moved this deployment (to ${st.beneficialOwner}): the new owner runs \`custody claim\` first, which destroys the previous owner's bundle; no one reads the old values`);
  const { policyRulesOf } = await import("../custody/v2/owner-secrets.mjs");
  let ownerRead = false; try { ownerRead = policyRulesOf(pol.rules).ownerRead; } catch {}
  return { vault, kind, book, st, pol, ownerRead };
}

const updateTx = async (vault, id, update, describe) => {
  const { UPDATE_V2_ABI } = await import("../custody/v2/owner.mjs");
  const { unsignedTx } = await import("../relay/mcp.js");
  return unsignedTx(getAddress(vault), encodeFunctionData({ abi: UPDATE_V2_ABI, functionName: "update", args: [id, update] }), 0n, describe);
};
const clearUpdate = (policyRev) => ({ expectPolicyRev: BigInt(policyRev), setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: false, bundle: "0x", clear: true });

/**
 * The config a REPLACE commits its values to (custody/protocol.mjs configSha256: the guest puts a value into no other
 * config). With no read there is no current bundle to take it from, so it comes from on-chain authority at this call's
 * block, in this order:
 *   1. the caller's explicit configText;
 *   2. the deployment's own options envelope;
 *   3. its catalog version's INLINE config, the same effective-config rule get_config applies.
 * A version whose config is at a CID needs configText: the server never takes a gateway's word for those bytes.
 */
async function replaceConfig(B, api, id, explicit) {
  const { configTextFromEnvelope, configTextOf } = await import("../custody/protocol.mjs");
  if (explicit !== undefined) { configTextOf(explicit === "" ? "" : String(explicit)); return { configText: explicit === "" ? "" : configTextOf(String(explicit)), configFrom: "named by the caller (configText)" }; }
  const d = await api.depGet(id);
  try { return { configText: configTextFromEnvelope(String(d.configCid || "")), configFrom: "the deployment's own options envelope (on chain)" }; }
  catch (e) {
    if (!/catalog version/.test(e.message)) throw new IndependentError("config", `${e.message}; pass configText (the exact config JSON, "" for none)`);
  }
  const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d{1,9})$/.exec(String(d.appRef || ""));
  if (!m) throw new IndependentError("config", `${short(id)} runs ${d.appRef}, not a catalog version: pass configText (the exact config JSON, "" for none)`);
  const v = (await api.readVersions(m[1], Number(m[2]) + 1))[Number(m[2])];
  if (!v) throw new IndependentError("config", "the catalog does not list this deployment's version: pass configText");
  if (v.configCid) throw new IndependentError("config", `this version keeps its config at ipfs://${v.configCid}: pass configText (the exact JSON it holds)`);
  return { configText: configTextOf(v.config || ""), configFrom: "the catalog version record (on chain, quorum-agreed at this call's block)" };
}

/** The public facts a whole-map seal is bound to (custody/v2/protocol.mjs labelOf + the committee key), as read. */
const sealingFacts = (B, { vault, st, pol }, id) => {
  if (/^0x0{64}$/.test(lc(pol.committeeId)) || !st.committee) throw new IndependentError("custody", `${short(id)}'s policy names no committee: nothing can be sealed to it`);
  return { chainId: B.authority.chain.chainId, vault, id, committeeId: lc(pol.committeeId), committeeY: "0x" + Buffer.from(st.committee.Y).toString("hex"),
    nextSecretRev: String(pol.secretRev + 1n), expectPolicyRev: String(pol.policyRev), owner: getAddress(pol.owner) };
};
/** The config commitment, or null with the reason (the owner's client then names configText/configSha256 itself). */
async function configFacts(B, api, id, configText) {
  try { const { configSha256 } = await import("../custody/protocol.mjs"); const c = await replaceConfig(B, api, id, configText); return { configSha256: configSha256(c.configText), configFrom: c.configFrom }; }
  catch (e) { return { configSha256: null, note: `${e.message} - the owner's client computes configSha256 of the exact config itself` }; }
}

/** The two tools, with this server's own table of suspended reads (one per in-flight owner signature). */
export function secretsOverrides({ remote = false } = {}) {
  if (remote) return remoteSecretsOverrides();
  const pending = new Map();
  const sweep = () => { const t = Date.now(); for (const [k, p] of pending) if (p.until < t) { pending.delete(k); p.cancel(new Error("the owner's signature did not arrive in time")); } };

  /** step 1: start readOwnerSecrets with a suspended owner signer; return the typed data it asked the owner to sign. */
  async function beginRead(B, ctx, id, purpose) {
    const { readOwnerSecrets, custodianPost } = await import("../custody/v2/owner-secrets.mjs");
    const { vault, st, pol, ownerRead } = ctx;
    if (!ownerRead) throw new IndependentError("custody", `this policy's rules do not allow an owner read (ownerRead is not true): reading, merging and removing keys need the owner's explicit opt-in (enclave --independent … custody set ${id} … --owner-read on); a replace (payload.clear with set) or a clear needs no read`);
    if (pol.paused) throw new IndependentError("custody", "the policy is paused: custodians release nothing, owner reads included (resume first; a replace or clear still writes)");
    sweep();
    let asked, sign;
    const askedP = new Promise((ok) => { asked = ok; });
    const sigP = new Promise((ok, no) => { sign = { ok, no }; });
    const token = randomBytes(24).toString("base64url");
    const result = readOwnerSecrets({ chainId: B.authority.chain.chainId, vault, id, state: st, post: custodianPost(),
      owner: { address: lc(pol.owner), signTypedData: (td) => { asked(td); return sigP; } } });
    result.catch(() => {});
    const first = await Promise.race([askedP.then((td) => ({ td })), result.then(() => ({ done: true }), (e) => ({ error: e }))]);
    if (first.error) throw new IndependentError("custody", first.error.message);
    if (!first.td) throw new IndependentError("custody", "internal: the owner read finished without a signature");
    pending.set(token, { id, purpose, owner: lc(pol.owner), policyRev: pol.policyRev, result, sign, until: Date.now() + PENDING_MS, ctx,
      cancel: (e) => sign.no(e) });
    return { prepared: true, readToken: token, owner: getAddress(pol.owner), typedData: first.td, expiresInSec: Math.floor(PENDING_MS / 1000),
      next: `the policy owner ${getAddress(pol.owner)} signs typedData (eth_signTypedData_v4; a contract owner through its ERC-1271 signer), then call ${purpose === "get" ? "get_secrets" : "set_secrets"} again with the same arguments plus readToken and signature, within ${Math.floor(PENDING_MS / 1000)} s` };
  }
  /** step 2: deliver the owner's signature; the helper collects and verifies the partials and opens the bundle here. */
  async function finishRead(id, purpose, a) {
    sweep();
    const p = pending.get(String(a.readToken || ""));
    if (!p || p.id !== id || p.purpose !== purpose) throw new IndependentError("custody", "unknown or expired readToken for this deployment: start again without readToken");
    pending.delete(String(a.readToken));
    if (!/^0x[0-9a-fA-F]+$/.test(String(a.signature || ""))) { p.cancel(new Error("no signature")); throw new IndependentError("signature", "signature: the owner's 0x… typed-data signature"); }
    p.sign.ok(String(a.signature));
    try { return { read: await p.result, ctx: p.ctx }; }
    catch (e) { throw new IndependentError("custody", e.message); }
  }
  const hostedSig = (a) => a.signature !== undefined && !a.readToken && !a.sealedBundle;
  const HOSTED = "that signature is the hosted relay's `enclave-secrets:…` message: independent mode has no relay copy. Call without signature for the owner-read typed data the committee checks";

  return {
    get_secrets: async (B, a) => {
      const id = lc(a.id);
      if (!ID.test(id)) throw new IndependentError("id", "independent secrets need the full bytes32 deployment id");
      const ctx = await custodyContext(B, id);
      if (hostedSig(a)) throw new IndependentError("signature", HOSTED);
      if (!a.readToken) {
        if (!ctx.st.bundle.data.length) return { id, names: [], env: {}, secretRev: String(ctx.pol.secretRev), note: "no secrets are stored for this deployment" };
        return beginRead(B, ctx, id, "get");
      }
      const { read } = await finishRead(id, "get", a);
      return { id, names: read.names, env: read.env, policyRev: String(read.policyRev), secretRev: String(read.secretRev), answered: read.answered,
        note: "read through the committee's owner read: values exist only in this local client and in this answer" };
    },
    set_secrets: async (B, a, _ctx, api) => {
      const id = lc(a.id);
      if (!ID.test(id)) throw new IndependentError("id", "independent secrets need the full bytes32 deployment id");
      const { planSecretsEdit, ownerEditUpdate } = await import("../custody/v2/owner-secrets.mjs");
      const { configTextFromEnvelope, configSha256, checkEnv } = await import("../custody/protocol.mjs");
      const ctx = await custodyContext(B, id), { vault, st, pol } = ctx;
      // prepare: the sealing facts THIS client reads from its own reviewed profile and RPC quorum, at one agreed block. A
      // client of a remote adapter seals only to these, never to a remote answer (mcp/remote-secrets-client.mjs).
      if (a.action !== undefined) {
        if (a.action !== "prepare") throw new IndependentError("args", "set_secrets action: \"prepare\" (this client's own sealing facts) or none");
        return { id, local: true, sealing: { ...sealingFacts(B, ctx, id), ...(await configFacts(B, api, id, a.configText)) },
          next: "seal with these facts only (mcp/remote-secrets-client.mjs sealForRemote(remoteAnswer, env, { expected })): a remote adapter's answer is a hint compared field by field" };
      }
      // a client-sealed bundle (remote and local): the server sees only ciphertext
      if (a.sealedBundle !== undefined) {
        const v2 = await import("../custody/v2/protocol.mjs");
        const hex = String(a.sealedBundle);
        if (!/^0x([0-9a-f]{2})+$/.test(hex)) throw new IndependentError("bundle", "sealedBundle: 0x-hex ciphertext");
        try { v2.parseBundle(Buffer.from(hex.slice(2), "hex")); } catch (e) { throw new IndependentError("bundle", `sealedBundle is not a custody v2 bundle: ${e.message}`); }
        const update = { expectPolicyRev: BigInt(pol.policyRev), setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: true, bundle: hex, clear: false };
        return { id, transactions: [await updateTx(vault, id, update, `EnclaveSecretVaultV2.update(${short(id)}, client-sealed bundle)`)],
          expect: { secretRev: String(pol.secretRev + 1n) }, next: `sign+send with the policy owner ${getAddress(pol.owner)}; the vault refuses it if anyone wrote since revision ${pol.policyRev}` };
      }
      if (hostedSig(a)) throw new IndependentError("signature", HOSTED);
      let payload;
      try { payload = JSON.parse(String(a.payload)); } catch { throw new IndependentError("payload", "payload must be the JSON string {set?, del?, clear?}"); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some((k) => !["set", "del", "clear"].includes(k)))
        throw new IndependentError("payload", "payload: {set?: {NAME: value}, del?: [NAME], clear?: boolean}");
      const set = payload.set || {}, del = payload.del || [], clear = payload.clear === true;
      if (typeof set !== "object" || Array.isArray(set) || Object.values(set).some((v) => typeof v !== "string") || !Array.isArray(del))
        throw new IndependentError("payload", "payload.set is {NAME: string}, payload.del is [NAME]");
      if (Object.keys(set).length) checkEnv(set);
      const describe = (n) => `EnclaveSecretVaultV2.update(${short(id)}, ${n})`;
      const done = (update, expect, what) => updateTx(vault, id, update, describe(what)).then((t) => ({ id, transactions: [t],
        expect: { secretRev: String(expect.secretRev) }, unchanged: "rules, committee and pause are untouched (setPolicy false)",
        next: `sign+send with the policy owner ${getAddress(pol.owner)} (an EOA, or the owner contract itself). The vault refuses it if anyone wrote since revision ${pol.policyRev}: nothing is lost, read again. A running app picks the values up at its next start (restart_deployment).` }));
      // clear: no read, no plaintext
      if (clear && !Object.keys(set).length) {
        if (del.length) throw new IndependentError("payload", "clear removes everything: del is meaningless with it");
        if (!st.bundle.data.length) return { id, note: "nothing stored: already clear", transactions: [] };
        return done(clearUpdate(pol.policyRev), { secretRev: pol.secretRev + 1n }, "clear");
      }
      // replace (clear + set): the whole map, no read; the config commitment is the deployment's own envelope, as the CLI does
      if (clear) {
        const env = planSecretsEdit({ op: "replace", pairs: set });
        const read0 = { policyRev: pol.policyRev, secretRev: pol.secretRev, committeeId: pol.committeeId };
        const { configText, configFrom } = await replaceConfig(B, api, id, a.configText);
        const { update, expect } = ownerEditUpdate({ chainId: B.authority.chain.chainId, vault, id, read: read0, committee: st.committee, env,
          configSha256: configSha256(configText) });
        return { ...(await done(update, expect, `replace: ${Object.keys(env).sort().join(", ")}`)), configFrom };
      }
      // merge / remove keys: the owner read first (two steps), then the edit under that exact revision
      if (!a.readToken) return { ...(await beginRead(B, ctx, id, "set")), plan: { set: Object.keys(set).sort(), del } };
      const { read, ctx: readCtx } = await finishRead(id, "set", a);
      let env = Object.keys(set).length ? planSecretsEdit({ op: "set", current: read.env, pairs: set }) : { ...read.env };
      if (del.length) env = planSecretsEdit({ op: "rm", current: env, keys: del });
      // the committee the values were READ under (the helper refuses any other)
      const { update, expect } = ownerEditUpdate({ chainId: B.authority.chain.chainId, vault, id, read, committee: readCtx.st.committee, env, configSha256: read.configSha256 });
      return { ...(await done(update, expect, `${Object.keys(env).length} value(s): ${Object.keys(env).sort().join(", ")}`)), names: Object.keys(env).sort() };
    },
  };
}

export const secretsExtend = {
  get_secrets: { properties: { readToken: { type: "string", description: "Independent mode, step 2: the readToken from step 1" } }, relaxRequired: ["expiry", "signature"],
    description: "Independent mode: custody v2 owner read (the policy must opt in with ownerRead). Step 1 returns the OwnerRead typed data the policy owner signs; step 2 (readToken + signature) returns the values." },
  set_secrets: { properties: { readToken: { type: "string", description: "Independent mode, step 2 of a merge/remove: the readToken from step 1" },
    sealedBundle: { type: "string", description: "Independent mode: a custody v2 bundle the CLIENT sealed to the committee key" },
    action: { type: "string", enum: ["prepare"], description: "Independent mode: \"prepare\" returns this client's own sealing facts (committee key, label fields, revisions, config commitment) from its reviewed profile and quorum; nothing is written" },
    configText: { type: "string", description: "Independent mode, replace: the exact config JSON the values go into (\"\" for none); default: the deployment's envelope, else its catalog version's inline config" } },
    relaxRequired: ["expiry", "signature", "payload"],   // payload, unless sealedBundle or action names the operation
    description: "Independent mode: custody v2. clear and replace (clear:true with set) need no read; set/del merge after the owner read (two steps). Returns the vault update for the policy owner to send." },
};

// ---- the remote adapter: its own schema, ciphertext only ---------------------------------------------------------------
const REMOTE_ARGS = Object.freeze({ get_secrets: ["id", "action"], set_secrets: ["id", "action", "sealedBundle", "expectPolicyRev"] });
// ONE static message: it never names, quotes or measures what was sent
const NO_PLAINTEXT = "this remote adapter accepts no plaintext values, payloads, owner-read signatures or read tokens: nothing in this request "
  + "was read, stored or forwarded. Use set_secrets {id, action: \"prepare\"}, seal on the owner's own machine "
  + "(mcp/remote-secrets-client.mjs sealForRemote), then set_secrets {id, action: \"write\", sealedBundle, expectPolicyRev}; "
  + "reads and merges run in the owner's own local client";
const remoteOnly = (name, a) => {
  if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((k) => !REMOTE_ARGS[name].includes(k))) throw new IndependentError("plaintext", NO_PLAINTEXT);
};
export const remoteSchemas = Object.freeze({
  get_secrets: { strict: NO_PLAINTEXT, description: "Remote adapter (independent): custody v2 secrets are READ only by the owner's own client (the local MCP server or `enclave --independent … secrets ls`), never here. action \"prepare\" returns the policy facts and that handoff. No secret value is ever accepted or returned by this adapter.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "action"],
      properties: { id: { type: "string", description: "Deployment id: full bytes32" }, action: { type: "string", enum: ["prepare"] } } } },
  set_secrets: { strict: NO_PLAINTEXT, description: "Remote adapter (independent): ciphertext only. action \"prepare\" returns the PUBLIC sealing inputs (committee key, label fields, next revision, config commitment) from the id alone; the owner's own machine seals the whole map (mcp/remote-secrets-client.mjs sealForRemote) and sends action \"write\" with sealedBundle and expectPolicyRev. action \"clear\" removes every value. Each returns the vault update the policy owner sends. Merges and per-key edits need the owner read and run in the owner's own local client.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "action"],
      properties: { id: { type: "string", description: "Deployment id: full bytes32" }, action: { type: "string", enum: ["prepare", "clear", "write"] },
        sealedBundle: { type: "string", description: "write: the 0x-hex custody v2 bundle sealed on the owner's machine" },
        expectPolicyRev: { type: "string", description: "write: the expectPolicyRev from prepare (the vault refuses any other)" } } } },
});

function remoteSecretsOverrides() {
  return {
    get_secrets: async (B, a) => {
      remoteOnly("get_secrets", a);
      const id = lc(a.id);
      if (!ID.test(id) || a.action !== "prepare") throw new IndependentError("args", "get_secrets on a remote adapter: {id: full bytes32, action: \"prepare\"}");
      const ctx = await custodyContext(B, id);
      return { handoff: true, id, ...handoff(id, "ls --show"), policy: { owner: getAddress(ctx.pol.owner), ownerRead: ctx.ownerRead, paused: ctx.pol.paused,
        policyRev: String(ctx.pol.policyRev), secretRev: String(ctx.pol.secretRev), stored: ctx.st.bundle.data.length > 0 } };
    },
    set_secrets: async (B, a, _ctx, api) => {
      remoteOnly("set_secrets", a);
      const id = lc(a.id);
      if (!ID.test(id) || !["prepare", "clear", "write"].includes(a.action)) throw new IndependentError("args", "set_secrets on a remote adapter: {id: full bytes32, action: prepare | clear | write}");
      const { vault, st, pol } = await custodyContext(B, id);
      const describe = (n) => `EnclaveSecretVaultV2.update(${short(id)}, ${n})`;
      const next = `sign+send with the policy owner ${getAddress(pol.owner)}; the vault refuses it if anyone wrote since revision ${pol.policyRev}`;
      if (a.action === "prepare") {
        // public facts only, and only a HINT to the client: the committee's public key, the label fields, the revision
        // guard and the PUBLIC config commitment. The client compares them with its own quorum read and seals to that.
        return { id, sealing: { ...sealingFacts(B, { vault, st, pol }, id), ...(await configFacts(B, api, id, undefined)) },
          next: "this answer is a hint: the owner's client reads the same facts from its own profile and quorum (local set_secrets {id, action: \"prepare\"}), seals the WHOLE map to those (mcp/remote-secrets-client.mjs sealForRemote(answer, env, { expected })) and checks the returned update (verifyRemoteUpdate) before the owner signs. To change only some keys, use the owner's own local client" };
      }
      if (a.action === "clear") {
        if (!st.bundle.data.length) return { id, note: "nothing stored: already clear", transactions: [] };
        return { id, transactions: [await updateTx(vault, id, clearUpdate(pol.policyRev), describe("clear"))], expect: { secretRev: String(pol.secretRev + 1n) }, next };
      }
      const hex = String(a.sealedBundle || "");
      if (!/^0x([0-9a-f]{2})+$/.test(hex)) throw new IndependentError("bundle", "write needs sealedBundle: 0x-hex ciphertext");
      if (String(a.expectPolicyRev) !== String(pol.policyRev)) throw new IndependentError("stale", `the policy is at revision ${pol.policyRev}, not ${String(a.expectPolicyRev).slice(0, 20)}: prepare and seal again`);
      const v2 = await import("../custody/v2/protocol.mjs");
      try { v2.parseBundle(Buffer.from(hex.slice(2), "hex")); } catch { throw new IndependentError("bundle", "sealedBundle is not a custody v2 bundle"); }
      const update = { expectPolicyRev: BigInt(pol.policyRev), setPolicy: false, committeeId: ZERO32, paused: false, rules: "0x", setBundle: true, bundle: hex, clear: false };
      return { id, transactions: [await updateTx(vault, id, update, describe("client-sealed bundle"))], expect: { secretRev: String(pol.secretRev + 1n) }, next };
    },
  };
}
