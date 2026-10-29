// protected-authority-factory.mjs - the Windows node's PRODUCTION protected authority composition (permit r8, SOURCE ONLY, NOT RUN).
//
// CONSUMED BY THE NODE ENTRY: agent.mjs (after `new Host`) -> composeProtectedAuthority({ hostId: host.enclaveId }) -> sets
// protected-supervisor.mjs `composition` (hostId, openRuntime, collect). Before r8 nothing in production set these, so every enrolled
// deployment was held "protected authority unavailable". The chain is now:
//   node entry -> pinned authority config (absolute file + sha256, ENCLAVE_PROTECTED_AUTHORITY[_SHA256], this host only)
//   -> authentic READ-ONLY chain evidence: r18 createLifecycleChainAdapter (deployment-chain-adapter.mjs) constructed WITHOUT actorSigner,
//      approvals or relay, over r18 createLifecycleFinalitySnapshot (lifecycle-finality-bridge.mjs): the owner-selected derived-proof
//      anchor reader (hash-pinned self-contained module) + the local proof verifier + the OWNED anchor journal (rollback/contradiction
//      refused). The supervisor only ever sees readOnlyChainReader(adapter) = { read } - no signing/approval/transaction/relay/funding.
//   -> owned factory: r18 openOwnedHostRegistryLifecycle (lifecycle-host-owned-authority.mjs): parent journal flock + incarnation and
//      permit sidecars, the v2 DeploymentPermitGate and createIsolationLifecycleRuntime (candidate copies) bound to the
//      ProtectedIsolationClient adapters; its release() and lock-loss withdrawal are the physical owner lifecycle.
//   -> owner-selected witness collection: r18 createPermitCollector (deployment-permit-collector.mjs) with the host operator's PERMIT key.
//   -> supervisor/runtime/gate -> manager boundaries (unchanged consumers).
// Snapshot -> supervisor: protectedSnapshotOf() derives assignment.deployment from the authenticated snapshot id and
// assignment.proofVerified ONLY from the adapter's own verified/proofVerified AND tier 'l1-finalized-derived'; no request, envelope or
// caller boolean can set either. servingContextOf (deployment-host-authority.mjs) builds the v2 serving context. Independent Online is
// NOT vetoed by Enclave catalog/administrator signals (the independent profile's host-scoped admission only); canonical Offline evidence
// revokes; anything unverified or stale fences (supervisor #withdrawalOf), never an invented Offline.
// No mandatory Enclave endpoint, global administrator or catalog veto is configured or consulted here.
// The r18 dispatch cadence that openOwnedHostRegistryLifecycle composes is STOPPED immediately: this node never submits transitions
// (its adapter has no signer/relay), and the protected supervisor is the single driver of the runtime.
// QUALIFICATION: the r18 network modules are pinned external sources materialized into control/network by the release closure
// (RELEASE-CLOSURE-R8.json); until then the dynamic imports fail and every enrolled deployment is held (fail closed). Windows flock /
// owned-durable-state qualification is root-owned and pending; TEST fixtures prove source composition only.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { composition } from "./protected-supervisor.mjs";

export const AUTHORITY_SCHEMA = "enclave-protected-authority/1";
const H32 = /^0x[0-9a-f]{64}$/, SHA = /^[0-9a-f]{64}$/;
const KEYS = ["schema", "host", "journalFile", "parentImportSha256", "incarnationFile", "permitFile", "pins", "adapterPins", "witnesses",
  "operatorKeyFile", "finality", "hostPolicyDir", "platformWallets", "capacityHeadroom", "lock"];
/** method/field names that must never be reachable from the node's chain reader or its config */
export const FORBIDDEN = Object.freeze(["submit", "prepare", "sign", "signTransaction", "signTypedData", "sendTransaction", "send", "relay", "approve",
  "approvals", "actorSigner", "fund", "transfer", "withdraw", "deposit", "payee", "fundingKey", "enclaveEndpoint", "administrator", "catalogVeto"]);
