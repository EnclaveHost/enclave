// Shared Linux/Windows configuration boundary. Partly configured sponsorship is an error, never permission to spend
// the operator's ETH. Only an entirely unconfigured feature returns null for the pre-migration legacy path.
import fs from "node:fs";
import { createPublicClient, getAddress, http } from "viem";
import { parseDeploymentRecord } from "./lease-gas-owner.mjs";
import { createLeaseClient, validateRelayUrl } from "./lease-executor-client.mjs";
import { leaseRpcSet } from "./lease-executor-authority.mjs";

const FIELDS = ["FILE", "DIGEST", "RPCS", "RELAYS", "RESERVE", "QUORUM"];
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
  const relays = list(required(env, "RELAYS")).map((url) => validateRelayUrl(url, { allowLoopbackHttp }));
  if (!rpcs.length || !relays.length) throw new Error("app-funded leases require nonempty RPC and relay lists");
  if (new Set(relays).size !== relays.length) throw new Error("lease-gas relays repeat an origin");
  const deployment = parseDeploymentRecord(readFile(file), { expectedDigest: digest });
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
    relays: Object.freeze(relays), quorum: peers.required, allowLoopbackHttp, rpcTimeoutMs });
}

/** Both hosts use this factory. Supply getBindings so a running host cannot keep sending to a previous ledger after
 * an administrator migrates its current binding. A reviewed replacement configuration can then be loaded normally. */
export function configuredLeaseSender({ config, account, getBindings, ...options }) {
  if (!config) throw new Error("app-funded lease sender needs a complete reviewed configuration");
  if (typeof getBindings !== "function") throw new Error("app-funded lease sender needs the host's current bindings");
  const sender = createLeaseClient({ ...options, ...config, account });
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
