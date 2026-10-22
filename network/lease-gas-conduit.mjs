// The app-funded lease-gas conduit of a metal node (work/linux-lease-activation): how the supervisor INSIDE the control
// CVM receives the same reviewed lease-gas configuration a Windows node reads from its environment
// (network/lease-gas-runtime.mjs loadLeaseGasConfig: ENCLAVE_LEASE_GAS_FILE/DIGEST/RPCS/RELAYS/RESERVE/QUORUM).
//
//   host config `leaseGas`  --(launcher: leaseGasTransit)-->  fw_cfg `leaseGas` (legacy control)
//                                                             or the HOST_DATA-bound direct config `leaseGas` (direct control)
//   fw_cfg / direct config  --(gsup / measured-control: leaseGasGuest)-->  /run/lease-gas/deployment.json + those six
//                                                             environment names, and NOTHING else
//
// Optional `pinnedRelays` ([{ origin, payee, operator }], 1 to 4): EXPLICITLY configured host-local relays the control CVM
// reaches over the host link - typically http://10.0.2.2:<port>, the QEMU user-net gateway, i.e. the host's own loopback
// where its lease-relay host role listens (network/host-services/lease-relay-host.mjs). Each is bound to its payee and its
// registered operator, and the supervisor uses it only after the relay's fresh signed statement recovers to that payee and
// the platform host policy admits that operator (lease-executor-client.mjs validatePinnedRelay; the discovered-relay proof).
// It crosses as one more name, ENCLAVE_LEASE_GAS_PINNED_RELAYS, and may be the only route (relays then empty). ABSENT,
// the transit, the six names and every bound direct-config digest are exactly as before.
//
// Everything that crosses is public: the deployment record (addresses and code hashes) with the digest the operator
// reviewed, the RPC and relay origins, the reserve and the quorum. No key, no wallet and no arbitrary environment name
// crosses. Every check here is the reviewed one (lease-gas-owner.mjs parseDeploymentRecord, the relay rule of
// lease-executor-client.mjs, the RPC rule of rpc-identity.mjs); the supervisor checks it all again when it loads.
// Partial or invalid configuration REFUSES: on the host the launch stops before QEMU; in the guest the supervisor is
// handed a configuration that is "configured but unloadable", so every claim, renewal and release refuses
// (supervisor.js leaseGasError) and the operator's own ETH is never used for them.
import { parseDeploymentRecord } from "./lease-gas-owner.mjs";
import { validateRelayUrl, validatePinnedRelay, pinnedRelaysValue, MAX_PINNED_RELAYS } from "./lease-executor-client.mjs";
import { rpcEndpoint, rpcLabel } from "./rpc-identity.mjs";

export const TRANSIT_VERSION = 1;
export const GUEST_RECORD_FILE = "/run/lease-gas/deployment.json";
/** A path that never exists: the "configured but unloadable" marker for a refused transit. */
export const REFUSED_RECORD_FILE = "/run/lease-gas/REFUSED-see-gsup-log";
export const ENV_NAMES = Object.freeze(["ENCLAVE_LEASE_GAS_FILE", "ENCLAVE_LEASE_GAS_DIGEST", "ENCLAVE_LEASE_GAS_RPCS",
  "ENCLAVE_LEASE_GAS_RELAYS", "ENCLAVE_LEASE_GAS_RESERVE", "ENCLAVE_LEASE_GAS_QUORUM"]);
/** The seventh name, set only when the transit carries pinnedRelays (lease-gas-runtime.mjs PINNED_RELAYS). */
export const PINNED_ENV_NAME = "ENCLAVE_LEASE_GAS_PINNED_RELAYS";
/** Every name the supervisor reads as lease-gas configuration (supervisor.js leaseGasEnv). */
export const isLeaseGasName = (k) => /^(ENCLAVE_)?LEASE_GAS_/.test(k);

