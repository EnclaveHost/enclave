// relay/wallet-session-manifest.mjs -- code identity for the wallet-session protocol (contracts/WalletSessionVault.sol,
// WalletSessionProfile.sol, the linked SessionVaultLib). NEW in wallet-owned-session-repair-r2; not run, not tested.
//
// A deployed contract is recognised ONLY by comparing its runtime bytes with a REVIEWED compiled artifact: the exact
// length, and keccak256 of the bytes with precisely the artifact's own immutable / library-link / library-self ranges
// zeroed (solc deployedBytecode.immutableReferences and linkReferences, read by tools/build-wallet-session-manifest.mjs).
// Nothing else is normalised: any other differing byte is a different contract. The values at those ranges are then
// returned so the caller checks every binding (ledger, factory, profile, library) against chain-derived identities.
//
// The manifest itself is GENERATED from qualified compiler output by root (relay/wallet-session-protocol.mjs). Until
// then it is null and every contract-created wallet-session row is UNRESOLVED (refused), never legacy.
//
// No bare package import: the Windows node ships this file under relay/ WITHOUT node_modules (windows/node/deploy-files.mjs
// refuses bare imports outside windows/node). viem is injected by the importer (wallet-session-policy.mjs useViem).

const V = {};
/** called by wallet-session-policy.mjs useViem */
export function useViemForManifest(viem) {
  for (const k of ["keccak256", "hexToBytes", "bytesToHex", "getAddress"]) {
    if (typeof viem?.[k] !== "function") throw new Error(`wallet-session manifest: viem.${k} missing`);
    V[k] = viem[k];
  }
}
const need = () => { if (!V.keccak256) throw new Error("wallet-session manifest: viem was not injected (useViem)"); };

export const MANIFEST_FORMAT = "enclave.wallet-session.manifest/1";
export const ARTIFACTS = ["factory", "vault", "profile", "library"];
// the immutables each artifact MUST declare (contracts/WalletSessionVault.sol, contracts/WalletSessionProfile.sol)
export const REQUIRED = {
  factory: { immutables: ["implementation", "ledger", "profile"], links: [] },
  vault: { immutables: ["usdc", "book", "router", "factory", "keyAttestations", "maxVault6", "ledger"], links: ["SessionVaultLib"] },
  profile: { immutables: ["deployments", "appCatalog"], links: [] },
  library: { immutables: [], links: [] },
};
const ADDRESS_IMMUTABLES = new Set(["implementation", "ledger", "profile", "usdc", "book", "router", "factory",
  "keyAttestations", "deployments", "appCatalog"]);

const CLONE_HEAD = "363d3d373d3d3d363d73", CLONE_TAIL = "5af43d82803e903d91602b57fd5bf3";

/** EIP-1167 minimal proxy runtime (exactly 45 bytes) -> its implementation, else null */
export function cloneImplementation(code) {
  need();
  const c = String(code || "").toLowerCase().replace(/^0x/, "");
  if (c.length !== 90 || !c.startsWith(CLONE_HEAD) || !c.endsWith(CLONE_TAIL)) return null;
  return V.getAddress("0x" + c.slice(20, 60));
}

/** EIP-7702 delegation designator (0xef0100 || address): an EOA, whatever it delegates to */
export function isDelegatedEoa(code) { return /^0xef0100[0-9a-f]{40}$/.test(String(code || "").toLowerCase()); }

export const isEmptyCode = (code) => !code || code === "0x";

function ranges(list, len, what) {
  if (!Array.isArray(list) || !list.length) throw new Error(`manifest: ${what} has no ranges`);
  return list.map((r) => {
    const [start, length] = r;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || (length !== 20 && length !== 32)
        || start + length > len) throw new Error(`manifest: ${what} range [${start},${length}] is out of bounds`);
    return [start, length];
  });
}

