// Shared Linux/Windows configuration boundary. Partly configured sponsorship is an error, never permission to spend
// the operator's ETH. Only an entirely unconfigured feature returns null for the pre-migration legacy path.
import fs from "node:fs";
import { createPublicClient, getAddress, http } from "viem";
import { parseDeploymentRecord } from "./lease-gas-owner.mjs";
import { createLeaseClient, validateRelayUrl, validateLocalRelayUrl, parsePinnedRelays } from "./lease-executor-client.mjs";
import { leaseRpcSet } from "./lease-executor-authority.mjs";
import { discoverLeaseRelays, cachedRelayDiscovery, relayPolicyDecider, relayAdmission } from "./lease-relay-discovery.mjs";
import { validateIndexPin } from "./service-index.mjs";
import { chainVerifierOf } from "./verified-chain.mjs";

// Where a host's lease operations are submitted (at least one): LOCAL_RELAY, an OPTIONAL relay of the host's own on this
// machine (loopback only); RELAYS, configured relays; SERVICE_INDEX (<index address>@<runtime code hash>), DESIGNATED relays
// found in the pinned EnclaveServiceIndex and authenticated before use (lease-relay-discovery.mjs), with RELAY_EXCLUDE
// naming the failure-domain addresses/names never to use (e.g. the DigitalOcean fleet). A zero-ETH host with no relay of
// its own uses designated relays and holds no float. PINNED_RELAYS ("origin,payee,operator[;...]"): EXPLICITLY configured
// host-local relays on the host link (a control CVM's http://10.0.2.2:<port>, a host's LAN address), each bound to its
// payee and its registered operator, and used only after the relay's fresh signed statement recovers to that payee and
// the platform host policy admits that operator (lease-executor-client.mjs validatePinnedRelay); they may be the only route.
const FIELDS = ["FILE", "DIGEST", "RPCS", "RELAYS", "LOCAL_RELAY", "PINNED_RELAYS", "SERVICE_INDEX", "RELAY_EXCLUDE", "RESERVE", "QUORUM"];
const names = (field) => [`ENCLAVE_LEASE_GAS_${field}`, `LEASE_GAS_${field}`];
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function leaseGasConfigured(env = process.env) {
  return FIELDS.some((field) => names(field).some((key) => nonempty(env[key])));
}

function setting(env, field) {
  const [windows, linux] = names(field);
  const a = String(env[windows] || "").trim(), b = String(env[linux] || "").trim();
  if (a && b && a !== b) throw new Error(`conflicting ${windows} and ${linux}`);
  return a || b;
}
const required = (env, field) => {
  const value = setting(env, field);
  if (!value) throw new Error(`app-funded leases require ENCLAVE_LEASE_GAS_${field} (or LEASE_GAS_${field}); operator-paid fallback is disabled`);
  return value;
};
const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);

/** Check again before sending if the host's current AddressBook/registry/ledger binding can change at runtime. */
export function assertLeaseGasBindings(config, { chain, ledger, registry }) {
  if (!config) return;
  if (chain?.id !== config.deployment.chainId) throw new Error("lease-gas record differs from the host's configured chain");
  if (getAddress(ledger) !== config.deployment.ledger || getAddress(registry) !== config.deployment.registry)
    throw new Error("lease-gas record differs from the host's current ledger or registry; update the reviewed record before sending");
}

/** `chain`, `ledger`, and `registry` are the host's existing reviewed binding. The record digest is a trusted local
 * setting, not downloaded with its file or accepted from a relay. Calling this function performs no RPC or signing. */
