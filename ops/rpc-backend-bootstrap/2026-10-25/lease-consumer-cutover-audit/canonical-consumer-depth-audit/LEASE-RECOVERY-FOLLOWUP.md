# Follow-up: lease quorum composition and old-receipt recovery under the canonical gate (2026-10-25)

- **Method:** read-only static audit of `relay-consumer-source` `81ba668531d17151db810e14562c77a672d742e4` and the public/observed fields of `consumer-cutover-plan-2205/`.
- **Not done:** no raw secret configs, SSH, tests, product edits, queue use, network access or commits.
- **Custody v2:** stays REFUSED (`custody/v2/quorum.mjs:42-45`) and is not expanded here.

## Q1. Is a Helios-gated client a required quorum voter for `verifyLeaseReceipt` / `findLanded` / `resolveSigned`?

**Code: yes, as the SOLE voter, whenever the host runs under `ENCLAVE_CHAIN_AUTHORITY=verifier`.**

| Step | Exact lines |
|---|---|
| The authority comes from the env or caller; it excludes any RPC list | `network/lease-gas-runtime.mjs:59-60`: `const authority = … chainAuthorityFromEnv(env, { chain }); const rpcs = authority ? [] : list(required(env, "RPCS"))` |
| The client set is the authority's single client | `network/lease-gas-runtime.mjs:96`: `const clients = authority ? [authority.client] : rpcs.map(…)` |
| The quorum is derived from that set (one peer) | `:98-99`: `leaseRpcSet(clients, …)`, `quorum: peers.required` |
| Mixed provider + verifier is refused | the C3 delta header: "mixed provider+verifier selections are refused by 433f04fa1" |
| Lease client construction | `network/lease-gas-runtime.mjs:123`: `createLeaseClient({ ...options, ...clientConfig, … })` |
| Receipt recovery inside the client | `client/lease-executor-client.mjs:618` (`verifyLanded`), `:622-630` (`findLanded`), `:789-820` (`resolveSigned`), all through `rpc.agree(rpc.peers…)` (`:160`) |
| Callers on restart | `supervisor.js:10614-10626` (`resolveSponsoredReleaseTx`, `:10622`); `windows/node/chain.mjs:329`. The guest supervisor declares the local-verifier mode at `supervisor.js:323` and builds its sender at `:10209-10212` |

So under verifier authority, `verifyLeaseReceipt` reads `{blockHash: rc.blockHash, requireCanonical: true}` (`lease-executor-client.mjs:179`) through the canonical gate as the only voter. **A receipt more than 256 blocks below the verified head cannot be verified there** (`canonical.rs:52-55`, `BlockNotCanonical`), and no other voter exists.

## Q2. What the prepared cutover actually configures (public/observed fields only)

| Consumer | Prepared candidate | Lease reads under the verifier? | Depth exposure |
|---|---|---|---|
| Lease relay (eu-central) | `C3-lease-relay.env.delta`: removes `LEASE_RELAY_RPCS`/`QUORUM`, adds `ENCLAVE_CHAIN_AUTHORITY=verifier` + `ENCLAVE_CHAIN_VERIFIER` + own TX backend | **Yes, sole voter.** It is placement-blocked (C3 blockers 1–3), with the verifier port `<MERGE>` | The relay path verifies its **own** receipt right after sending (`relayLease` → `:339`, receipt timeout 120 s), so the depth is shallow. The relay service (`network/lease-relay-service.mjs:68` → `startLeaseRelay`) does not call `resolveSigned`. **Static: not affected**, while the relay is not restarted mid-wait. |
| Metal0 control / guest supervisor (sponsored releases, `resolveSigned` on restart) | `C2-…chainVerifier.merge-patch.json`: "`leaseGas` (rpcs, relays, quorum) is NOT changed by this patch … does not by itself remove leaseGas public RPC use" | **No: still the observed public quorum** (publicnode, mainnet.base.org, blastapi; quorum 2) | Not exposed **under the prepared plan**, but its lease reads are **not cut over**. **No prepared config exists** that moves the supervisor's lease reads to the verifier. |
| Privacy agent | `C1-…merge-patch.json`: `chainAuthority: verifier` (lease-reader reads) | Read-only lease reads; not traced to `resolveSigned` | Not traced (budget) |
| Windows node (`windows/node/chain.mjs:329`, `resolveSigned`) | **No candidate** in the cutover plan | Unknown | Unknown |

