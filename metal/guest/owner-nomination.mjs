// The host operator's explicit, PUBLIC owner nomination for the ORIGINAL EnclaveHostOwnership extension
// (contracts/EnclaveHostOwnership.sol: the registered operator proposes the first owner; that wallet accepts).
// Dependency-free on purpose: the host launcher (metal/enclave-metal.mjs), the guest (gsup.mjs, measured-control.mjs
// from /opt/metal) and the supervisor (network/host-owner-nomination.mjs) read it with this ONE checker.
//
// A host whose control key lives in its measured guest (Linux metal) cannot sign proposeOwner from an admin wallet.
// With this config - and ONLY with it - the supervisor sends exactly one proposeOwner(hostId, owner) from the operator
// key, through its one serialized operator transaction queue, when the original contract shows owner 0 and pending 0.
// Absent = nothing happens. Nothing here names a recipient from anywhere but this operator-written config.
//   { "format": "enclave-host-owner-nomination/v1", "chainId": 8453,
//     "ownershipContract": "0x…", "ownershipCodeHash": "0x…", "registry": "0x…",
//     "hostId": "0x…", "endpoint": "https://…", "operator": "0x…", "owner": "0x…",
//     "rpcs": ["https://…", "https://…", "https://…"], "quorum": 2 }
export const OWNER_NOMINATION_FORMAT = 'enclave-host-owner-nomination/v1';
export const OWNER_NOMINATION_ENV = 'ENCLAVE_OWNER_NOMINATION';
const ADDR = /^0x[0-9a-fA-F]{40}$/, B32 = /^0x[0-9a-fA-F]{64}$/, ZERO_ADDR = /^0x0{40}$/i, ZERO32 = /^0x0{64}$/i;
const KEYS = ['format', 'chainId', 'ownershipContract', 'ownershipCodeHash', 'registry', 'hostId', 'endpoint', 'operator', 'owner', 'rpcs', 'quorum'];

function bad(m) { throw new Error(`ownerNomination: ${m}`); }
function addr(v, what) { if (typeof v !== 'string' || !ADDR.test(v) || ZERO_ADDR.test(v)) bad(`${what} must be a nonzero address`); return v.toLowerCase(); }
function b32(v, what) { if (typeof v !== 'string' || !B32.test(v) || ZERO32.test(v)) bad(`${what} must be a nonzero bytes32`); return v.toLowerCase(); }

/** -> the canonical, frozen nomination, or throws. allowLoopbackHttp: tests only (a loopback RPC fixture). */
export function checkOwnerNomination(raw, { allowLoopbackHttp = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('must be an object');
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) bad(`unknown field ${k}`);
  for (const k of KEYS) if (raw[k] === undefined || raw[k] === null) bad(`${k} is required`);
  if (raw.format !== OWNER_NOMINATION_FORMAT) bad(`format must be ${OWNER_NOMINATION_FORMAT}`);
  if (!Number.isSafeInteger(raw.chainId) || raw.chainId <= 0) bad('chainId must be a positive integer');
  let ep;
  try { ep = new URL(raw.endpoint); } catch { bad('endpoint must be a URL'); }
  if (ep.protocol !== 'https:' || ep.username || ep.password || ep.search || ep.hash || ep.href.replace(/\/+$/, '') !== raw.endpoint)
    bad('endpoint must be https, exactly as registered (no trailing slash, credentials, query or fragment)');
  const operator = addr(raw.operator, 'operator'), owner = addr(raw.owner, 'owner');
  if (owner === operator) bad('owner must be a wallet other than the operator key');
  if (!Array.isArray(raw.rpcs) || raw.rpcs.length < 2 || raw.rpcs.length > 8) bad('rpcs must list 2..8 RPC URLs');
  const hosts = new Set();
  const rpcs = raw.rpcs.map((u, i) => {
    let x; try { x = new URL(u); } catch { bad(`rpcs[${i}] must be a URL`); }
    const loop = x.protocol === 'http:' && allowLoopbackHttp && (x.hostname === '127.0.0.1' || x.hostname === '[::1]');
    if ((x.protocol !== 'https:' && !loop) || x.username || x.password || x.hash) bad(`rpcs[${i}] must be https without credentials`);
    const id = loop ? `${x.hostname}:${x.port}` : x.hostname.toLowerCase();
    if (hosts.has(id)) bad(`rpcs[${i}] repeats a provider (${id})`);
    hosts.add(id);
    return String(u);
  });
  if (!Number.isSafeInteger(raw.quorum) || raw.quorum < 2 || raw.quorum > rpcs.length || raw.quorum <= rpcs.length / 2)
    bad('quorum must be a strict majority of the rpcs, at least 2');
  return Object.freeze({ format: OWNER_NOMINATION_FORMAT, chainId: raw.chainId, ownershipContract: addr(raw.ownershipContract, 'ownershipContract'),
    ownershipCodeHash: b32(raw.ownershipCodeHash, 'ownershipCodeHash'), registry: addr(raw.registry, 'registry'), hostId: b32(raw.hostId, 'hostId'),
    endpoint: raw.endpoint, operator, owner, rpcs: Object.freeze(rpcs), quorum: raw.quorum });
}

/** Its canonical JSON (fixed key order: exactly checkOwnerNomination's output). */
export const ownerNominationJson = (n) => JSON.stringify(n);

/** Strict form for a BOUND config (direct control): it must already be written exactly in its checked form. */
export function boundOwnerNomination(raw, opts) {
  const n = checkOwnerNomination(raw, opts);
  if (ownerNominationJson(n) !== JSON.stringify(raw)) bad('must be written in its checked form (lowercase addresses, field order as documented)');
  return n;
}

/** The supervisor's env for it (merged into the supervisor env by gsup / measured-control). */
export const ownerNominationEnv = (n) => (n ? { [OWNER_NOMINATION_ENV]: ownerNominationJson(n) } : {});

/** The legacy guest's view of fw_cfg `ownerNomination` (gsup.mjs): -> { nomination | null, message | null }. */
export function guestOwnerNomination(value) {
  if (value === undefined || value === null) return { nomination: null, message: null };
  try {
    const n = checkOwnerNomination(value);
    return { nomination: n, message: `owner nomination configured: propose ${n.owner} on ${n.ownershipContract} for host ${n.hostId.slice(0, 10)}…` };
  } catch (e) { return { nomination: null, message: `owner nomination REFUSED (${e.message}): nothing is proposed` }; }
}
/** env with the nomination name ONLY from the checked nomination (any other source of that name is dropped). */
export function withOwnerNominationEnv(env, nomination) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => k !== OWNER_NOMINATION_ENV));
  return { ...out, ...ownerNominationEnv(nomination) };
}