export function loadLeaseGasConfig({ env = process.env, chain, ledger, registry, readFile = fs.readFileSync,
  allowLoopbackHttp = false, rpcTimeoutMs = 10_000 } = {}) {
  if (!leaseGasConfigured(env)) return null;
  const file = required(env, "FILE"), digest = required(env, "DIGEST");
  const rpcs = list(required(env, "RPCS"));
  const localRaw = setting(env, "LOCAL_RELAY");
  const localRelays = localRaw ? [validateLocalRelayUrl(localRaw)] : [];
  const indexRaw = setting(env, "SERVICE_INDEX");
  const pinnedRaw = setting(env, "PINNED_RELAYS");
  const pinnedRelays = pinnedRaw ? parsePinnedRelays(pinnedRaw) : Object.freeze([]);
  const relays = list(localRelays.length || indexRaw || pinnedRelays.length ? setting(env, "RELAYS") : required(env, "RELAYS")).map((url) => validateRelayUrl(url, { allowLoopbackHttp }));
  if (!rpcs.length || !(relays.length + localRelays.length + pinnedRelays.length) && !indexRaw) throw new Error("app-funded leases require nonempty RPC and relay lists");
  const excludeRaw = list(setting(env, "RELAY_EXCLUDE"));
  if (excludeRaw.length && !indexRaw) throw new Error("RELAY_EXCLUDE applies to relays found in the service index: set SERVICE_INDEX too");
  if (new Set([...localRelays, ...relays, ...pinnedRelays.map((r) => r.origin)]).size !== relays.length + localRelays.length + pinnedRelays.length) throw new Error("lease-gas relays repeat an origin");
  const deployment = parseDeploymentRecord(readFile(file), { expectedDigest: digest });
  let relayDiscovery = null;
  if (indexRaw) {
    const m = /^(0x[0-9a-fA-F]{40})@(0x[0-9a-fA-F]{64})$/.exec(indexRaw);
    if (!m) throw new Error("SERVICE_INDEX must be <index address>@<runtime code hash> (the pinned EnclaveServiceIndex)");
    const indexPin = validateIndexPin({ chainId: deployment.chainId, address: m[1], codeHash: m[2].toLowerCase() });
    const addresses = [], names = [];
    for (const x of excludeRaw) {
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(x)) addresses.push(x);
      else if (/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(x)) names.push(x.toLowerCase());
      else throw new Error(`RELAY_EXCLUDE: ${x.slice(0, 80)} is neither an IPv4 address nor a DNS name`);
    }
    // the index is read under the host's explicit chain authority (ENCLAVE_CHAIN_AUTHORITY=verifier: the local verifier, no RPC)
    const verifier = chainVerifierOf({ chainAuthority: env.ENCLAVE_CHAIN_AUTHORITY || undefined, chainVerifier: env.ENCLAVE_CHAIN_VERIFIER || undefined }, "lease relay discovery");
    relayDiscovery = Object.freeze({ indexPin, failureDomains: Object.freeze(excludeRaw.length ? [Object.freeze({ name: "excluded", addresses, names })] : []),
      readOptions: Object.freeze(verifier ? { chainAuthority: "verifier", chainVerifier: verifier } : {}) });
  }
  const config = { deployment };
  assertLeaseGasBindings(config, { chain, ledger, registry });
  const legacyReserve = setting(env, "RESERVE");
  if (legacyReserve && getAddress(legacyReserve) !== deployment.reserve)
    throw new Error("legacy lease-gas reserve setting differs from the reviewed deployment record");
  const rawQuorum = setting(env, "QUORUM");
  if (rawQuorum && !/^[1-9][0-9]*$/.test(rawQuorum)) throw new Error("lease-gas quorum must be an integer");
  const quorum = rawQuorum ? Number(rawQuorum) : undefined;
  const clients = rpcs.map((url) => createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: rpcTimeoutMs }) }));
  // Validate identities and the threshold now, before a caller can mistake configuration failure for feature-off.
  const peers = leaseRpcSet(clients, { quorum, allowLoopbackHttp, timeoutMs: rpcTimeoutMs });
  return Object.freeze({ deployment, reserve: deployment.reserve, clients: Object.freeze(clients),
    relays: Object.freeze(relays), localRelays: Object.freeze(localRelays), ...(pinnedRelays.length ? { pinnedRelays } : {}), relayDiscovery, quorum: peers.required, allowLoopbackHttp, rpcTimeoutMs });
}

/** Both hosts use this factory. Supply getBindings so a running host cannot keep sending to a previous ledger after
 * an administrator migrates its current binding. A reviewed replacement configuration can then be loaded normally. */
/**
 * relayPolicy: this host's platform host policy for DESIGNATED relays (lease-relay-discovery.mjs relayPolicyDecider): its
 * policy gate (host-policy-runtime runtime.gate; refreshed through the shared operatorDecider adapter), an operator decider,
 * or null ONLY when the host's policy is explicitly off. The service-index ENDPOINT list is cached; the operator decision
 * never is: each discovered relay's operator must be explicitly admitted immediately before every signature. A PINNED
 * relay's operator is judged the same way, before every operation, and with NO policy-off exemption: a host whose policy is
 * off (relayPolicy null) never pays a pinned relay (fail closed; never the operator's ETH either).
 */
export function configuredLeaseSender({ config, account, getBindings, relayPolicy = null, discoveryOptions = {}, ...options }) {
  if (!config) throw new Error("app-funded lease sender needs a complete reviewed configuration");
  if (typeof getBindings !== "function") throw new Error("app-funded lease sender needs the host's current bindings");
  const { relayDiscovery, ...clientConfig } = config;
  const decide = relayPolicyDecider(relayPolicy);
  const discoverRelays = relayDiscovery ? cachedRelayDiscovery(() => discoverLeaseRelays({ clients: config.clients, indexPin: relayDiscovery.indexPin,
    pins: config.deployment, failureDomains: relayDiscovery.failureDomains, readOptions: relayDiscovery.readOptions ?? {}, fetch: options.fetchImpl ?? globalThis.fetch, ...discoveryOptions }),
    { log: options.log }) : null;
  const admitPinnedRelay = !config.pinnedRelays?.length ? null : decide ? relayAdmission(decide)
    : async () => ({ admit: false, status: "policy-off", reason: "this host's platform host policy is off: a pinned relay is paid only on the policy's admission of its operator" });
  const sender = createLeaseClient({ ...options, ...clientConfig, account, discoverRelays, admitDiscoveredRelay: relayDiscovery && decide ? relayAdmission(decide) : null, admitPinnedRelay });
  const verifyBinding = () => assertLeaseGasBindings(config, getBindings());
  return {
    ...sender,
    claim: (...args) => { verifyBinding(); return sender.claim(...args); },
    renew: (...args) => { verifyBinding(); return sender.renew(...args); },
    release: (...args) => { verifyBinding(); return sender.release(...args); },
    asClaimTx: (...args) => { verifyBinding(); return sender.asClaimTx(...args); },
    renewLeadMs: (...args) => { verifyBinding(); return sender.renewLeadMs(...args); },
    resolveSigned: (...args) => { verifyBinding(); return sender.resolveSigned(...args); },
  };
}

/** The strict sponsored-release journal (a host without its own: the Windows node). */
export { openReleaseJournal, strictWriteFile } from "./lease-release-journal.mjs";
