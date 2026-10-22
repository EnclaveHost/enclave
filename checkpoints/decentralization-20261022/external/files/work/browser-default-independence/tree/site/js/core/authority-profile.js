/* ============================================================
   The reviewed authority profile in the browser.

   A port of network/authority-profile.mjs (validateProfile,
   encodeProfile, parseProfile, profileRead + checkObservation) onto
   the page's own primitives: no node:crypto, no viem, no imports that
   bind contracts. The node module stays the reference;
   test/site-default-authority.test.mjs runs both on the reviewed Base
   profile and on every single-field corruption of it, and fails on
   any difference in PROFILE_LAYOUT or in the verdicts.

   A profile never vouches for itself: its bytes must hash to a digest
   the caller already holds (the build compiles it beside the bytes),
   be canonically encoded, and every contract it names must, at ONE
   block the profile's RPCs agree on, carry exactly the reviewed code
   and the reviewed bindings. Nothing observed is ever adopted.
   ============================================================ */
import { sha256Hex } from "./sha256.js";
import { keccak256Hex, keccak256Utf8 } from "./keccak.js";

export const AUTHORITY_KIND = "enclave.authority-profile";
export const AUTHORITY_MAX_BYTES = 65536;
const MAX_RUNTIME_BYTES = 24576;
const A = "address", B = "bool", U = "uint256", T3 = "address,address,address";
const owned = { owner: A, pendingOwner: A };
// network/authority-profile.mjs PROFILE_LAYOUT, verbatim (parity-tested)
export const AUTHORITY_LAYOUT = Object.freeze({
  registry: { role: "host-pin", immutable: { registrySchema: U }, reviewedState: {} },
  deployments: { role: "host-pin", immutable: { usdc: A, registry: A, deploymentsSchema: U },
    reviewedState: { ...owned, payout: A, ethUsdFeed: A, bandwidthRouter: A, feeRouter: A, prover: A, importsSealed: B, retired: B } },
  appCatalog: { role: "host-pin", immutable: {}, reviewedState: { ...owned, importsSealed: B } },
  proofOfTime: { role: "host-pin", immutable: { deployments: A, registry: A }, reviewedState: owned },
  enclavePay: { role: "host-pin", immutable: { usdc: A }, reviewedState: { ...owned, payout: A } },
  verificationFees: { role: "host-pin", immutable: { ledger: A, proof: A, token: A }, reviewedState: {} },
  connectivity: { role: "network", immutable: { ledger: A, registry: A }, reviewedState: {} },
  sessionVaultFactory: { role: "new-path", artifact: "PinnedSessionVaultFactory", immutable: { implementation: A, authorityPins: T3 }, reviewedState: {} },
  pinnedSessionAuthority: { role: "new-path", artifact: "PinnedSessionAuthority", immutable: { deployments: A, appCatalog: A, sessionVaultFactory: A }, reviewedState: {} },
  sessionVaultImplementation: { role: "new-path", artifact: "SessionVault", immutable: { usdc: A, book: A, router: A, keyAttestations: A, maxVault6: U, factory: A }, reviewedState: { owner: A } },
  sessionVaultLib: { role: "new-path", artifact: "SessionVaultLib", immutable: {}, reviewedState: {} },
  hostOwnership: { role: "new-path", artifact: "EnclaveHostOwnership", immutable: { registry: A }, reviewedState: {} },
  secretVaultV2: { role: "new-path", artifact: "EnclaveSecretVaultV2",
    immutable: { book: A, enclaveOwner: A, hostOwnership: A, hostRegistry: A, deploymentLedger: A, sessionVaultFactory: A }, reviewedState: {} },
  usdc: { role: "external", immutable: {}, reviewedState: {} },
  paymentRouter: { role: "dependency", immutable: { usdc: A, treasury: A }, reviewedState: {} },
  keyAttestations: { role: "dependency", immutable: {}, reviewedState: owned },
  legacySessionVaultFactory: { role: "legacy-compatibility", immutable: { implementation: A }, reviewedState: {} },
  legacySessionVaultImplementation: { role: "legacy-compatibility", immutable: { usdc: A, book: A, router: A, keyAttestations: A, factory: A }, reviewedState: { owner: A } },
});
const LINKS = [
  ["deployments", "immutable", "usdc", "usdc"], ["deployments", "immutable", "registry", "registry"],
  ["deployments", "reviewedState", "bandwidthRouter", "connectivity"], ["deployments", "reviewedState", "feeRouter", "verificationFees"],
  ["deployments", "reviewedState", "prover", "proofOfTime"],
  ["proofOfTime", "immutable", "deployments", "deployments"], ["proofOfTime", "immutable", "registry", "registry"],
  ["enclavePay", "immutable", "usdc", "usdc"],
  ["verificationFees", "immutable", "ledger", "deployments"], ["verificationFees", "immutable", "proof", "proofOfTime"], ["verificationFees", "immutable", "token", "usdc"],
  ["connectivity", "immutable", "ledger", "deployments"], ["connectivity", "immutable", "registry", "registry"],
  ["sessionVaultFactory", "immutable", "implementation", "sessionVaultImplementation"],
  ["sessionVaultFactory", "immutable", "authorityPins", ["deployments", "appCatalog", "pinnedSessionAuthority"]],
  ["pinnedSessionAuthority", "immutable", "deployments", "deployments"], ["pinnedSessionAuthority", "immutable", "appCatalog", "appCatalog"],
  ["pinnedSessionAuthority", "immutable", "sessionVaultFactory", "sessionVaultFactory"],
  ["sessionVaultImplementation", "immutable", "usdc", "usdc"], ["sessionVaultImplementation", "immutable", "book", "pinnedSessionAuthority"],
  ["sessionVaultImplementation", "immutable", "router", "paymentRouter"], ["sessionVaultImplementation", "immutable", "keyAttestations", "keyAttestations"],
  ["sessionVaultImplementation", "immutable", "factory", "sessionVaultFactory"],
  ["hostOwnership", "immutable", "registry", "registry"],
  ["secretVaultV2", "immutable", "book", "pinnedSessionAuthority"], ["secretVaultV2", "immutable", "hostOwnership", "hostOwnership"],
  ["secretVaultV2", "immutable", "hostRegistry", "registry"], ["secretVaultV2", "immutable", "deploymentLedger", "deployments"],
  ["secretVaultV2", "immutable", "sessionVaultFactory", "sessionVaultFactory"],
  ["paymentRouter", "immutable", "usdc", "usdc"],
  ["legacySessionVaultFactory", "immutable", "implementation", "legacySessionVaultImplementation"],
  ["legacySessionVaultImplementation", "immutable", "factory", "legacySessionVaultFactory"],
  ["legacySessionVaultImplementation", "immutable", "usdc", "usdc"], ["legacySessionVaultImplementation", "immutable", "router", "paymentRouter"],
  ["legacySessionVaultImplementation", "immutable", "keyAttestations", "keyAttestations"],
];
// the strict contract-pin document (network/contract-pins.mjs) a browser profile carries
export const PIN_KEYS = Object.freeze(["registry", "deployments", "appCatalog", "proofOfTime", "enclavePay", "verificationFees", "sessionVaultFactory", "secretVaultV2"]);

