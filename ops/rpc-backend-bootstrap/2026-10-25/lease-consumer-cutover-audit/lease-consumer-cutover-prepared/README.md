# Lease-consumer cutover: prepared candidate (NOT production approval; HOLD stays)

- **Method:** read-only, from `relay-consumer-source` `81ba668531d17151db810e14562c77a672d742e4` and the public/observed fields of `consumer-cutover-plan-2205/`.
- **Not done:** no secret configs, tests, queue use, SSH, network access, live changes or commits; no product code was edited.
- **Not changed:** the canonical, finality, tier and admin guards.

## 1. Production constructor and env field names (traced)

| Consumer | Lease client built at | Authority source | Lease env fields |
|---|---|---|---|
| **Guest supervisor** (Metal0 control → guest) | `supervisor.js:10209-10212`: `loadLeaseGasConfig({ env: leaseGasEnv, …, chainAuthority: CHAIN_AUTHORITY })` → `configuredLeaseSender` | `CHAIN_AUTHORITY = chainAuthorityFromEnv(process.env)` (`supervisor.js:327-331`); the guest gets `ENCLAVE_CHAIN_AUTHORITY=verifier` + `ENCLAVE_CHAIN_VERIFIER` from the control's `chainVerifier` (`metal/guest/chain-verifier.mjs:31, :160`; host check `metal/enclave-metal.mjs:261-265, :296`) | `leaseGasEnv` = `^(ENCLAVE_)?LEASE_GAS_` keys (`supervisor.js:10197`), produced by the conduit from `config.leaseGas` (`network/lease-gas-conduit.mjs` `leaseGasGuest`, env at its `:6-8`; `metal/guest/measured-control.mjs:539, :688`). The fields are `FILE`, `DIGEST`, `RPCS`, `RELAYS`, `LOCAL_RELAY`, `PINNED_RELAYS`, `SERVICE_INDEX`, `RELAY_EXCLUDE`, `RESERVE`, `QUORUM` (`network/lease-gas-runtime.mjs:21-22`). |
| **Windows node** | `windows/node/chain.mjs:271-276`: `loadLeaseGasConfig({ env: leaseGasEnv, ...leaseBindings() })` (**no** `chainAuthority`) | `chainAuthorityFromEnv(leaseGasEnv)` inside `loadLeaseGasConfig` (`lease-gas-runtime.mjs:59`). But `leaseGasEnv` holds **only** `(ENCLAVE_)LEASE_GAS_*` (`chain.mjs:258-259`), and the authority variable is `ENCLAVE_CHAIN_AUTHORITY` (`network/chain-authority.mjs:21`), so the authority is **always null** | Same fields, prefixed `ENCLAVE_LEASE_GAS_` or `LEASE_GAS_` |
| Lease relay (eu-central) | `network/lease-relay-service.mjs:68` → `startLeaseRelay` | C3 delta: `ENCLAVE_CHAIN_AUTHORITY=verifier` (lease-relay-source `433f04fa1` refuses mixed selections) | unchanged; see `consumer-cutover-plan-2205/candidates/C3-lease-relay.env.delta` |

**Under verifier authority:** the lease client set is `[authority.client]` (`lease-gas-runtime.mjs:96`). `leaseRpcSet` refuses mixing or repeating it (`client/lease-executor-authority.mjs:52`, "the local verifier is one authority, never a quorum member"). Configured `RPCS` are then **never contacted** (`lease-gas-runtime.mjs:52-54, :60`).

## 2. Templates (`templates/`; explicit `<UNRESOLVED: …>` values, no invented endpoints)

| Template | Target | Status |
|---|---|---|
| `T1-metal0-control.chainVerifier+leaseGas.merge-patch.TEMPLATE.json` | `metal/config.json`: adds `chainVerifier` (proof source unresolved); `leaseGas` relays and funding, admin and every other member unchanged | **Mixed-quorum removal is not possible by config:** the conduit requires ≥ 2 distinct https `rpcs` and a strict-majority quorum (`lease-gas-conduit.mjs:51-60, :93-95`). Under the verifier they stay present but unused. |
| `T2-windows-node.env.TEMPLATE` | the Windows host env | **Not effective in the current source** (code gap in §1): setting `ENCLAVE_CHAIN_*` does not reach the lease path |

## 3. Prerequisites (current release vs candidate code)