## Q3. If the supervisor's leases run verifier-only: what a deep (> 256) landed receipt does

This is traced in code; it was not run. The sequence on restart, or on a resolution more than 256 blocks (about 8.5 min at 2 s) after the release landed:

1. **No `landed`:** `findLanded` → `verifyLanded` throws `BlockNotCanonical`, which is caught (`lease-executor-client.mjs:628`, `:799 .catch(() => null)`), so it is not `landed`.
2. **`consumed`:** `resolveSigned` returns `consumed` because the nonce has moved (`:803-806`), or `expired` after the deadline (`:807-817`). It **never** returns `landed`.
3. **The state is set:** `supervisor.js:10625` sets `tx.state = "consumed"|"expired"`. It is never `success` (`acceptSponsoredLanding` `:10556-10568` is not reached), so `tx.released` is never set.
4. **The loop closes without `released`:** `runRelease` (`supervisor.js:10695-10716`) skips `released` (`:10702`). Then:
   - with attempts ≥ 4 → `closeRelease(it, "gave-up")` (`:10707`);
   - otherwise it reads `pinnedLedgerRow` → if the lease row changed → `closeRelease(it, "gone"|"not-held")` (`:10711`);
   - only if the row **still holds the same lease** does it sign another release (`:10714`), which is correct, since the earlier one did not take effect.
5. **`closeRelease`** (`:10536-10548`) records `outcome`, `noteLeaseFloor`, and the evacuation hold-off for any outcome except `cancelled`.

**What this means:**
- **Not a wrong answer, no unsafe action.** It is never a false `landed`, and there is no double release while the ledger shows the lease gone.
- **But it is not feature parity:** a release that **did** land is closed as **`gone` / `gave-up`**, not **`released`**, and `tx.released`/`success` evidence is lost.
- **Whether the downstream treats `released` differently** from `gone`/`gave-up` (UI, operator reports, renewals, billing) is **UNKNOWN**: the consumers of `it.outcome` and `tx.released` were not traced within this budget.

## Verdict

**HOLD** the canonical-binary activation for lease consumers until both of these are settled; this report does not waive either.

1. **Config missing (concrete):** no prepared cutover config moves the guest supervisor's / Metal0 control's `leaseGas` reads to `ENCLAVE_CHAIN_AUTHORITY=verifier`. C2 explicitly leaves the public quorum, and the Windows node has no candidate. The intended lease quorum composition for those consumers is **not prepared**, so "no lease path is blocked" cannot be stated.
2. **Parity unknown:** when that config is prepared, the verifier is the sole voter (Q1), and a release older than 256 blocks at resolution is relabelled `gone`/`gave-up` instead of `released` (Q3). Whether that is a benign label or a parity blocker depends on the untraced consumers of `outcome`/`tx.released`.

**Unchanged:** the fail-closed, tier and admin policy. Nothing is loosened.

## The ONE remaining action

Trace, or test, the consumers of the release outcome:
- every read of `it.outcome` and `tx.released` / `tx.state === "success"` after `closeRelease`, in `supervisor.js` and `windows/node/chain.mjs`: the UI, status API, renewals and billing.

The test equivalent: in a mocked supervisor, with the lease client on a verifier-only authority, a release that landed 300 blocks before resolution must end with an outcome the downstream treats identically to `released`. If it does not, that is a **parity blocker**: fix it by an authenticated deep-ancestry path (the EIP-2935 single-proof proposal in `REPORT.md`) or an explicit reviewed config decision, never by relaxing the gate.
