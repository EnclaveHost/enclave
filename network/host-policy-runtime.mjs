// One runtime for every non-custody enforcement point (relay discovery/dial/tunnels, DNS fleet, supervisor, Windows host,
// management client, CLI): a platform host policy gate (network/platform-host-policy.mjs) over a majority-agreement
// snapshot, the published mirrors, an optional persisted state, and the ACTIVATION rule
// (network/platform-host-policy-config.mjs):
//   activation "anchor"   the book anchors nothing yet -> "not-activated": admit (today's behavior), reported as such
//   activation "required" the book anchors nothing -> refuse
// A torn/malformed anchor, a node behind the anchor, an unreadable chain: refuse (never an admit). Off (null) only when the
// resolved configuration says so.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from "viem";
import { createQuorumReader, checkRpcUrls } from "../custody/v2/quorum.mjs";
import { createPlatformHostGate, readPolicyFacts, decodeAnchor } from "./platform-host-policy.mjs";
import { httpPolicyMirrors, validateMirrors } from "./host-policy-mirrors.mjs";
import { hostAdmissions, measuredHostGate } from "./host-policy-adapters.mjs";
import { resolveHostPolicyConfig } from "./platform-host-policy-config.mjs";
export { resolveHostPolicyConfig } from "./platform-host-policy-config.mjs";

const lc = (s) => String(s || "").toLowerCase();
const NOT_ACTIVATED = Object.freeze({ admit: true, status: "not-activated", reason: "the platform host policy is not activated (the admin has anchored no policy)" });

/** Back-compatible parse of a raw config value (JSON or object) without the production default. */
export function parseHostPolicyConfig(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const r = resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: typeof raw === "string" ? raw : JSON.stringify(raw) } });
  if (!r.on) return null;
  return Object.freeze({ ...r.config, mirrors: validateMirrors(r.config.mirrors) });
}
/** A JSON file store for the gate's accepted policy (and the measured gate's admission state). */
export function fileStore(file) {
  return { load: () => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } },
           save: (v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + ".tmp"; fs.writeFileSync(tmp, v, { mode: 0o600 }); fs.renameSync(tmp, file); } };
}
/** viem clients' quorum -> the gate's snapshot(fn) with call/code bound to one agreed block */
export function quorumSnapshot({ rpcs, minAgree = null, clients = null, maxAgeSec = 120 }) {
  if (!clients) checkRpcUrls(rpcs);
  const cs = clients || rpcs.map((u) => createPublicClient({ transport: http(u, { timeout: 10_000, retryCount: 0 }) }));
  const agreed = createQuorumReader({ clients: cs, minAgree: minAgree ?? Math.floor(cs.length / 2) + 1, maxAgeSec });
  return (fn) => agreed((c, b) => fn({ block: b.blockNumber,
    call: async (address, abi, functionName, args = []) => decodeFunctionResult({ abi, functionName,
      data: await c.request({ method: "eth_call", params: [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, { blockHash: b.blockHash, requireCanonical: true }] }) }),
    code: (a) => c.request({ method: "eth_getCode", params: [a, { blockHash: b.blockHash, requireCanonical: true }] }) }));
}
/** A viem client snapshot (e.g. the CLI's INDEPENDENT.chain.snapshot((client, blockNumber) => ...)) -> the gate's snapshot */
export const clientSnapshot = (snap) => (fn) => snap((client, blockNumber) => fn({ block: blockNumber,
  call: (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber }),
  code: (address) => client.getCode({ address, blockNumber }).then((c) => c || "0x") }));

/**
 * resolved: resolveHostPolicyConfig(...) result, or a config object. Returns null when off, else
 * { config, activation, gate, admissions(ids), decideOperators(ops), measured(hostId, opts), status() }.
 * snapshot: an injected agreed-block snapshot; otherwise rpcs/clients (default: config.rpcs) build one.
 */
export function createHostPolicyRuntime(resolved, { rpcs = null, minAgree = null, clients = null, snapshot = null, store = null,
  fetch = globalThis.fetch, log = () => {}, ttlMs = 30_000 } = {}) {
  if (resolved === null || resolved === undefined || resolved === "") return null;
  let cfg;
  if (typeof resolved === "string") cfg = parseHostPolicyConfig(resolved);
  else if (resolved.on === false) return null;
  else cfg = resolved.on === true ? resolved.config : resolved;
  if (!cfg) return null;
  const activation = cfg.activation || "anchor";
  const snap = snapshot || quorumSnapshot({ rpcs: rpcs || cfg.rpcs, minAgree: minAgree ?? cfg.minAgree ?? null, clients });
  const mirrors = cfg.mirrors && cfg.mirrors.length ? httpPolicyMirrors(cfg.mirrors, { fetch }) : [];
  if (!mirrors.length) log("[host-policy] WARNING: no policy mirror configured - an anchored policy cannot be loaded and will refuse every host");
  const core = createPlatformHostGate({ book: cfg.book, hostOwnership: cfg.hostOwnership, snapshot: snap, mirrors, store, log });
  let last = { state: "unchecked" };
  const anchorState = (facts) => { try { return decodeAnchor(facts.anchorHi, facts.anchorLo).state; } catch { return "torn"; } };
  // decide(): the core decision, except that an UNANCHORED book under activation "anchor" means not activated (every
  // host, including unregistered/inactive ones, is treated as today); a torn anchor refuses everything.
  async function decide({ registryIds = [] } = {}) {
    // ONE snapshot: anchor, current book owner (+ its ERC-1271 answer for the accepted policy) and host rows
    const facts = await snap(async (at) => ({ ...(await readPolicyFacts(at, { book: cfg.book, hostOwnership: cfg.hostOwnership, registryIds, check1271: core.currentAuthorityChecks() })), block: at.block ?? null }));
    const a = anchorState(facts), decisions = {};
    last = { state: a, block: facts.block, at: Date.now() };
    for (const id of registryIds.map(lc)) {
      const h = facts.hosts[id];
      if (a === "unanchored" && activation === "anchor") { decisions[id] = { ...NOT_ACTIVATED, host: h }; continue; }
      decisions[id] = { ...(h?.active ? core.decideHost(h, facts) : { admit: false, status: "inactive", reason: "host registry entry is not active" }), host: h };
    }
    return { block: facts.block, anchor: a, decisions };
  }
  async function decideOperators(operators = []) {
    const facts = await snap(async (at) => readPolicyFacts(at, { book: cfg.book, hostOwnership: cfg.hostOwnership, check1271: core.currentAuthorityChecks() }));
    const a = anchorState(facts);
    return Object.fromEntries(operators.map((o) => [lc(o), a === "unanchored" && activation === "anchor" ? { ...NOT_ACTIVATED } : core.decideHost({ operator: lc(o) }, facts)]));
  }
  async function refresh() {
    try { return await core.refresh(); }
    catch (e) { if (e.code === "unanchored" && activation === "anchor") return null; throw e; }
  }
  const gate = { refresh, decide, decideOperators, decideHost: core.decideHost, currentAuthorityChecks: core.currentAuthorityChecks, accepted: core.accepted, problems: core.problems };
  return { config: cfg, activation, gate, admissions: hostAdmissions(gate, { ttlMs }), decideOperators,
           measured: (hostId, o = {}) => measuredHostGate({ gate, hostId, log, ...o }),
           status: () => ({ activation, anchor: last.state, block: last.block ? String(last.block) : null,
                            accepted: core.accepted() ? { sequence: core.accepted().policy.sequence, digest: core.accepted().digest } : null, problems: core.problems() }) };
}