| # | Prerequisite | Evidence |
|---|---|---|
| P1 | A Metal0 **control release that implements `chainVerifier`.** The running `metal-deabf8f90` has 0 occurrences; the staged reviewed candidate is `dist-rpc-ec56a70f1`. A guest relaunch is required. | `consumer-cutover-plan-2205/candidates/C2-…json` `_requires` |
| P2 | **A reviewed live own-RPC proof source** for the control verifier. The `rpc-<b32>` role is not live, and no public HTTPS RPC route exists yet. | C2 `_requires`; `README.md` blocker 3 |
| P3 | **Code change, only if root requires no public RPC URL even as unused config:** the conduit must accept a `leaseGas` without `rpcs` when `chainVerifier` is bound, with a regression. Otherwise root must explicitly decide whether present-but-unused public URLs are acceptable. They are not contacted under the verifier (`lease-gas-runtime.mjs:52-54`); I do **not** make that decision. | `lease-gas-conduit.mjs:51, :93-95` |
| P4 | **Windows code change:** pass the host chain authority into `loadLeaseGasConfig` at `windows/node/chain.mjs:272` (as `supervisor.js:10211` does), plus a release. Until then Windows leases stay on the public `LEASE_GAS_RPCS` quorum, whatever env is set. | §1 |
| P5 | The canonical Helios candidate (`eeffcc9` + `41667ec9`) with its root test runs; Base own-node readiness (A2–A4); the C3 relay placement decision. | `canonical-consumer-depth-audit/REPORT.md`; C3 blockers |

## 4. Own RPC or verifier down: fail closed (traced)

- **Invalid selection:** an invalid authority selection gives `refusingChainAuthority`. Every chain read and transaction refuses, and no provider is used (`supervisor.js:327-331`).
- **Before signing:** `chainActionGate` requires a fresh verifier head, and for a submit a bound own backend (`supervisor.js:339-340`). Releases call it before signing (`supervisor.js:10630`).
- **Under the verifier there is no second voter:** a verifier outage means lease reads fail. Sponsored operations then refuse, and "this host's ETH is never used instead" (`windows/node/chain.mjs:287`; the same rule in the runtime header).
- **Rollback must not add public hosts beside a verifier.** Mixed selections are refused by design (C2/C3; `client/lease-executor-authority.mjs:52`).

## 5. Rollback (per consumer)

1. **Save first:** before each step, save the exact live file (record its sha256) and the release symlink (`consumer-cutover-plan-2205/README.md` rollback rules).
2. **Metal0 control:** restore the saved `metal/config.json` (removing `chainVerifier`) and the previous control release, then relaunch the guest. The supervisor then has no authority and uses the configured `leaseGas.rpcs` quorum, as before.
3. **Windows:** no cutover is possible yet (P4), so there is nothing to roll back.
4. **Admin, relays and funding:** these members are untouched by the templates, so rollback does not affect them.

**Resources:** these templates change no VM, memory or queue setting. The independent 16 GiB host floor and the guest resources are unchanged.

## 6. Owner-move 503 callers (`POST /v1/deployments/:id/release`, `supervisor.js:8314`; 503 at `:8363`)

| Caller | Exact lines | Behaviour on 503 `release_unconfirmed` |
|---|---|---|
| **Shared classifier** (native client + browser helper) | `network/management-outcome.mjs:1-30` | 503 `release_unconfirmed` is **`unknown`** ("it may have run. Never report success for it and never invite a blind resend"). Only `json.released === true` is success (`release:` in `SUCCEEDED`). |
| **CLI `move`** | `cli/enclave.mjs:5528-5545` (messages `:5484-5485`) | It sends **one** release and never resends. On a definite code it polls the owner's own quorum (`moveSnapshot`) for **15 s** instead of 90 s. If the lease is cleared there, the move continues; otherwise it errors with "lease still held … release not confirmed". In the deep case (the release landed, the row is gone) the quorum shows the lease cleared, so the move proceeds. **Parity under that condition depends on the owner's quorum read succeeding within 15 s.** That was not measured. |
| **CLI `DELETE ?evacuate=1`** | `cli/enclave.mjs:1630-1632` → `supervisor.js:8282` | The DELETE handler is fire-and-forget (`proveAndRelease(...).catch`), so it answers 200 `terminated` regardless; there is no 503 path |
| **Site / mobile / dashboard** | not in the inspected files (only the classifier is shared) | **UNKNOWN**; not classified benign |

## 7. Regression (specified; NOT prepared as code within this bound)

I wrote no test file. A correct one needs a viem-shaped fake client that passes `leaseRpcSet`'s single-authority rule (`lease-executor-authority.mjs:47-57`), plus the supervisor's release state, and that was not boundable here.

**The test:** with the real `client/lease-executor-client.mjs` `createLeaseClient` and one authority client whose `eth_getCode`/`eth_call` at `{blockHash, requireCanonical:true}` for the receipt block throws `BlockNotCanonical` (depth 300), `resolveSigned` of a landed lease must:
1. never return `landed`;
2. return `consumed`, because the nonce moved;
3. make **no** relay POST and **no** signature.

It is driven by `resolveSponsoredReleaseTx` + `runRelease` with the ledger row gone, and must close `gone` with no new release signed. The same with the row still held must sign exactly one release.

## 8. Status

- **HOLD:** P1–P5 are open, the site/mobile/dashboard impact of the 503 is unknown, and the adverse-condition regression has not been run.
- **Not production approval:** this stage is a candidate only.
