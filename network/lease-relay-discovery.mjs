// Designated lease relays, found from the pinned EnclaveServiceIndex (network/service-index.mjs) by a compute host that
// has no relay of its own and no ETH: the host's claim, renewal and release are submitted by a relay a DESIGNATED relay
// operator runs on an Enclave host (network/host-services/lease-relay-host.mjs), funded with that operator's capped
// float and reimbursed by each app's reserve in the same transaction. The compute host pays nothing and holds no float.
//
// What a relay must prove before a host signs a lease to it (each step refuses that endpoint, never the operation):
//   1. it is ADVERTISED: a `relay` ad in the index, read at ONE block on which two of the host's own RPCs agree, from the
//      contract whose runtime code hash the host pinned - an untrusted candidate, nothing more;
//   2. when this host's platform host policy is on, its operator is EXPLICITLY ADMITTED by it now (judgeRelayOperators:
//      admit === true, which includes the deliberate "not-activated" admit before the administrator anchors a policy;
//      a ban, an allowlist miss, "behind", an unreadable authority, a missing decision or a decider that throws all
//      refuse). Discovery metadata is untrusted, so unlike applyHostPolicy (which keeps undecided directory candidates)
//      nothing undecided is ever paid. Policy off is the host's explicit configuration, never a fallback;
//   3. its endpoint is OUTSIDE every failure domain the host names (e.g. the DigitalOcean fleet's addresses): an address
//      in it, a name in it, a name that resolves into it, and a name that does not resolve are all excluded, and named;
//   4. its DESCRIPTOR (GET /v1/descriptor) is exactly the bytes the ad committed to (sha256), names that operator, the
//      `relay` kind, this deployment's chain and reserve, and a payee address;
//   5. its STATEMENT (GET /v1/info) is signed by that payee key over this chain, reserve and executor, fresh
//      (verifyRelayStatement) - the endpoint answers AS the advertised relay, over https or plain http alike.
// None of this trusts the relay with anything: the lease client still verifies every landed lease on the host's own RPC
// quorum, a relay can only fail or refuse, and its reimbursement is bounded by the lease's signed maximum.
// The ENDPOINT list may be cached (cachedRelayDiscovery); operator AUTHORITY never is: the lease client re-judges the
// relay's operator under the current policy (relayAdmission) immediately before every signature.
import dns from "node:dns/promises";
import { getAddress, isAddress } from "viem";
import { readServiceIndex, verifyDescriptor } from "./service-index.mjs";
import { operatorDecider } from "./host-policy-adapters.mjs";
import { verifyRelayStatement } from "./lease-executor-client.mjs";

export const RELAY_DESCRIPTOR_FORMAT = "enclave-service-descriptor/v1";
const lc = (s) => String(s || "").toLowerCase();
const isV4 = (h) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);

/** The descriptor a designated relay publishes (its ad commits to sha256 of these exact bytes). */
export function relayDescriptor({ operator, payee, chainId, reserve, packagePin = null, bundleSha256 = null }) {
  if (!isAddress(String(operator)) || !isAddress(String(payee)) || !isAddress(String(reserve)) || !Number.isSafeInteger(chainId)) throw new Error("relay descriptor: operator, payee, chainId and reserve required");
  return Buffer.from(JSON.stringify({ format: RELAY_DESCRIPTOR_FORMAT, operator: lc(operator), kind: "relay", role: "lease-relay", payee: lc(payee),
    chainId, reserve: lc(reserve), ...(packagePin ? { package: packagePin } : {}), ...(bundleSha256 ? { bundleSha256 } : {}) }));
}