const exact = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const abs = (f, what) => { if (!path.isAbsolute(String(f))) throw Error(`${what} must be an absolute path`); return f; };

/** hash-pinned JSON: { file, sha256 } -> parsed */
function pinnedJson(ref, what) {
  if (!exact(ref, ["file", "sha256"]) || !SHA.test(ref.sha256)) throw Error(`${what} must be { file, sha256 }`);
  const bytes = fs.readFileSync(abs(ref.file, what));
  if (bytes.length > 1 << 20 || sha256(bytes) !== ref.sha256) throw Error(`${what} hash differs`);
  return JSON.parse(bytes);
}

/** The owner's pinned authority config for THIS host. Exact keys; forbidden capabilities refused by name anywhere in it. */
export function loadAuthorityConfig(file, hash, { hostId }) {
  abs(file, "protected authority config");
  if (!SHA.test(String(hash))) throw Error("protected authority config needs its sha256");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 65536 || sha256(bytes) !== hash) throw Error("protected authority config hash differs");
  const c = JSON.parse(bytes);
  if (!exact(c, KEYS) || c.schema !== AUTHORITY_SCHEMA) throw Error("protected authority config has unknown or missing fields");
  const scan = (o, at) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (FORBIDDEN.includes(k)) throw Error(`protected authority config carries forbidden capability ${at}${k}`); scan(v, `${at}${k}.`); } };
  scan(c, "");
  if (!H32.test(c.host) || c.host !== hostId) throw Error(`protected authority config names host ${c.host}, this node's verified identity is ${hostId}`);
  for (const k of ["journalFile", "incarnationFile", "permitFile", "operatorKeyFile", "hostPolicyDir"]) abs(c[k], k);
  if (c.parentImportSha256 !== null && !SHA.test(String(c.parentImportSha256))) throw Error("parentImportSha256 must be null or a sha256");
  if (!exact(c.witnesses, ["endpoints", "timeoutMs"]) || !Array.isArray(c.witnesses.endpoints)) throw Error("witnesses must be { endpoints, timeoutMs }");
  if (!exact(c.finality, ["readerModule", "readerModuleSha256", "readerOptions", "verifier", "maxAnchorAgeSec"]) || !SHA.test(String(c.finality.readerModuleSha256)))
    throw Error("finality must name the owner-selected derived-proof reader module (absolute, sha256), its options, the verifier and maxAnchorAgeSec");
  abs(c.finality.readerModule, "finality.readerModule");
  if (!Array.isArray(c.platformWallets) || !(typeof c.capacityHeadroom === "number" && c.capacityHeadroom >= 0)) throw Error("platformWallets[] and capacityHeadroom required");
  if (!exact(c.lock, ["flockPath", "timeoutMs", "withdrawDeadlineMs"])) throw Error("lock must be { flockPath, timeoutMs, withdrawDeadlineMs }");
  const pins = pinnedJson(c.pins, "pins"), adapterPins = pinnedJson(c.adapterPins, "adapterPins");
  if (adapterPins.host !== c.host || pins.chainId !== 8453 || adapterPins.chainId !== 8453) throw Error("pins/adapterPins must be Base 8453 and this host");
  return Object.freeze({ ...c, pinsDoc: pins, adapterPinsDoc: adapterPins });
}

/** -> the ONLY chain capability the supervisor gets: authenticated read. Refuses an adapter object exposing nothing readable. */
export function readOnlyChainReader(adapter) {
  if (typeof adapter?.read !== "function") throw Error("chain reader needs an authenticated read");
  const reader = Object.freeze({ authorityKind: adapter.authorityKind, profile: adapter.profile, read: (id) => adapter.read(id) });
  for (const k of FORBIDDEN) if (k in reader) throw Error(`chain reader exposes ${k}`);
  return reader;
}