const MAX_RPCS = 8, MAX_RELAYS = 8;
const fail = (m) => { throw new Error(`lease-gas: ${m}`); };
const plain = (o) => !!o && typeof o === "object" && !Array.isArray(o);
function only(o, allowed, what) {
  if (!plain(o)) fail(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what} has an unknown field ${JSON.stringify(k)}`);
}
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function rpcList(list, { published }) {
  // at least two: the supervisor's reader requires a strict-majority quorum of two or more distinct providers
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_RPCS) fail(`rpcs: 2 to ${MAX_RPCS} https RPC URLs of distinct providers`);
  const seen = new Set();
  return list.map((raw, i) => {
    if (typeof raw !== "string") fail(`rpcs[${i}] must be a string`);
    let e;
    try { e = rpcEndpoint(raw); } catch (x) { fail(`rpcs[${i}]: ${x.message}`); }
    if (e.url.protocol !== "https:") fail(`rpcs[${i}] (${e.label}) must be https`);
    // a direct config is the owner's document a verifier recomputes: it may not carry a key in a query
    if (published && e.url.search) fail(`rpcs[${i}] (${e.label}): a bound direct config carries no query (it would publish a key)`);
    if (seen.has(e.identity)) fail(`rpcs[${i}] (${e.label}) repeats a provider`);
    seen.add(e.identity);
    return raw;
  });
}
function relayList(list, { pinned = false } = {}) {
  // with pinned relays configured, public https relays are optional (a pinned relay may be the only route)
  if (pinned && (list === undefined || list === null)) list = [];
  if (!Array.isArray(list) || list.length < (pinned ? 0 : 1) || list.length > MAX_RELAYS) fail(`relays: 1 to ${MAX_RELAYS} https relay origins`);
  const out = list.map((raw, i) => {
    if (typeof raw !== "string") fail(`relays[${i}] must be a string`);
    let o;
    try { o = validateRelayUrl(raw); } catch (x) { fail(`relays[${i}]: ${x.message}`); }
    if (o !== raw) fail(`relays[${i}] must be written as its origin (${o})`);
    return o;
  });
  if (new Set(out).size !== out.length) fail("relays repeat an origin");
  return out;
}
function pinnedList(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PINNED_RELAYS) fail(`pinnedRelays: 1 to ${MAX_PINNED_RELAYS} { origin, payee, operator }`);
  const out = list.map((raw, i) => {
    let r;
    try { r = validatePinnedRelay(raw); } catch (x) { fail(`pinnedRelays[${i}]: ${x.message}`); }
    // the checked form only (exactly these fields, the origin as written, checksummed addresses); key order is free (a bound
    // direct config is held in canonical JSON, which sorts keys)
    if (raw.origin !== r.origin || raw.payee !== r.payee || raw.operator !== r.operator) fail(`pinnedRelays[${i}] must be written in its checked form ${JSON.stringify(r)}`);
    return r;
  });
  if (new Set(out.map((r) => r.origin)).size !== out.length) fail("pinnedRelays repeat an origin");
  return Object.freeze(out);
}
function quorumOf(q, rpcs) {
  if (q === undefined || q === null) return null;
  if (!Number.isInteger(q) || q < 2 || q > rpcs.length || q <= rpcs.length / 2) fail("quorum must be a strict majority of at least two of the rpcs");
  return q;
}

/**
 * The transit object, from its parts, every part checked. `record` is the exact record bytes. -> frozen
 * { version, record (base64), digest, chainId, reserve, rpcs, relays, quorum[, pinnedRelays] } (pinnedRelays only when given).
 */
function transitOf({ record, digest, rpcs, relays, reserve, quorum, pinnedRelays }, { published = false } = {}) {
  if (typeof digest !== "string" || !DIGEST.test(digest)) fail("digest must be the reviewed sha256:<64 hex> of the deployment record");
  const dep = parseDeploymentRecord(record, { expectedDigest: digest });
  const pr = pinnedList(pinnedRelays);
  const r = rpcList(rpcs, { published }), rl = relayList(relays, { pinned: !!pr });
  if (pr && rl.some((o) => pr.some((p) => p.origin === o))) fail("pinnedRelays repeat a relay origin");
  if (reserve !== undefined && reserve !== null && (typeof reserve !== "string" || reserve.toLowerCase() !== dep.reserve.toLowerCase()))
    fail("reserve differs from the reviewed deployment record");
  return Object.freeze({ version: TRANSIT_VERSION, record: Buffer.from(record).toString("base64"), digest, chainId: dep.chainId,
    reserve: dep.reserve, rpcs: Object.freeze(r), relays: Object.freeze(rl), quorum: quorumOf(quorum, r), ...(pr ? { pinnedRelays: pr } : {}) });
}

/**
 * HOST (metal/enclave-metal.mjs): the operator's `leaseGas` config -> the transit for fw_cfg, or null when absent.
 *   { recordFile, digest, rpcs: [...], relays: [...], reserve?, quorum?, pinnedRelays? } (relays optional with pinnedRelays)
 * Absent (undefined/null) is the only "off". Anything else must be complete and valid, or this throws (the launch stops).
 */
export function leaseGasTransit(cfg, { readFile, chainId = null } = {}) {
  if (cfg === undefined || cfg === null) return null;
  only(cfg, ["recordFile", "digest", "rpcs", "relays", "reserve", "quorum", "pinnedRelays"], "leaseGas");
  const needed = cfg.pinnedRelays === undefined || cfg.pinnedRelays === null ? ["recordFile", "digest", "rpcs", "relays"] : ["recordFile", "digest", "rpcs"];
  for (const k of needed) if (cfg[k] === undefined || cfg[k] === null || cfg[k] === "")
    fail(`leaseGas.${k} is required: a partial configuration never falls back to the operator's wallet`);
  if (typeof cfg.recordFile !== "string") fail("leaseGas.recordFile must be a path");
  if (typeof readFile !== "function") fail("no file reader");
  const t = transitOf({ ...cfg, record: readFile(cfg.recordFile) });
  if (chainId !== null && t.chainId !== chainId) fail(`the deployment record is for chain ${t.chainId}, this host runs chain ${chainId}`);
  return t;
}