/** The same failure-domain rule as network/cold-bootstrap.mjs classifyEndpoint (work/hosted-service-placement). */
export async function classifyEndpoint(endpoint, failureDomains, resolve) {
  const h = new URL(endpoint).hostname.toLowerCase();
  for (const d of failureDomains) if ((d.names || []).some((n) => h === n || h.endsWith("." + n))) return { excluded: true, domain: d.name, reason: `name ${h} is in ${d.name}` };
  let addresses = [h];
  if (!isV4(h)) {
    try { addresses = await resolve(h); } catch (e) { return { excluded: true, domain: "unknown", reason: `name ${h} did not resolve (${e.message})` }; }
    if (!Array.isArray(addresses) || !addresses.length) return { excluded: true, domain: "unknown", reason: `name ${h} resolved to nothing` };
  }
  for (const d of failureDomains) {
    const hit = addresses.find((a) => (d.addresses || []).includes(a));
    if (hit) return { excluded: true, domain: d.name, reason: `${h === hit ? "address" : `${h} -> ${hit}`} is in ${d.name}` };
  }
  return { excluded: false, addresses };
}
const defaultResolve = async (name) => (await dns.lookup(name, { all: true, family: 4 })).map((a) => a.address);

async function boundedGet(fetchImpl, url, timeoutMs, maxBytes) {
  const r = await fetchImpl(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
  if (r.status !== 200) throw new Error(`${url}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > maxBytes) throw new Error(`${url}: answer larger than ${maxBytes} bytes`);
  return b;
}

/**
 * The STRICT relay rule over an operator decider (decide(operators) -> { [operator]: { admit, status, reason } }): only
 * `admit === true` admits. -> { admitted: Set<lowercase operator>, refused: [{ operator, status, reason }], unreadable }.
 * A decider that throws refuses every operator (unreadable: true) - a policy that is on but unusable pays no relay.
 */
export async function judgeRelayOperators(operators, decide) {
  const ops = [...new Set(operators.map(lc))], admitted = new Set(), refused = [];
  let d;
  try { d = ops.length ? await decide(ops) : {}; }
  catch (e) {
    const reason = `platform host policy unreadable: ${String(e?.message || e).slice(0, 160)}`;
    return { admitted, refused: ops.map((operator) => ({ operator, status: "unreadable", reason })), unreadable: true };
  }
  for (const o of ops) {
    const x = d && typeof d === "object" ? d[o] : undefined;
    if (x && x.admit === true) admitted.add(o);
    else refused.push({ operator: o, status: x?.status || "undecided", reason: x?.reason || "the platform host policy gave no decision for this operator" });
  }
  return { admitted, refused, unreadable: false };
}

/**
 * The host's relay policy -> its operator decider, or null when the policy is OFF.
 *   null                         policy off (the host's explicit configuration): relays are not judged
 *   a policy gate                { decideOperators, refresh? } (host-policy-runtime's runtime.gate): wrapped in the SHARED
 *                                adapter operatorDecider, which refreshes once when this node is behind the anchor or the
 *                                authority moved, then decides again
 *   a function                   an operator decider as is (a host that is on but unusable passes one that throws)
 */
export function relayPolicyDecider(policy) {
  if (policy === null || policy === undefined) return null;
  if (typeof policy === "function") return policy;
  if (typeof policy?.decideOperators === "function") return operatorDecider(policy);
  throw new Error("relay policy: a policy gate (decideOperators) or an operator decider is required");
}

/** One relay operator, judged NOW (never cached): -> { admit, status, reason }. Called before every signature. */
export const relayAdmission = (decide) => async (operator) => {
  const j = await judgeRelayOperators([operator], decide);
  if (j.admitted.has(lc(operator))) return { admit: true, status: "admitted", reason: null };
  return { admit: false, ...(j.refused[0] || { status: "undecided", reason: "no decision" }) };
};

/**
 * -> { relays: [{ origin, payee, operator }], excluded, rejected, refusedByPolicy, policy, index: { blockNumber, blockHash } }.
 * pins: the lease deployment's { chainId, reserve, executor }. decide: an operator decider (relayPolicyDecider) judged
 * STRICTLY (judgeRelayOperators); `policy` is "applied", "unreadable" (every relay refused) or "not applied" (no decider:
 * the endpoint list only - a lease client then judges each operator before signing). Throws when the index cannot be read
 * completely by an agreeing quorum (a partial list proves nothing about the rest).
 */
export async function discoverLeaseRelays({ peers, clients, indexPin, pins, decide = null, failureDomains = [], resolve = defaultResolve,
  fetch = globalThis.fetch, timeoutMs = 5000, maxRelays = 8, now = Date.now, readOptions = {}, readIndex = readServiceIndex }) {
  const read = await readIndex({ peers, clients, pin: indexPin, kinds: ["relay"], ...readOptions });
  if (read.status !== "complete") throw new Error("service index read incomplete: relays not discovered");
  const candidates = (read.candidates || []).filter((c) => c.kindName === "relay");
  const judged = decide ? await judgeRelayOperators(candidates.map((c) => c.operator), decide) : null;
  const refusedByPolicy = [];
  const relays = [], excluded = [], rejected = [];
  for (const c of candidates) {
    if (relays.length >= maxRelays) continue;
    if (judged && !judged.admitted.has(lc(c.operator))) {
      const r = judged.refused.find((x) => x.operator === lc(c.operator));
      refusedByPolicy.push({ candidate: c, status: r?.status || "undecided", reason: r?.reason || "no decision" }); continue;
    }
    for (const endpoint of c.endpoints) {
      const k = await classifyEndpoint(endpoint, failureDomains, resolve);
      if (k.excluded) { excluded.push({ endpoint, operator: c.operator, domain: k.domain, reason: k.reason }); continue; }
      const origin = new URL(endpoint).origin;
      try {
        const d = verifyDescriptor(await boundedGet(fetch, `${origin}/v1/descriptor`, timeoutMs, 4096), c);
        if (d.role !== "lease-relay" || !isAddress(String(d.payee || "")) || d.chainId !== pins.chainId || lc(d.reserve) !== lc(pins.reserve))
          throw new Error("the descriptor is not a lease relay for this chain and reserve");
        const info = JSON.parse((await boundedGet(fetch, `${origin}/v1/info`, timeoutMs, 16384)).toString("utf8"));
        const payee = await verifyRelayStatement(info, { expectedPayee: d.payee, pins, now: now() });
        if (!relays.some((r) => r.origin === origin)) relays.push({ origin, payee, operator: getAddress(c.operator) });
        break;                                                      // one verified endpoint per advertised relay
      } catch (e) { rejected.push({ endpoint, operator: c.operator, reason: String(e.message).slice(0, 200) }); }
    }
  }
  return { relays, excluded, rejected, refusedByPolicy, policy: !judged ? "not applied" : judged.unreadable ? "unreadable" : "applied",
    index: { blockNumber: read.blockNumber, blockHash: read.blockHash } };
}

/**
 * A bounded cache of ENDPOINTS for a lease client's `discoverRelays`: re-read every `ttlMs`; when a refresh fails, the last
 * verified list is used for at most `staleMs`, then the failure is reported (the client then ends NotRelayed unless another
 * relay is configured - never operator-paid). It caches no authority: before every lease each relay is re-authenticated
 * (its signed statement) and, with the policy on, its operator is re-judged under the current policy (relayAdmission), so
 * neither a refresh nor a stale list can revive a banned operator.
 */
export function cachedRelayDiscovery(discover, { ttlMs = 10 * 60_000, staleMs = 60 * 60_000, log = () => {}, now = Date.now } = {}) {
  let last = null, inflight = null;
  return async () => {
    if (last && now() - last.at < ttlMs) return last.relays;
    if (!inflight) inflight = discover().then((r) => { last = { at: now(), relays: r.relays }; log(`[lease-gas] ${r.relays.length} designated relay(s) from the service index at block ${r.index.blockNumber} (${r.excluded.length} excluded, ${r.rejected.length} rejected, policy ${r.policy})`); return r.relays; })
      .finally(() => { inflight = null; });
    try { return await inflight; }
    catch (e) {
      if (last && now() - last.at < staleMs) { log(`[lease-gas] relay discovery failed (${e.message}); using the list verified ${Math.round((now() - last.at) / 1000)} s ago`); return last.relays; }
      throw e;
    }
  };
}
