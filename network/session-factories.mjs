// Reviewed SessionVault factories on Base: code identity and kind, for an explicit reviewed binding (pins, profile).
//   book   - the ORIGINAL production factory 0x1F5c… (legacy-sessions-v2, full match in
//            contracts/deployments/source-verification-base.json): its implementation resolves deployments/appCatalog
//            through the administrator's EnclaveAddressBook 0xab21…, so admin-directed migration is preserved and every
//            existing session vault keeps working.
//   pinned - the optional fixed-binding factory 0xEc92… (independent-authorities build): its implementation's "book" is
//            the PinnedSessionAuthority 0xF76A…. Not a required migration target.
// network/session-authority.mjs readSessionAuthority reads both through the same implementation/book interface; this table
// adds what it does not check: that the factory and implementation RUNTIMES are the reviewed ones and that the
// implementation's book is the reviewed book for that kind. A kind is never inferred from a failed read.
const lc = (a) => String(a || "").toLowerCase();
export const REVIEWED_SESSION_FACTORIES = Object.freeze({
  "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c": Object.freeze({
    kind: "book", production: true,
    codeHash: "0xc9b6214babb0126b26e818de8555c98b7e2a284b08a7cfd42f51b121e93d4f6c", runtimeBytes: 2208,
    implementation: "0x66c76a47209f44612343dbeab98b8ef77ad01f65",
    implementationCodeHash: "0x3dd35d4c4bdf112e2ded90da36a16510bfe938a0c9b8b9ed4414698323efb76e", implementationRuntimeBytes: 23664,
    book: "0xab214342d5a490150a4a977063a2f88e21f80907",
    evidence: "contracts/deployments/source-verification-base.json legacySessionVaultFactory/legacySessionVaultImplementation (full match, 4aea7d89)",
  }),
  "0xec9277a32f98ad3108747fe3da78c35e1bee097b": Object.freeze({
    kind: "pinned", production: false,
    codeHash: "0xf985ee527a6ae282a8ca8a67adcc0034faabe3d0317c6b989d7a95aa523a694c",
    implementation: "0x87bc7bfc8ca8b857fb43ebc6f4e49c807351ff5c",
    implementationCodeHash: "0xbd05cd680b27bd879809787189430fa3dd3789064004aff6347a3af53b9f9f31",
    book: "0xf76a138ceb162aa4bab47d4787793c569759cac8",
    evidence: "contracts/deployments/network-profile-base.json sessionVaultFactory/sessionVaultImplementation (compiled-runtime)",
  }),
});
export const PRODUCTION_SESSION_FACTORY = "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c";
export const sessionFactoryKind = (factory) => REVIEWED_SESSION_FACTORIES[lc(factory)]?.kind ?? null;

/** Read the identity facts of a factory at ONE explicit block (the caller obtains quorum agreement over the result). */
export async function readSessionFactoryIdentity(client, blockNumber, factory) {
  if (typeof blockNumber !== "bigint") throw Error("session factory identity requires an explicit block");
  const { keccak256 } = await import("viem");
  const abi = [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
               { type: "function", name: "book", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
  const code = async (address) => { const c = await client.getCode({ address, blockNumber }); return c && c !== "0x" ? c : "0x"; };
  const implementation = lc(await client.readContract({ address: factory, abi, functionName: "implementation", blockNumber }));
  const [fc, ic, book] = await Promise.all([code(factory), code(implementation), client.readContract({ address: implementation, abi, functionName: "book", blockNumber })]);
  return { factory: lc(factory), codeHash: keccak256(fc), runtimeBytes: (fc.length - 2) / 2, implementation,
           implementationCodeHash: keccak256(ic), implementationRuntimeBytes: (ic.length - 2) / 2, book: lc(book) };
}

/** Judge an observation of a factory against the reviewed table; returns { kind, production } or throws. */
export function checkSessionFactoryIdentity(factory, obs) {
  const r = REVIEWED_SESSION_FACTORIES[lc(factory)];
  if (!r) throw Error(`${factory} is not a reviewed SessionVault factory`);
  if (lc(obs?.codeHash) !== r.codeHash || (r.runtimeBytes && Number(obs?.runtimeBytes) !== r.runtimeBytes)) throw Error(`${factory} runtime differs from the reviewed ${r.kind} factory`);
  if (lc(obs?.implementation) !== r.implementation) throw Error(`${factory} implementation differs from the reviewed one`);
  if (lc(obs?.implementationCodeHash) !== r.implementationCodeHash || (r.implementationRuntimeBytes && Number(obs?.implementationRuntimeBytes) !== r.implementationRuntimeBytes))
    throw Error(`${factory} implementation runtime differs from the reviewed one`);
  if (lc(obs?.book) !== r.book) throw Error(`${factory} implementation book differs from the reviewed ${r.kind} book`);
  return { kind: r.kind, production: r.production };
}