/** Re-check a transit as received (fw_cfg is the host's word; a direct config's is bound). -> the transit (frozen). */
export function checkTransit(t, { published = false } = {}) {
  only(t, ["version", "record", "digest", "chainId", "reserve", "rpcs", "relays", "quorum", "pinnedRelays"], "leaseGas transit");
  if ("pinnedRelays" in t && (t.pinnedRelays === undefined || t.pinnedRelays === null)) fail("transit pinnedRelays is either a list or absent");
  if (!Array.isArray(t.relays)) fail("transit relays must be a list");
  if (t.version !== TRANSIT_VERSION) fail(`transit version must be ${TRANSIT_VERSION}`);
  if (typeof t.record !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(t.record)) fail("transit record must be base64");
  const record = Buffer.from(t.record, "base64");
  if (record.toString("base64") !== t.record) fail("transit record is not canonical base64");
  const again = transitOf({ record, digest: t.digest, rpcs: t.rpcs, relays: t.relays, reserve: t.reserve, quorum: t.quorum, pinnedRelays: t.pinnedRelays }, { published });
  if (again.chainId !== t.chainId) fail("transit chainId differs from its record");
  return again;
}

/**
 * GUEST (metal/guest/gsup.mjs legacy path, measured-control.mjs direct path): a transit -> what to install.
 *   -> { configured: false }                              (absent: the feature is off, nothing is set)
 *   -> { configured: true, ok: true, env, files, summary } (the six names - RELAYS only when non-empty - plus PINNED_ENV_NAME
 *                                                          when pinned relays are configured, the record file; nothing else)
 *   -> { configured: true, ok: false, env, files: {}, reason } (refused: "configured but unloadable", fail closed)
 */
export function leaseGasGuest(transit, { recordFile = GUEST_RECORD_FILE, published = false } = {}) {
  if (transit === undefined || transit === null) return { configured: false, env: {}, files: {} };
  let t;
  try { t = checkTransit(transit, { published }); }
  catch (e) { return { configured: true, ok: false, env: { ENCLAVE_LEASE_GAS_FILE: REFUSED_RECORD_FILE }, files: {}, reason: e.message }; }
  const env = { ENCLAVE_LEASE_GAS_FILE: recordFile, ENCLAVE_LEASE_GAS_DIGEST: t.digest, ENCLAVE_LEASE_GAS_RPCS: t.rpcs.join(","),
    ...(t.relays.length ? { ENCLAVE_LEASE_GAS_RELAYS: t.relays.join(",") } : {}), ENCLAVE_LEASE_GAS_RESERVE: t.reserve,
    ...(t.quorum ? { ENCLAVE_LEASE_GAS_QUORUM: String(t.quorum) } : {}), ...(t.pinnedRelays ? { [PINNED_ENV_NAME]: pinnedRelaysValue(t.pinnedRelays) } : {}) };
  return { configured: true, ok: true, env, files: { [recordFile]: Buffer.from(t.record, "base64") },
    summary: `reserve ${t.reserve}, record ${t.digest.slice(0, 19)}…, ${t.relays.length} relay(s)${t.pinnedRelays ? `, ${t.pinnedRelays.length} pinned host relay(s) ${t.pinnedRelays.map((p) => p.origin).join(", ")}` : ""}, RPCs ${t.rpcs.map(rpcLabel).join(", ")}${t.quorum ? ` (quorum ${t.quorum})` : ""}` };
}

/**
 * An environment without any lease-gas name, then exactly `leaseGas.env` on top: the conduit is the ONLY source of
 * these names (a baked flavor file or a host policy can never add, change or drop one).
 */
export function withLeaseGasEnv(env, leaseGas) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !isLeaseGasName(k)));
  return { ...out, ...(leaseGas?.env || {}) };
}
