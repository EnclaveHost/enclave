// Production expectations for the lease-gas setup handoffs (stages 2 and 3). The same values as root's
// work/lease-gas-production-preflight/read.mjs and the accepted contract review; tests pass a fixture `trust` with
// the SAME shape and locally pinned code hashes. Nothing here is a funding destination.
export const PRODUCTION = Object.freeze({
  chainId: 8453,
  admin: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61",            // EnclaveAddressBook owner; signs all three setup steps
  book: "0xab214342d5a490150a4a977063a2f88e21f80907",             // its owner() must still be the admin
  ledger: "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B",           // ledger16d (unchanged)
  registry: "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC",         // registry4 (unchanged)
  oracle: "0x420000000000000000000000000000000000000F",           // Base GasPriceOracle predeploy
  codeHashes: Object.freeze({
    ledger: "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682",
    registry: "0x39911d6f53959c610b9108bb906fc36ea8f57016c4b2571b5cd52c9c32a6f518",
  }),
  acceptedSources: Object.freeze({                                  // sha256 of the accepted additive sources (main repo)
    EnclaveLeaseGasReserve: "1d173473a4681c8504a264cc51ee486c37c2d3919fe133c6c744ad514ea311e2",
    EnclaveLeaseExecutor: "dc605ffa6e2e2252760f417cd9f4f0a75a2f26399e0a837163da2108dda10033",
  }),
  rpcs: Object.freeze(["https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"]),   // root's current serve-reserve.mjs pair
  caps: Object.freeze({ maxFeePerGas: 1_000_000_000n, executorGas: 2_000_000n, bindGas: 300_000n }),
  confirmations: 2n,             // a receipt counts only with two later blocks, as root's verifyReserve requires
  maxAgeMs: 120_000,             // a prepared request expires two minutes after its anchor was read
  maxNonceScan: 64,              // admin transactions inspected between the reserve's creation and now
});
