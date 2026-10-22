// Reviewed EnclaveSecretVaultV2 deployments on Base: code identity and the explicit reader kind each needs.
//   book   - the ORIGINAL vault (contracts/EnclaveSecretVaultV2.sol): registry, ledger and session factory follow the
//            administrator's EnclaveAddressBook at every call; this is the production custody vault.
//   pinned - the optional pinned-authority variant (contracts/variants/): immutable bindings, reviewed by the authority
//            profile (contracts/deployments/network-profile-base.json); no production committees or policies.
// A kind is chosen by this table (or a measured pin), never inferred from a failed read. Evidence for each entry:
//   0xE486…: work/existing-custody-audit/evidence/original-source-verification.json (full match, metadata included).
//   0x56b8…: contracts/deployments/independent-authorities-base.json (verified compiled runtime).
const lc = (a) => String(a || "").toLowerCase();
export const REVIEWED_CUSTODY_VAULTS = Object.freeze({
  "0xe48699b8401564aace7a814ae4569b67a3f7eef5": Object.freeze({
    kind: "book", production: true, chainId: 8453,
    codeHash: "0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b", runtimeBytes: 19719,
    immutable: Object.freeze({ book: "0xab214342d5a490150a4a977063a2f88e21f80907", enclaveOwner: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61" }),
    // the deployed EnclaveHostOwnership the accepted host wallet is read from (bound to the book's current registry)
    hostOwnership: "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7",
    source: Object.freeze({ path: "contracts/EnclaveSecretVaultV2.sol", commit: "e4e0459413d10c0e2fd1eb85828c79e018b7528c",
      gitBlob: "7a385bbcc7914b495c7b7e5c312b3e547119ee11", sha256: "2c7692ec13db18f567b3fa469db5931cfc4451540092259a0d28b651468a4469" }),
  }),
  "0x56b81b3970a8ac2c52f9874bd2758ede30758228": Object.freeze({
    kind: "pinned", production: false, chainId: 8453,
    codeHash: "0xb27f04b1bc81e2db3e6913c84016f1f2b75083abe5a87dcc65afafcc207a48c5", runtimeBytes: 21956,
    immutable: Object.freeze({ book: "0xf76a138ceb162aa4bab47d4787793c569759cac8", enclaveOwner: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61",
      hostOwnership: "0xf5e9e6c02449001f6e8e95e5d87413f2cb6790ea" }),
    source: Object.freeze({ path: "contracts/variants/EnclaveSecretVaultV2PinnedAuthorities.sol", unitName: "EnclaveSecretVaultV2.sol",
      sha256: "fc43ab52da0bca1fb62e0289a254332b49faea0990322ab39dbd03d4d8e2ef9b" }),
  }),
});
export const PRODUCTION_CUSTODY_VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";

/** The reader options for a reviewed vault ({ vaultKind, book, hostOwnership }), or null for an unreviewed address. */
export function custodyVaultKind(address) {
  const r = REVIEWED_CUSTODY_VAULTS[lc(address)];
  if (!r) return null;
  return r.kind === "book" ? { vaultKind: "book", book: r.immutable.book, hostOwnership: r.hostOwnership } : { vaultKind: "pinned" };
}

/** Judge an agreed-block observation { codeHash, runtimeBytes, book, enclaveOwner, hostOwnership? } of a reviewed vault. */
export function checkCustodyVaultIdentity(address, obs) {
  const r = REVIEWED_CUSTODY_VAULTS[lc(address)];
  if (!r) throw Error(`${address} is not a reviewed EnclaveSecretVaultV2`);
  const hash = lc(obs?.codeHash);
  if (hash !== r.codeHash || Number(obs?.runtimeBytes) !== r.runtimeBytes) throw Error(`${address} runtime differs from the reviewed ${r.kind} vault`);
  for (const [k, v] of Object.entries(r.immutable)) if (lc(obs?.[k]) !== v) throw Error(`${address}.${k} differs from the reviewed value`);
  return custodyVaultKind(address);
}