const plain = (v) => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const address = /^0x[0-9a-f]{40}$/, hash32 = /^0x[0-9a-f]{64}$/, zero = "0x" + "0".repeat(40);
function exactKeys(value, required, optional, what){
  if (!plain(value)) throw Error(what + " must be an object");
  for (const k of Object.keys(value)) if (!required.includes(k) && !optional.includes(k)) throw Error("unknown field: " + what + "." + k);
  for (const k of required) if (!Object.hasOwn(value, k)) throw Error("missing field: " + what + "." + k);
}
const text = (v, max, what) => { if (typeof v !== "string" || !v.length || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw Error("invalid " + what); return v; };

/* Sorted keys, two-space indentation, one trailing newline: the bytes the digest covers. */
export function encodeAuthority(value){
  const sort = (v) => {
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number"){ if (!Number.isSafeInteger(v)) throw Error("profile numbers must be safe integers"); return v; }
    if (Array.isArray(v)) return v.map(sort);
    if (plain(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    throw Error("profile must contain only JSON values");
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

function checkValue(type, value, what){
  if (type === A){ if (typeof value !== "string" || !address.test(value)) throw Error("invalid address binding: " + what); return; }
  if (type === B){ if (typeof value !== "boolean") throw Error("invalid boolean binding: " + what); return; }
  if (type === U){ if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw Error("invalid integer binding: " + what); return; }
  if (type === T3){ if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== "string" || !address.test(v))) throw Error("invalid tuple binding: " + what); return; }
  throw Error("unsupported binding type");
}

export function validateAuthority(profile){
  exactKeys(profile, ["kind", "version", "chainId", "scope", "review", "builds", "contracts"], [], "profile");
  if (profile.kind !== AUTHORITY_KIND || profile.version !== 1) throw Error("unsupported authority profile");
  if (profile.chainId !== 8453) throw Error("authority profile is not for Base mainnet");
  text(profile.scope, 2048, "scope");
  exactKeys(profile.review, ["blockNumber", "blockHash", "blockTimestamp", "capturedAt", "rpcHosts", "inputs"], [], "review");
  const r = profile.review;
  if (!/^[1-9][0-9]{0,15}$/.test(r.blockNumber) || !hash32.test(r.blockHash) || !Number.isSafeInteger(r.blockTimestamp) || r.blockTimestamp <= 0
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(r.capturedAt)) throw Error("invalid review snapshot");
  if (!Array.isArray(r.rpcHosts) || r.rpcHosts.length < 2 || r.rpcHosts.length > 8 || new Set(r.rpcHosts).size !== r.rpcHosts.length
    || r.rpcHosts.some((h) => typeof h !== "string" || !/^[a-z0-9.-]{1,253}$/.test(h))) throw Error("invalid review RPC hosts");
  if (!plain(r.inputs) || Object.keys(r.inputs).length < 1 || Object.keys(r.inputs).length > 8) throw Error("invalid review inputs");
  for (const [k, v] of Object.entries(r.inputs)){
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(k)) throw Error("invalid review input name");
    exactKeys(v, ["description", "sha256"], [], "review.inputs." + k); text(v.description, 512, "input description");
    if (!/^[0-9a-f]{64}$/.test(v.sha256)) throw Error("invalid input digest");
  }
  if (!plain(profile.builds) || Object.keys(profile.builds).length > 4) throw Error("invalid builds");
  for (const [name, b] of Object.entries(profile.builds)){
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw Error("invalid build name");
    exactKeys(b, ["compiler", "sourceCommit", "sourceSha256", "record"], [], "builds." + name);
    text(b.compiler, 128, "compiler"); text(b.record, 256, "build record");
    if (!/^[0-9a-f]{40}$/.test(b.sourceCommit)) throw Error("invalid build commit");
    if (!plain(b.sourceSha256) || !Object.keys(b.sourceSha256).length || Object.keys(b.sourceSha256).length > 16
      || Object.entries(b.sourceSha256).some(([f, h]) => !/^[A-Za-z0-9]{1,64}\.sol$/.test(f) || !/^[0-9a-f]{64}$/.test(h))) throw Error("invalid build sources");
  }
  const names = Object.keys(AUTHORITY_LAYOUT);
  exactKeys(profile.contracts, names, [], "contracts");
  const seen = new Map();
  for (const name of names){
    const c = profile.contracts[name], layout = AUTHORITY_LAYOUT[name], what = "contracts." + name;
    const compiled = !!layout.artifact;
    exactKeys(c, ["role", "address", "codeHash", "runtimeBytes", "codeProvenance", "immutable", "reviewedState", "ownerPowers"], compiled ? ["artifact", "build"] : [], what);
    if (c.role !== layout.role) throw Error("wrong role: " + name);
    if (!address.test(c.address) || c.address === zero) throw Error("invalid address: " + name);
    if (seen.has(c.address)) throw Error("duplicate contract address: " + name + " and " + seen.get(c.address));
    seen.set(c.address, name);
    if (!hash32.test(c.codeHash) || !Number.isSafeInteger(c.runtimeBytes) || c.runtimeBytes < 1 || c.runtimeBytes > MAX_RUNTIME_BYTES) throw Error("invalid code pin: " + name);
    if (c.codeProvenance !== (compiled ? "compiled-runtime" : "observed")) throw Error("wrong code provenance: " + name);
    if (compiled && (c.artifact !== layout.artifact || typeof c.build !== "string" || !Object.hasOwn(profile.builds, c.build))) throw Error("wrong build reference: " + name);
    for (const section of ["immutable", "reviewedState"]){
      exactKeys(c[section], Object.keys(layout[section]), [], what + "." + section);
      for (const [getter, type] of Object.entries(layout[section])) checkValue(type, c[section][getter], name + "." + getter);
    }
    if (!Array.isArray(c.ownerPowers) || c.ownerPowers.length < 1 || c.ownerPowers.length > 16) throw Error("invalid owner powers: " + name);
    c.ownerPowers.forEach((p) => text(p, 400, "owner power"));
  }
  for (const [from, section, getter, to] of LINKS){
    const got = profile.contracts[from][section][getter];
    const want = Array.isArray(to) ? to.map((n) => profile.contracts[n].address) : profile.contracts[to].address;
    if (JSON.stringify(got) !== JSON.stringify(want)) throw Error(`inconsistent binding: ${from}.${getter} must name ${[to].flat().join(",")}`);
  }
  return profile;
}

/* Exact bytes (UTF-8 text) in, validated profile out, only for the digest the caller already holds. */
export function parseAuthority(textIn, { expectedDigest } = {}){
  if (typeof expectedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw Error("an expected authority digest (sha256:<64 hex>) is required");
  if (typeof textIn !== "string") throw Error("authority profile text required");
  const bytes = new TextEncoder().encode(textIn);
  if (bytes.length > AUTHORITY_MAX_BYTES) throw Error("authority profile too large");
  const digest = "sha256:" + sha256Hex(bytes);
  if (digest !== expectedDigest) throw Error("authority profile digest mismatch: got " + digest);
  let value; try { value = JSON.parse(textIn); } catch { throw Error("malformed authority profile"); }
  if (encodeAuthority(value) !== textIn) throw Error("authority profile is not canonically encoded");
  return { digest, profile: validateAuthority(value) };
}

export const pinsOfAuthority = (profile) => Object.fromEntries(PIN_KEYS.map((k) => [k, profile.contracts[k].address]));

/* ---- on chain ----
   Everything the profile pins, at ONE agreed block of `reader` (js/core/quorum.js): every call needs `quorum` identical
   answers at that block hash, and an agreed revert is a fact ("!reverted"), never a pass. */
const sel = (name) => "0x" + keccak256Utf8(name + "()").slice(2, 10);
const words = (hex) => { const h = String(hex).replace(/^0x/, ""); const out = []; for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64)); return out; };
function decodeGetter(type, hex){
  const w = words(hex);
  const addr = (x) => (x && /^0{24}/.test(x)) ? "0x" + x.slice(24) : "!invalid";
  if (type === A) return w.length === 1 ? addr(w[0]) : "!invalid";
  if (type === B) return w.length === 1 && /^0{63}[01]$/.test(w[0]) ? w[0].endsWith("1") : "!invalid";
  if (type === U) return w.length === 1 ? BigInt("0x" + w[0]).toString() : "!invalid";
  if (type === T3) return w.length === 3 ? w.map(addr) : "!invalid";
  return "!invalid";
}

export async function observeAuthority(profile, reader, { snap = null, concurrency = 4 } = {}){
  snap ||= await reader.snapshot();
  const contracts = {}, tasks = [];
  for (const [name, layout] of Object.entries(AUTHORITY_LAYOUT)){
    const target = profile.contracts[name].address, row = contracts[name] = { codeHash: null, runtimeBytes: 0, immutable: {}, reviewedState: {} };
    tasks.push(async () => {
      const code = await reader.code(snap, target);
      if (code !== null && code !== undefined && (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(code))) throw Error("malformed code from the chain endpoints");
      if (code && code.length > 2 + 2 * MAX_RUNTIME_BYTES) throw Error("oversized code from the chain endpoints");
      if (code && code !== "0x"){ row.codeHash = keccak256Hex(code); row.runtimeBytes = (code.length - 2) / 2; }
    });
    for (const section of ["immutable", "reviewedState"]) for (const [getter, type] of Object.entries(layout[section])) tasks.push(async () => {
      try { row[section][getter] = decodeGetter(type, await reader.call(snap, target, sel(getter))); }
      catch (e){ if (!(e && e.revert)) throw e; row[section][getter] = "!reverted"; }
    });
  }
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, async () => { while (i < tasks.length) await tasks[i++](); }));
  return { blockNumber: snap.number, blockHash: snap.hash, timestamp: snap.timestamp, rpcs: snap.rpcs, contracts };
}

/* Every difference is a refusal; nothing observed is adopted (network/authority-profile.mjs checkObservation). */
export function authorityProblems(profile, observation){
  const problems = [];
  for (const [name, layout] of Object.entries(AUTHORITY_LAYOUT)){
    const want = profile.contracts[name], got = observation.contracts && observation.contracts[name];
    if (!got){ problems.push(name + ": not observed"); continue; }
    if (!got.codeHash){ problems.push(name + ": no deployed code at " + want.address); continue; }
    if (got.codeHash !== want.codeHash || got.runtimeBytes !== want.runtimeBytes) problems.push(name + ": code hash mismatch (" + got.codeHash + ")");
    for (const getter of Object.keys(layout.immutable))
      if (JSON.stringify(got.immutable[getter]) !== JSON.stringify(want.immutable[getter])) problems.push(`${name}.${getter}: binding mismatch (${JSON.stringify(got.immutable[getter])})`);
    for (const getter of Object.keys(layout.reviewedState))
      if (JSON.stringify(got.reviewedState[getter]) !== JSON.stringify(want.reviewedState[getter])) problems.push(`${name}.${getter}: reviewed mutable state changed (${JSON.stringify(got.reviewedState[getter])})`);
  }
  return problems;
}
