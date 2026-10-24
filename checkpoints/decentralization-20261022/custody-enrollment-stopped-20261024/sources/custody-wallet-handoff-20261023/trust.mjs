// Frozen public expectations for the metal0 host-owner enrollment handoff (two administrator stages). Every value is
// public. The source is evidence/metal0-enrollment-unsigned-20261023.json (block 52997498) and root's task text; the
// registry code hash is the one pinned for registry4 in work/lease-gas-wallet-signing/trust.mjs. Root's live preflight
// (preflight.mjs) re-reads all of it before anything is served. Tests use a fixture trust with the SAME shape and only
// the code hashes (and RPC URLs) replaced.
//
// Scope: these stages do NOT touch the custody vault, its committee, shares or policies, or the address book. The book
// activation (book-activation-unsigned-20261023.json) is deliberately EXCLUDED until the hardware lifecycle and
// dashboard checks pass; `excluded` exists only so tests can prove no stage can target it.
export const PRODUCTION = Object.freeze({
  chainId: 8453,
  admin: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61",             // Enclave administrator; signs both stages in MetaMask
  operator: "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab",          // existing metal0 registry operator (an EOA)
  ownership: "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7",         // ACTIVE EnclaveHostOwnership (not the 0xf5e9 variant)
  registry: "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac",          // registry4, ownership.registry()
  oracle: "0x420000000000000000000000000000000000000f",            // Base GasPriceOracle predeploy (L1 fee estimate)
  hostId: "0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be",
  hostEndpoint: "https://api.enclave.host/t/metal0",
  codeHashes: Object.freeze({
    ownership: "0xe38a0e160dd929c366bccd30636285458c288ada475f1b74ffc3289febf1d5dd",
    registry: "0x39911d6f53959c610b9108bb906fc36ea8f57016c4b2571b5cd52c9c32a6f518",
  }),
  fundingWei: 5_000_000_000_000n,  // fixed 0.000005 ETH; the operator held 376132087579 wei vs ~660247000000 needed
  caps: Object.freeze({
    maxFeePerGas: 100_000_000n,    // 0.1 gwei (Base base fee was 0.005 gwei)
    transferGas: 21_000n,          // exact: the operator must have no code
    acceptGas: 120_000n,           // acceptOwner gas limit cap (limit = estimate * 1.2)
    proposalGas: 150_000n,         // the operator's proposeOwner estimate must stay under this (it was 94321)
  }),
  confirmations: 2n,               // a receipt counts only with two later blocks, agreed on both providers
  maxAgeMs: 120_000,               // a preparation must finish within two minutes of starting
  rpcTimeoutMs: 10_000,            // per JSON-RPC request (one retry on transport errors / rate limits)
  deadlineMs: 60_000,              // whole preparation or verification
  rpcs: Object.freeze(["https://mainnet.base.org", "https://base.public.blockpi.network/v1/rpc/public"]),
  // never targeted by these stages (tests only)
  excluded: Object.freeze({ book: "0xab214342d5a490150a4a977063a2f88e21f80907", vault: "0xe48699b8401564aace7a814ae4569b67a3f7eef5" }),
});
