// independent-runtime.mjs -- the running pieces of independent hosting (independent.mjs has the profile and configs):
//   quorumPublicClient   contract reads agreed by a majority of the owner's RPCs at ONE block (custody/v2/quorum.mjs); writes,
//                        receipts and logs through the same RPCs with fallback (the lease sender verifies its own receipts)
//   hostPolicyGate       the admin's anchored platform host policy for THIS host (network/host-policy-runtime.mjs measured gate)
//   appFundedLeases      claim/renew/release paid by the app's reserve (network/lease-gas-runtime.mjs); a partial or missing
//                        configuration throws -- there is no operator-paid fallback
//   capacityPublisher    the operator-signed capacity record (network/host-capacity-producer.mjs), posted to the owner's
//                        directories at half its lifetime: the host's off-chain liveness (no on-chain heartbeat)
import path from "node:path";
import { createPublicClient, http, fallback, keccak256, toBytes } from "viem";
import { createQuorumReader } from "../../../../custody/v2/quorum.mjs";
import { resolveHostPolicyConfig, createHostPolicyRuntime, fileStore } from "../../../../network/host-policy-runtime.mjs";
import { loadLeaseGasConfig, configuredLeaseSender } from "../../../../network/lease-gas-runtime.mjs";
import { createHostCapacityProducer } from "../../../../network/host-capacity-producer.mjs";
import { leaseGasEnv, platformPolicyEnv } from "./independent.mjs";

const tag = (_k, v) => (typeof v === "bigint" ? { $bigint: String(v) } : v);
const untag = (_k, v) => (v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$bigint === "string" ? BigInt(v.$bigint) : v);

/**
 * A viem-shaped public client whose readContract is answered only when `quorum` of `clients` agree on it at one agreed,
 * fresh block; everything else (getBlockNumber, getBlock, logs, receipts, gas, raw sends) through `rest` (a fallback over
 * the same RPCs). A read naming its own block or tag goes to `rest` as asked.
 */
export function quorumPublicClient({ clients, quorum, chainId, rest, maxAgeSec = 300 }) {
  const agreed = createQuorumReader({ clients, minAgree: quorum, chainId: Number(chainId), maxAgeSec });
  const readContract = async (args) => {
    if (args && (args.blockNumber !== undefined || args.blockTag !== undefined)) return rest.readContract(args);
    const r = await agreed(async (c, b) => ({ value: JSON.stringify(await c.readContract({ ...args, blockNumber: b.blockNumber }), tag) }));
    return JSON.parse(r.value, untag);
  };
  return new Proxy(rest, { get: (t, k) => (k === "readContract" ? readContract : k === "quorum" ? { clients: clients.length, quorum } : Reflect.get(t, k)) });
}

/** The owner's RPCs as the quorum client (`chain` is a viem chain object). */
export function independentChain(profile, chain, { timeoutMs = 20000 } = {}) {
  const t = (u) => http(u, { retryCount: 1, retryDelay: 600, timeout: timeoutMs });
  const clients = profile.chain.rpcs.map((u) => createPublicClient({ chain, transport: t(u) }));
  const rest = createPublicClient({ chain, transport: fallback(profile.chain.rpcs.map(t), { rank: false }) });
  return quorumPublicClient({ clients, quorum: profile.chain.quorum, chainId: profile.chain.chainId, rest });
}

/**
 * This host's measured platform-policy gate: the profile's policy (production by default; never off), its accepted policy
 * persisted in stateDir (a ban survives a restart; an admission never does). -> { check() -> state, state(), runtime }
 */
export function hostPolicyGate({ profile, hostId, stateDir, fetch = globalThis.fetch, clients = null, snapshot = null, log = () => {}, now = Date.now }) {
  const resolved = resolveHostPolicyConfig({ env: platformPolicyEnv(profile), chainId: Number(profile.chain.chainId), book: profile.chain.addressBook });
  if (!resolved.on) throw new Error(`the platform host policy is off (${resolved.reason}): an independent host keeps the admin's bans`);
  const runtime = createHostPolicyRuntime(resolved, { store: fileStore(path.join(stateDir, "platform-policy.json")), fetch, log, ...(clients ? { clients } : {}), ...(snapshot ? { snapshot } : {}) });
  const gate = runtime.measured(hostId, { persist: fileStore(path.join(stateDir, "platform-policy-host.json")), now });
  return { check: gate.check, state: gate.state, runtime };
}

/**
 * The app-funded lease sender, bound to the agent's CURRENT bindings: `bindings()` -> { chain: { id }, ledger, registry } (the
 * address book as read now). Loading checks the reviewed record against them; every send checks again.
 */
export function appFundedLeases({ profile, account, bindings, readFile, allowLoopbackHttp = false, log = () => {}, fetchImpl, onSigned }) {
  const b = bindings();
  if (!b) throw new Error("the host's ledger and registry are not known yet: read the address book first");
  const config = loadLeaseGasConfig({ env: leaseGasEnv(profile), chain: b.chain, ledger: b.ledger, registry: b.registry, ...(readFile ? { readFile } : {}), allowLoopbackHttp });
  if (!config) throw new Error("app-funded leases are not configured (independent hosting has no operator-paid fallback)");
  return configuredLeaseSender({ config, account, getBindings: () => { const now = bindings(); if (!now) throw new Error("no current bindings"); return now; },
    log, ...(fetchImpl ? { fetchImpl } : {}), ...(onSigned ? { onSigned } : {}) });
}

/**
 * The host's signed capacity record, posted to the owner's directories: { tick() -> results | null (nothing due) }. Signed
 * only while the agent's identity() says the registry confirms this host (unregistered or deregistered: nothing is signed).
 */
export function capacityPublisher({ profile, account, agent, fetchJson, now = Date.now, log = () => {} }) {
  const lifetimeMs = profile.capacity.lifetimeSec * 1000;
  const producer = createHostCapacityProducer({ account, hostIdOf: (e) => keccak256(toBytes(String(e))), chainId: Number(profile.chain.chainId),
    identity: () => agent.identity(), availability: async () => agent.availability(), lifetimeMs, now, ...(fetchJson ? { fetchJson } : {}) });
  let last = 0;
  async function tick() {
    if (!agent.identity() || now() - last < lifetimeMs / 2) return null;
    try {
      const results = await producer.publish(profile.directories);
      last = now();
      log({ ev: "capacity-published", ok: results.filter((r) => r.ok).length, of: results.length, failed: results.filter((r) => !r.ok).map((r) => `${r.origin}: ${r.status || r.error}`) });
      return results;
    } catch (e) { log({ ev: "capacity-unsigned", why: e.message }); return null; }
  }
  return { tick, producer };
}
