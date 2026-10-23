# Self-hosted ERC-4337 bundler (and optional paymaster) for passkey accounts: prerequisites and launch recipe

**Status: NOT STARTED in this tree.** No bundler or paymaster service exists in this tree. Nothing here is deployed.

**Ownership (root, `ROOT-BUNDLER-IMPLEMENTATION-OWNER.txt`).** P now owns the real self-hosted **Alto** service, in
`work/rpc-bundler-service-20261023`. This document does not duplicate it. It states what the browser path requires, plus
the endpoint and funding dependencies.

**Primary sources.** Root verified them in
`outputs/decentralization-audit/bundler-primary-source-review-20261023.json` (2026-10-23T11:44Z):
- Pimlico's self-host docs (https://docs.pimlico.io/references/bundler/self-host): Alto supports local RPC configuration,
  EntryPoint v0.7, an OP-stack chain mode, funded utility/executor wallets, and `debug_traceCall` for safe-mode
  validation.
- Alto's `src/cli/config/options.ts`: safe mode defaults to true. This is mutable `main`, not a release pin.
- Rundler's README: v0.7 and Base support. Not needed here.

**Root's decision:** one pinned Alto service with safe-mode validation; no provider or hosted-bundler fallback; no
deployment or funds. Whether the pinned backend's tracer is compatible remains **P's test**.

What the dashboard already does: it lets the owner name their own bundlers and paymaster per account
(`transport` in the account profile) and refuses everything else. See "Already supported" in
`RESULT-WALLET-DEPENDENCY.md`.

A URL field is not a bundler. This document lists what a real one needs.

## What the page requires from a bundler (from source, `site/js/core/account-transport.js` and `passkey-account.js`)