/**
 * Adapter snapshot -> the supervisor/runtime snapshot. proofVerified is TRUE only for the adapter's own verified+proofVerified flags at
 * the derived-finality tier; the deployment binding is the authenticated snapshot id. servingContext: servingContextOf (v2) when the
 * snapshot carries the authenticated assignment, else absent (the runtime refuses to serve without it).
 */
export function protectedSnapshotOf(pins, s, servingContextOf) {
  if (!s || !H32.test(String(s.id)) || !s.assignment || typeof s.assignment.state !== "string") throw Error("chain snapshot lacks an authenticated assignment");
  const qualified = s.verified === true && s.proofVerified === true && s.authorityTier === "l1-finalized-derived";
  const out = { ...s, assignment: { ...s.assignment, deployment: s.id, proofVerified: qualified } };
  if (qualified) { try { const sc = servingContextOf(pins, s); if (sc) out.servingContext = sc; } catch { /* no context: never served */ } }
  return out;
}

/** owner-selected derived-proof anchor reader: the EXACT hashed bytes are imported (self-contained module; no path re-read). */
async function loadAnchorReader({ readerModule, readerModuleSha256, readerOptions }) {
  const bytes = fs.readFileSync(readerModule);
  if (sha256(bytes) !== readerModuleSha256) throw Error("finality reader module hash differs");
  const m = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
  if (typeof m.createAnchorReader !== "function") throw Error("finality reader module must export createAnchorReader(options)");
  const readAnchor = await m.createAnchorReader(structuredClone(readerOptions));
  if (typeof readAnchor !== "function") throw Error("createAnchorReader must return readAnchor({ signal })");
  return readAnchor;
}

/**
 * The production composition. env: ENCLAVE_PROTECTED_ENROLLMENT (the supervisor's pinned enrollment) and
 * ENCLAVE_PROTECTED_AUTHORITY[_SHA256]. -> null (no enrollment: legacy everywhere, nothing composed) or { summary }.
 * With an enrollment but without an authority config, composition.hostId is still set (so held reasons are exact) and every enrolled
 * deployment is held. modules: injectable ONLY for labelled TEST composition of the same code path; production imports the pinned files.
 */
