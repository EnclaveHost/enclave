// Frozen public expectations for the ONE administrator transaction:
//   EnclaveAddressBook(0xab21…).set("sessionVaultFactory", original SessionVaultFactory 0x1f5c…), from the book owner.
// Every value is public and comes from root's evidence (no getter is guessed):
//   evidence/factory-activation-unsigned-20261023.json (copy of custody-v2-live-20261023/evidence, block 52998223): the
//     transaction, factory, implementation, factory/implementation code hashes, book owner;
//   existing-custody-audit/evidence/live-custody.json (block 52849851): book, v1 and v2 vault runtime hashes;
//   existing-custody-audit/evidence/session-factory-identity.json (block 52851588): factory -> implementation, impl.book;
//   evidence/consumer-review-state-impact.json (custody-factory-consumer-review-20261023 @519489c, block 52999031): the
//     ledger the book names and the four deployments held by a vault of this factory (the administrator's SessionVault).
// The ledger's runtime hash is NOT in that evidence: it is read and must agree on both providers, but it is not pinned.
// Tests use a fixture trust with the SAME shape and only code hashes, RPC URLs and timeouts replaced.
export const PRODUCTION = Object.freeze({
  chainId: 8453,
  admin: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61",          // the book owner; signs in MetaMask
  book: "0xab214342d5a490150a4a977063a2f88e21f80907",           // the ORIGINAL EnclaveAddressBook
  key: "sessionVaultFactory",                                   // the only key this handoff can set
  factory: "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c",        // the original SessionVaultFactory (the value set)
  implementation: "0x66c76a47209f44612343dbeab98b8ef77ad01f65", // factory.implementation()
  ledger: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b",         // book.addr("deployments")
  vaults: Object.freeze({ v1: "0x08074300f75e78212ae10ebd14984f78e17811a6", v2: "0xe48699b8401564aace7a814ae4569b67a3f7eef5" }),
  oracle: "0x420000000000000000000000000000000000000f",         // Base GasPriceOracle predeploy (L1 fee)
  codeHashes: Object.freeze({
    book: "0xe4f570e99f2ac708b35539fe5906889d8cb99189e6c9075f5e46d3b6921ac152",
    factory: "0xc9b6214babb0126b26e818de8555c98b7e2a284b08a7cfd42f51b121e93d4f6c",
    implementation: "0x3dd35d4c4bdf112e2ded90da36a16510bfe938a0c9b8b9ed4414698323efb76e",
    v1: "0x0179140ae024eeea5bd0228909532c2c16735b571dd133781c37eee1bcf32a72",
    v2: "0x4b949b378382d7fa862e7bc1552b58547ce811527c9746f4d9a0d39a8b4f716b",
  }),
  // reviewed: the ONLY deployments whose owner this activation re-resolves (held by the administrator's SessionVault,
  // no policy in either vault at block 52999031). Any other effect, or another such deployment, refuses: re-review first.
  sessionVault: "0xb794c4dd0e1c5e6b72281799f282bfde7654345d",
  reviewedVaultHeld: Object.freeze([
    "0xcab8fb59882d976bf4005448701149d734b0dab536d9bf46f2b5159b0b0819e9",
    "0xa62e13de22559ee9a6ce1798891ab3506ac8e1b1eca296ff749cfcd7ab4fc640",
    "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c",
    "0x87508b958c4d14381b58fe05a781efbd3f185a36d5239abdf37e8f242f944538",
  ]),
  caps: Object.freeze({
    maxFeePerGas: 100_000_000n,   // 0.1 gwei (Base base fee was 0.005 gwei)
    setGas: 120_000n,             // book.set gas limit cap (limit = estimate * 1.2)
    maxLedgerIds: 2000,           // the exhaustive impact read refuses a ledger larger than this (bounded work)
    batch: 120,                   // calls per batched read
  }),
  confirmations: 2n,
  maxAgeMs: 120_000,
  rpcTimeoutMs: 10_000,
  deadlineMs: 90_000,
  rpcs: Object.freeze(["https://mainnet.base.org", "https://base.public.blockpi.network/v1/rpc/public"]),
  // never set by this handoff (tests only): the separate, later secretVaultV2 activation
  excludedKeys: Object.freeze(["secretVaultV2", "secretVault", "deployments", "registry"]),
});
