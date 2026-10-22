// Reviewed expectations for the 25-operation lease-gas enrollment (outputs/app-lease-gas-review/
// complete-bootstrap-funding-proposal.json). Every operation is REBUILT from these constants and the verified artifact
// ABI; the proposal file must match byte for byte in to/value/data/from/gas. Nothing here chooses an amount: the
// amounts below are the reviewed proposal's, and nothing is sent without root's gate (gate.mjs) and the approved pin.
import { PRODUCTION } from "../lease-gas-wallet-signing/trust.mjs";

export const ENROLLMENT = Object.freeze({
  chainId: 8453,
  admin: PRODUCTION.admin,                                          // sends all 25; must be a plain EOA (no 7702 code)
  book: PRODUCTION.book, oracle: PRODUCTION.oracle,
  ledger: PRODUCTION.ledger, registry: PRODUCTION.registry, codeHashes: PRODUCTION.codeHashes,
  // the confirmed setup (outputs/app-lease-gas-review/executor-binding-confirmed.json; root's three journals)
  reserve: "0x12a3f873041dec436daa0085b766a399a6fa3639",
  reserveRuntimeHash: "0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979",
  executor: "0x8900baca2167873ba2f8a8bae8b4876e6396d343",
  executorRuntimeHash: "0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2",
  delegationCodeHash: "0xe2f1317f7b76520f746c22fe4898b7ad32d7a6947a4c11a766fdcdd55bf88bbe",
  setupHashes: Object.freeze([                                      // reserve, executor, bind: never recorded here
    "0xf7304775d7f27b4aadff6370224a5116e5b75351e015c4675a46b40ee2a4f658",
    "0x5527ea1723caed79245a38b58750f70179bf6018e731ee9c6e466b2e57604d04",
    "0xa7472507e12f491827911e9daa91a15b2b5252f7dd8692a636d04e6574d54e33"]),
  // the DNS deployment's owner of record: a vault of the original SessionVault factory (network/lease-gas-owner.mjs)
  dnsVault: "0xb794c4dd0e1c5e6b72281799f282bfde7654345d",
  dnsOperator: "0x1a01194c34fe3577c6d0a54feb78af6253e494e0",
  vaultFactory: "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c",
  vaultFactoryCodeHash: "0xc9b6214babb0126b26e818de8555c98b7e2a284b08a7cfd42f51b121e93d4f6c",
  perAppWei: 100_000_000_000_000n, relayWei: 100_000_000_000_000n, totalWei: 1_300_000_000_000_000n,
  gasCaps: Object.freeze({ deposit: 0x493e0n, owner: 0x61a80n, transfer: 0x10000n }),
  policy: Object.freeze({ enabled: true, sponsorRelease: true, maxClaimsPerEpoch: 4, maxPerOpWei: "31092172031561", epochCapWei: "310921720315610",
    epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: "50000000" }),   // claimPolicy: 1 self-hosted, 2 allowlist
  // [deployment id, owner of record, display label] in the proposal's order; labels are display only
  apps: Object.freeze([
    ["0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9", "admin", "catalog 0xefc677…c8e6 v42"],
    ["0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c", "admin", "catalog 0xd8ec1d…a737 v85"],
    ["0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b", "admin", "catalog 0xa856a2…2094 v69"],
    ["0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33", "admin", "catalog 0x4306e5…7a7c v17"],
    ["0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a", "admin", "catalog 0x9afdfb…65ef v5"],
    ["0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371", "admin", "catalog 0x550d4d…eaf7 v4"],
    ["0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77", "admin", "catalog 0x5bca36…47bc v0"],
    ["0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c", "admin", "catalog 0xf1897f…d03a v3"],
    ["0xc13d4b6a613ba277e9a8559adb76b2f60394ef16649f7a623e8a7a6c4f097681", "admin", "catalog 0xfd4206…2b28 v5"],
    ["0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238", "admin", "catalog 0x093fa9…75c6 v7"],
    ["0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", "dnsVault", "EnclaveDNS upstream (catalog 0x85f28c…ab06 v4)"],
  ]),
  // root's relay identities (outputs/app-lease-gas-review/lease-relay-identities.json): address = keccak(pubkey)[12:]
  relays: Object.freeze([["us-west", "0x51ff183da8ff3b2de08da88331eed65e2f6a835c"], ["eu-central", "0xc5d88d2d1c898fcacdce965cbe2f1c3cd38bb26a"]]),
  reviewedFiles: Object.freeze({                                     // sha256 of the companion files this queue was reviewed against
    enrollment: "3e79f6a6b0c74475810e47203633a16315496a1c1e98224b957e3010c692fe48",
    identities: "362a2790a515a7208beffa16fe5b53ac70a395102b90d8ede34f1e0d6e4432b5",
  }),
  rpcs: PRODUCTION.rpcs,
  receiptRpcs: Object.freeze(["https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"]),
  maxFeePerGas: PRODUCTION.caps.maxFeePerGas, confirmations: PRODUCTION.confirmations, maxAgeMs: PRODUCTION.maxAgeMs,
});