/** throws unless `m` is a well-formed manifest; returns a normalised copy (ranges bounded and non-overlapping) */
export function validateManifest(m) {
  if (!m || m.format !== MANIFEST_FORMAT) throw new Error(`manifest: format is not ${MANIFEST_FORMAT}`);
  if (!/^0x[0-9a-f]{64}$/.test(String(m.protocol || ""))) throw new Error("manifest: protocol is not a bytes32");
  const out = { format: m.format, protocol: m.protocol, artifacts: {} };
  for (const name of ARTIFACTS) {
    const a = m.artifacts?.[name];
    if (!a) throw new Error(`manifest: artifact ${name} is missing`);
    if (!Number.isSafeInteger(a.codeLength) || a.codeLength <= 0 || a.codeLength > 24576) throw new Error(`manifest: ${name} codeLength`);
    if (!/^0x[0-9a-f]{64}$/.test(String(a.maskedHash || ""))) throw new Error(`manifest: ${name} maskedHash`);
    const imm = {}, links = {};
    for (const k of REQUIRED[name].immutables) imm[k] = ranges(a.immutables?.[k], a.codeLength, `${name}.${k}`);
    for (const k of Object.keys(a.immutables || {})) if (!(k in imm)) throw new Error(`manifest: ${name} has unexpected immutable ${k}`);
    for (const k of REQUIRED[name].links) links[k] = ranges(a.links?.[k], a.codeLength, `${name} link ${k}`);
    for (const k of Object.keys(a.links || {})) if (!(k in links)) throw new Error(`manifest: ${name} has unexpected link ${k}`);
    for (const k of Object.keys(links)) if (links[k].some(([, l]) => l !== 20)) throw new Error(`manifest: ${name} link ${k} is not 20 bytes`);
    for (const k of Object.keys(imm)) if (imm[k].some(([, l]) => l !== 32)) throw new Error(`manifest: ${name}.${k} is not a 32-byte word`);
    const self = name === "library" ? ranges(a.self, a.codeLength, "library.self") : [];
    if (self.some(([, l]) => l !== 20)) throw new Error("manifest: library.self is not 20 bytes");
    const all = [...Object.values(imm).flat(), ...Object.values(links).flat(), ...self].sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < all.length; i++) if (all[i][0] < all[i - 1][0] + all[i - 1][1]) throw new Error(`manifest: ${name} ranges overlap`);
    out.artifacts[name] = { codeLength: a.codeLength, maskedHash: a.maskedHash.toLowerCase(), immutables: imm, links, self };
  }
  return out;
}

/**
 * Does runtime `code` match artifact `a` (validated)? -> { codeHash, immutables: { name: 0x<32 bytes> | address },
 * links: { name: address }, self: address|null } or null (NOT this artifact: a definitive answer, never a read error).
 */
export function matchArtifact(code, a) {
  need();
  if (isEmptyCode(code)) return null;
  const b = V.hexToBytes(code);
  if (b.length !== a.codeLength) return null;
  const masked = new Uint8Array(b);
  const take = (list) => {
    const vals = list.map(([s, l]) => V.bytesToHex(b.subarray(s, s + l)));
    for (const [s, l] of list) masked.fill(0, s, s + l);
    return vals.every((v) => v === vals[0]) ? vals[0] : undefined;   // every reference of one immutable is the same value
  };
  const immutables = {}, links = {};
  for (const [k, list] of Object.entries(a.immutables)) {
    const v = take(list);
    if (v === undefined) return null;
    if (ADDRESS_IMMUTABLES.has(k)) {
      if (!/^0x0{24}[0-9a-f]{40}$/.test(v)) return null;          // an address immutable is a left-zero-padded word
      immutables[k] = V.getAddress("0x" + v.slice(26));
    } else immutables[k] = v;
  }
  for (const [k, list] of Object.entries(a.links)) { const v = take(list); if (v === undefined) return null; links[k] = V.getAddress(v); }
  let self = null;
  if (a.self.length) { const v = take(a.self); if (v === undefined) return null; self = V.getAddress(v); }
  if (V.keccak256(masked).toLowerCase() !== a.maskedHash) return null;
  return { codeHash: V.keccak256(code).toLowerCase(), immutables, links, self };
}

/** the shipped, root-generated manifest (relay/wallet-session-protocol.mjs), validated; null when not generated */
export async function loadShippedManifest() {
  const { WALLET_SESSION_PROTOCOL_MANIFEST: m } = await import("./wallet-session-protocol.mjs");
  return m ? validateManifest(m) : null;
}