| Requirement | Exact value |
| --- | --- |
| Account | Safe v1.4.1, Safe4337Module v0.3.0, passkey signer v0.2.1 (`PROVIDERS["safe-passkey"]`, code hashes pinned at Base block 52,836,800) |
| EntryPoint | **v0.7** `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. The transport validator refuses any other EntryPoint, and v0.6 (`0x5FF137D4…`) is refused. |
| Chain | Base mainnet, 8453 |
| JSON-RPC methods called, and nothing else | `eth_maxPriorityFeePerGas` (capped at 2 gwei by the page), `eth_estimateUserOperationGas`, `eth_sendUserOperation`; the paymaster service gets ERC-7677 `pm_getPaymasterStubData` and `pm_getPaymasterData` |
| Operation format | v0.7 unpacked RPC form: `factory`/`factoryData`, and split `paymaster*` fields |
| Transport | HTTPS from the browser (`fetch`, `credentials: "omit"`, `redirect: "error"`), so CORS must allow `POST` + `content-type` from the dashboard origin. Loopback `http` is accepted only for a bundler on the owner's own machine. |
| Not required | `eth_getUserOperationReceipt` and `eth_getUserOperationByHash`: the page never asks. The outcome is the EntryPoint's own `UserOperationEvent`, read through the profile's quorum RPCs. |

## What the bundler process itself needs (the actual missing pieces)

1. **A bundler implementation that supports EntryPoint v0.7 and OP-stack L1 data fees.**
   - Alto, per the primary sources above. P is preparing it.
   - The in-tree `test/helpers/local-bundler.mjs` is **test-only**: no ERC-7562 rules, fixed estimates, no mempool, no
     L1 data-fee accounting. It must not be deployed.
2. **A Base node RPC for the bundler** (S's Base holder: base v1.5.1 / base-reth). The bundler needs `eth_call`,
   `eth_estimateGas`, the fee methods and `eth_sendRawTransaction`.
   - **Safe mode** (ERC-7562 validation-rule tracing; Alto's default, and root's decision) also needs `debug_traceCall`
     with the tracer Alto uses. Whether S's base-reth build provides it is **P's test**, not verified here.
   - Unsafe mode is **not** the plan: root ruled to keep safe-mode validation.
   - The page independently simulates the exact signed operation through `EntryPoint.handleOps` at an agreed block
     before sending. That protects the owner; it does not replace the bundler's validation.
   - The bundler's RPC is node-local. It is not the browser profile's quorum, and it is S's ingress, not this page's.
3. **An executor (submitter) EOA on Base, funded with ETH.**
   - It fronts the gas of `handleOps` and is repaid in the same transaction by the EntryPoint (beneficiary = executor).
     The repayment comes from the account's prefund (the account's ETH or EntryPoint deposit) or from the named
     paymaster's deposit.
   - Funding needed: at least one bundle's worst case, `(verificationGasLimit + callGasLimit + preVerificationGas
     [+ paymaster limits]) × maxFeePerGas`, plus the executor's own transaction overhead. The page caps the limits at
     3M + 10M + 1M (+ 1M + 1M) = 16M gas. Worked examples:
     - About 0.00018 ETH at maxFee ≈ 0.011 gwei (a 0.005-gwei base fee doubled, plus a 0.001-gwei tip).
     - About 0.032 ETH if the bundler quotes the page's 2-gwei tip cap.

     Actual use is gas used × effective price, far below these limits.
   - On Base, the L1 data fee is charged to the executor's transaction. It is recovered only if `preVerificationGas`
     covers it, which is what the OP-stack mode of the bundler computes.
   - **Funding it is a real spend.** It needs a human/root decision. Nothing here authorizes it.
   - The key must be a hot key in the bundler host's custody. It never touches the page, and the page never sees it.
4. **A submission route.**
   - base-reth runs with transaction gossip disabled and forwards `eth_sendRawTransaction` to the Base sequencer. So a
     self-hosted bundler still reaches the chain only through the sequencer. That is the protocol's own path, not a
     public RPC provider.
   - The censorship-resistant alternative is an L1 `OptimismPortal.depositTransaction` carrying the same `handleOps`
     calldata from an L1 EOA (see `work/rpc-transaction-independence`). This is plausible and **untested**:
     - EntryPoint v0.7 does not restrict its caller.
     - The repayment is priced from the operation's own fee fields, not `tx.gasprice`.
     - The L1 gas is a separate L1 spend.
5. **Paymaster (optional; the account can pay in ETH itself).**
   - A self-hosted ERC-7677 paymaster needs a paymaster **contract** deployed on Base with an EntryPoint deposit, plus
     stake if the bundler enforces reputation, and a signing service.
   - **That is a new contract deployment.** Excluded here; it needs a separate decision.
   - The page already accepts any owner-named paymaster: only that address, and its deposit must cover the operation.

## Launch recipe (for whoever is authorized to run it; each step needs root approval)

1. **On S's Base node:**
   - Confirm `eth_chainId` = `0x2105` and that it is synced.
   - Probe `debug_traceCall` with Alto's tracer (P's test). Safe mode is required.
2. **Build Alto from a pinned release, offline, reproducibly** (P's scope; a new dependency that needs approval). Configure
   it with:
   - `entrypoints` = `0x0000000071727De22E5E9d8BAf0edAc6f37da032` only;
   - chain = Base / OP-stack L1-fee mode;
   - RPC = the local Base node;
   - one executor key (host custody);
   - its minimum executor balance set at or above the worst case above.
3. **Expose only `/rpc` over HTTPS** on a name the owner controls (not only `*.enclave.host`: the page refuses a transport
   whose bundlers are all Enclave-operated).
   - CORS: `POST`, `content-type`, the dashboard origin(s).
   - Method allowlist: exactly `eth_chainId`, `eth_supportedEntryPoints`, `eth_maxPriorityFeePerGas`,
     `eth_estimateUserOperationGas`, `eth_sendUserOperation` (plus `eth_getUserOperationReceipt` if other clients need
     it).
   - Never expose debug or admin methods.
4. **Fund the executor** (a spend: human decision).
5. **Owner side, in the dashboard (Passkey account → Gas transport):**
   - Name that URL, plus at least one other operator's bundler for failover. The page tries them in order, and moves on
     only after a refusal or no answer.
   - Choose "the account pays its own gas through your bundler".
6. **Acceptance before calling it deployed:**
   - one real operation on Base mainnet;
   - its `UserOperationEvent` read through the profile;
   - executor balance before and after (repaid);
   - a refusal case (an underfunded account is refused before signing).

   A fixture or anvil fork run does **not** prove mainnet inclusion.
