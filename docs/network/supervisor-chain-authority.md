# The Linux supervisor's chain consumers on the local verifier

`network/chain-authority.mjs`. This document lists what the operator's explicit selection of the local verifier changes in
`supervisor.js` and in the readers it runs, path by path, and the trust each answer actually has. It applies to relay-mode
guests (fw_cfg `chainVerifier`) and to direct control guests (the HOST_DATA-bound `chainVerifier` member);
`docs/network/local-chain-verifier.md` describes the runtime itself.

**Selection.** It is selected only with `ENCLAVE_CHAIN_AUTHORITY=verifier` plus `ENCLAVE_CHAIN_VERIFIER` (loopback). The
optional `ENCLAVE_CHAIN_TX_BACKEND` is the operator's own Base node at a loopback or private address literal.
- In a guest these names come only from gsup (`withChainVerifierEnv`), and from no other channel.
- An invalid selection gives an authority that refuses every method and action.
- Unset: the provider pool (`BASE_RPC(S)`, `RPC_POOL`) exactly as before. That is the legacy mode, kept for compatibility
  and never claimed as independent.

## Routing (`METHODS` in the module; everything else is refused by name)

| method | answered by | trust |
|---|---|---|
| `eth_call` | local verifier | executed locally over state proven against the block state root |
| `eth_estimateGas` | local verifier (searched here) | a gas **limit** at which a local execution over proven state succeeded, within 1.5% of the least such limit, at one numbered block. It is not the pinned Helios's own answer: that is the gas *used after refunds*, which is too little for a transaction that frees storage (a `release` sent with it runs out of gas), and it is answered even for a failing call. A call that fails at the block's gas limit answers with its revert |
| `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount` (a block) | local verifier | account/storage/code proof |
| `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_chainId` | local verifier | the sequencer-signed head chain (signed head or authenticated ancestry) |
| `eth_getTransactionReceipt`, `eth_getBlockReceipts` | local verifier | the receipts root of a verified block. "Not found" means only *no evidence* (never absence), so callers decide by the proven nonce |
| `eth_getTransactionByHash` | local verifier | the transaction taken from the validated body of its block (transactions root). None is no evidence |
| `eth_getLogs` | local verifier | each log proven against its block's receipts. **Inclusion only: completeness is not proven** |
| `eth_getTransactionCount` (`pending`) | own backend | pool hint |
| `eth_sendRawTransaction` | own backend, **after** binding it to the verifier (same chain id, same hash at the verifier's confirmed block) and a fresh head | submission only: inclusion is shown solely by a receipt the verifier checks |
| `eth_maxPriorityFeePerGas`, `eth_feeHistory`, `eth_gasPrice` | own backend | fee hint (cost, never validity) |

**Tier.** Everything is the **unsafe tier** (the sequencer-signed head chain), the same tier the provider path's "latest"
gave. No supervisor path asks for `safe` or `finalized`, and none is claimed. L1-derived finality would come from E's
full-node adapters (`createBaseNodeSource` + `createL1PairSource`, in-process evidence only). No supervisor decision
needs it.

**Freshness.** Helios refuses a stale head for "latest" reads. On top of that, `actionGate` requires a head no older than
60 s and, to submit, a bound backend:
- **Before signing**, in `sendOperatorTx`, `sendLeaseTx`, `signAndSendRelease` and `fenceNonce`. If the gate fails,
  nothing is signed, so no nonce is consumed.
- **Before every submission** (`eth_sendRawTransaction`), including the owner nominator's broadcast. The nominator signs
  first, as before, so for it only the broadcast refuses; its journal then retries.

## Path inventory (supervisor.js and its closure)

| path | reads | writes | under the verifier |
|---|---|---|---|
| ledger mirror: `syncLedger`/`fullResync`/`fetchLedger`, `readLedgerCount`, `readLedgerRowChunk` (multicall), `pinnedLedgerRow`, `openForUs`, `depsAbi` | `eth_call` | – | proven state. Held rows are re-read every tick, and a full state pass runs every `LEDGER_FULL_SEC` |
| ledger delta: `scanLedgerLogs` | `eth_getLogs` | – | inclusion-proven **hints**. A withheld log only delays discovery until the next proven full pass |
| claim decision: `claimHintAnswer` (simulate), `rateCapRefusal`, `priceFloorRefusal`, `feeGate`, `deny`/catalog (`catSchemaRev`), `registryEntry`/`registryRev` | `eth_call` | – | proven |
| host wallet admission (`hostAdmissionFromEnv`), platform host policy gate | the bundle's verifier authority | – | proven (already verifier-aware) |
| sessions (`createSessionApiAuth` pc) | `eth_call` | – | proven |
| admin AddressBook (`addressbook.js`) | a block-pinned verified snapshot | – | proven. **Book polling and admin migration are kept**; pins mode is unchanged |
| claim / renew / release (operator-paid) | prepare: pending nonce (backend), estimate (verifier), base fee (verifier), tip (backend) | `writeContract` → backend | gated; the receipt is verified |
| `awaitReceipt`, `resolveReleaseTx`, `checkBootTxFence` | receipt, nonce at a block (verifier), pending nonce (backend) | `fenceNonce` → backend | "no receipt" is decided by the **proven** nonce, never by absence |
| app-funded claim / renew / release (`loadLeaseGasConfig`, `createLeaseClient`, `resolveSigned`) | ONE verifier authority (`leaseRpcSet`: required 1, never mixed or repeated) | relays submit | landing = verified receipt; withheld logs fall to the proven nonce/deadline fences (consumed/expired, never success). The configured lease-gas `RPCS` are never contacted |
| owner nomination (`createOwnerNominator`) | the verifier (`clients: [chainClient]`) | broadcast → backend | gated |
| registry: `registerOnChain`, `syncRegisteredPrice`/`ProofKey`, heartbeat seam | `eth_call` | `sendOperatorTx` → backend | gated |
| claim bond: `claimBondReady` | `eth_call` | approve/postBond → backend | gated |
| proofs / settlement / payouts: `buildCheckpoints`/`planCheckpoints`, `proveLeases`, `proveFinalPeriod`, `payoutTick`, `settleLapsedLeases`, `stage` | `eth_call`, `getBlock` | `sendOperatorTx` → backend | gated |
| yank sweep / catalog moderation (`yankSweep`) | `eth_call` | releases (as above) | proven |
| prices: `ethUsdPrice8`, `refreshUsdcDomain` | `eth_call` | – | proven |
| payments: `pollPayments` (EnclavePay forwarder `Paid`/`PaidEth`) | `eth_getLogs` | – | inclusion-proven. **GATE G1:** a withheld payment event cannot be detected (a deployment stays awaiting payment: denial, never forgery or double credit). The forwarder keeps no per-payment state to read instead; closing it needs a log-completeness proof or a state-bearing payment record |

## Direct control guests

- **Binding.** The bound `chainVerifier` member is checked with the relay-mode checker. Its port must be in
  50000..57999 and distinct from every other port of the config, and it is bound by HOST_DATA.
- **Startup.** `planDirectBoot` refuses to boot if the image carries no runtime. Otherwise gsup starts the runtime before
  the direct supervisor.
- **Names.** The direct env's chain-authority names come only from that member.
- **MCP.** The hosted MCP adapter's profile gets the same verifier.
- **Statement.** It names the runtime record (`runtime.chainVerifierImageSha256`).
- **Unchanged:**
  - the config's required `rpcs`, which the supervisor does not use under the verifier;
  - the identity, admission and pins (direct guests have no address book by design);
  - the platform API member's `relayEnv`, which is identical on every member, so a per-host verifier cannot live there.

## Not provided here

- An L1-final tier for receipts.
- Log completeness: gate G1, payment detection.
- Submission independent of the operator's own Base node and the sequencer: E's forced-inclusion path is separate and
  not app-funded.
- Fresh proofs without a reachable state holder.