export async function composeProtectedAuthority({ hostId, env = process.env, log = () => {}, modules = null } = {}) {
  if (!String(env.ENCLAVE_PROTECTED_ENROLLMENT || "").trim()) return null;
  if (!H32.test(String(hostId))) throw Error("protected composition needs this node's verified host identity");
  composition.hostId = hostId;
  const file = String(env.ENCLAVE_PROTECTED_AUTHORITY || "").trim(), hash = String(env.ENCLAVE_PROTECTED_AUTHORITY_SHA256 || "").trim().toLowerCase();
  if (!file) return { summary: "enrollment present but no protected authority config: enrolled deployments held" };
  const cfg = loadAuthorityConfig(file, hash, { hostId });
  const m = modules ?? {
    owned: await import("../../network/lifecycle-host-owned-authority.mjs"),
    chain: await import("../../network/deployment-chain-adapter.mjs"),
    collector: await import("../../network/deployment-permit-collector.mjs"),
    finality: await import("../../network/lifecycle-finality-bridge.mjs"),
    hostAuthority: await import("../../network/deployment-host-authority.mjs"),
    accounts: await import("viem/accounts"),
  };
  if (!m.hostAuthority.isHostAuthorityPermit(cfg.pinsDoc)) throw Error("protected authority requires v2 host-authority serving permit pins");
  // the owned anchor journal is bound after the owned lifecycle opens; before that every finality read refuses
  let ownedJournal = null;
  const anchorJournal = {
    readAnchor: (c) => { if (!ownedJournal) throw Error("anchor journal not yet owned"); return ownedJournal.readAnchor(c); },
    acceptAnchor: (c, a) => { if (!ownedJournal) throw Error("anchor journal not yet owned"); return ownedJournal.acceptAnchor(c, a); },
  };
  const snapshotSource = m.finality.createLifecycleFinalitySnapshot({ readAnchor: await loadAnchorReader(cfg.finality), verifier: cfg.finality.verifier,
    maxAnchorAgeSec: cfg.finality.maxAnchorAgeSec, journal: anchorJournal });
  const refuse = (what) => async () => { throw Error(`${what}: not available to the read-only node chain reader`); };
  // NO actorSigner, approvals or relay: the adapter cannot submit a transition (submit refuses before any signing)
  const adapter = m.chain.createLifecycleChainAdapter({ pins: cfg.adapterPinsDoc, authority: { kind: "derived", snapshot: snapshotSource },
    receipts: { locate: refuse("receipt location"), header: refuse("receipt header"), block: refuse("receipt block") },
    hostPolicy: { load: async (policyHash) => { if (!H32.test(String(policyHash))) throw Error("host policy hash");
      const b = fs.readFileSync(path.join(cfg.hostPolicyDir, `${policyHash}.json`)); return JSON.parse(b); } } });
  const reader = readOnlyChainReader(adapter);
  const key = fs.readFileSync(cfg.operatorKeyFile, "utf8").trim();
  const account = m.accounts.privateKeyToAccount(/^0x/.test(key) ? key : `0x${key}`);
  if (String(account.address).toLowerCase() === String(cfg.adapterPinsDoc.payee ?? "").toLowerCase()) throw Error("the permit key must not be the payee/relay identity");
  const collect = m.collector.createPermitCollector({ pins: cfg.pinsDoc, account, endpoints: cfg.witnesses.endpoints, timeoutMs: cfg.witnesses.timeoutMs });
  let owned = null;
  composition.collect = collect;
  composition.openRuntime = async ({ host, bind }) => {
    if (host !== cfg.host) throw Error("supervisor host differs from the authority config host");
    if (owned) throw Error("the owned lifecycle is already open in this process: never a second owner");
    const ref = { gate: null }, early = new Map();
    const a = bind({ gate: { get entries() { return ref.gate ? ref.gate.entries : early; } }, pins: cfg.pinsDoc });
    owned = await m.owned.openOwnedHostRegistryLifecycle({ hostId: cfg.host, journalFile: cfg.journalFile, parentImportSha256: cfg.parentImportSha256 ?? undefined,
      incarnationFile: cfg.incarnationFile, permitFile: cfg.permitFile, pins: cfg.pinsDoc, adapter, adapterPins: cfg.adapterPinsDoc,
      client: a.client, plans: a.plans, readiness: a.readiness, boundaries: a.boundaries, collectPermit: a.collectPermit,
      platformWallets: cfg.platformWallets, capacityHeadroom: cfg.capacityHeadroom, verifyQuiescence: async () => false,
      flockPath: cfg.lock.flockPath, timeoutMs: cfg.lock.timeoutMs, withdrawDeadlineMs: cfg.lock.withdrawDeadlineMs });
    owned.dispatch?.stop?.();   // the supervisor is the single driver; this node never submits transitions
    ref.gate = owned.gate; ownedJournal = owned.journal;
    if (typeof ownedJournal?.readAnchor !== "function" || typeof ownedJournal?.acceptAnchor !== "function") {
      await owned.release("owned journal lacks the anchor journal interface"); throw Error("owned journal lacks readAnchor/acceptAnchor");
    }
    log(`owned protected lifecycle open for host ${cfg.host}`);
    return { runtime: owned.runtime, gate: owned.gate, pins: cfg.pinsDoc, release: (why) => owned.release(why),
      snapshot: async (id) => protectedSnapshotOf(cfg.pinsDoc, await reader.read(id), m.hostAuthority.servingContextOf) };
  };
  return { summary: `protected authority composed for host ${cfg.host} (read-only derived chain reader, owned r18 lifecycle on first reconcile)`,
    reader, release: (why = "node shutdown") => owned ? owned.release(why) : Promise.resolve({ released: true }) };
}
