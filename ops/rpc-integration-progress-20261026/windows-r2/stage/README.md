# windows-chain-authority-stage r2: the Windows node's remaining chain consumers under the explicit chain authority (PREPARED, NOT RUN)

**Not done:** no queue use, tests, build, SSH, network, live change or commit. Only `node --check` and `bash -n` were
run.

**Not touched:** r1 (`../`), which is preserved unchanged.

**Base pinned to `aebf4c932`** (pushed: seams + its regenerated lease bundle + the deep CLI). So nothing re-applies the
6-file `seams.patch`, and no stale bundle is rebuilt.

## What r2 completes (root items 1–3)

**1. Shielded startup works through the ONE authenticated verifier.** It no longer refuses.
- **`host-identity.mjs` `verifierReader`:** the SAME reader contract as `quorumReader`, with the SAME per-read policy:
  - the chain id is checked;
  - the target is head − confirmations (2), never below a block already accepted;
  - the block is read before AND after the value with the same hash and timestamp (a reorg refuses);
  - freshness is checked at both ends, under a deadline.
- **The one change:** agreement of two peers is replaced by the in-process `VERIFIER_CLIENT` mark. That mark is
  `Symbol.for`, set only by `createChainAuthority`, so an ordinary RPC client or JSON can never carry it. The
  verifier's state is proven against the block, not voted on.
- **`host.mjs` `#startupAuthority`:** uses `verifierReader({client: chain.chainAuthority().client})` when the node
  selected the verifier. An explicit `ENCLAVE_STARTUP_RPCS` under the verifier is **refused** (never mixed). An invalid
  selection's refusing client refuses every read. Legacy behaviour is unchanged.
- **Gates intact:** `shield-startup.mjs` uses only `reader.agreed`, so every startup policy and pin check is unchanged.

**2. The privacy agent's chain follows the node's explicit authority.**
- **`chain.mjs` `chainAuthoritySelection()`:** `null` (legacy), `{authority: 'verifier', verifier}`, or `{invalid}`. It
  never returns a public list.
- **`agent.mjs`:** passes it to enrollment.
- **`network-enroll.mjs` `agentChain()`:**
  - **Verifier:** `{addressBook, authority: 'verifier', verifier}` (a loopback URL, checked) with **no `rpc` key**.
    That is exactly what `network/privacy-agent.mjs` hands to its `LeaseReader({...cfg.chain})`, whose verifier mode
    builds no provider client.
  - **Invalid:** `{addressBook}` only, with no RPC at all, so the agent's readers refuse.
  - **Mixed** (a verifier plus RPCs): **refused**.
  - **Legacy:** unchanged.
- **On a running box:** under the authority, the old public `cfg.chain.rpc` and any stale selection are **removed**
  (the agent restarts once). Returning to legacy explicitly drops the verifier keys.

**3. Wallet host admission with `rpc: []` under the verifier** (`host.mjs:124` → `network/host-admission-runtime.mjs`).
- **Traced:** `hostAdmissionFromEnv` passes `chainAuthority: 'verifier'` + `chainVerifier` from the env, and
  `createHostAdmission` builds `LeaseReader({rpc, …, authority: 'verifier', verifier})`. Its verifier mode
  deliberately turns no `rpc` into clients. So `rpc: []` is correct and sufficient, with no change needed.
- **Tested:** through the real module (below). The legacy `rpc: []` still refuses, as before.

**Also kept from r1** (re-applied to `aebf4c932`): every `chain.mjs` read and the operator wallet use the authority's
routed transport, and `send()` is gated (verifier head fresh, backend bound). Submissions and the pending nonce go to
the own backend only, and **never** to the verifier. `rpcUrls()` is `[]` under the authority, and the lease seam uses
the same single selection.

**Unchanged:** the host key, signatures, admin controls, heartbeats, legacy behaviour, measured proofs and security
gates. No fallback was added and no verifier trust was weakened.

## Files (`SHA256SUMS` covers all)

| File | Notes |
| --- | --- |
| `base/` | `git show aebf4c932:` the 5 files |
| `candidate/` | the 5 patched files plus the new test |
| `windows-chain-authority-r2.patch` | 436 lines. Applies to `git archive aebf4c932` and reproduces `CANDIDATE.sha256` exactly (checked) |
| `EXPECTED-TAP.txt` | the new runtime test 6; regressions `lease-seams-windows` 3 and `move-release-confirm` 20 |
| `jobs/windows-chain-authority-r2-tests.sh` | the root job |

**The patched files:** `chain.mjs`, `host.mjs`, `host-identity.mjs`, `network-enroll.mjs` and `agent.mjs`.

**The test (`test/windows-chain-authority-runtime.test.mjs`, 6 tests).** It uses real modules and loopback recorders
(verifier, own backend, and a public sentinel), and **every request destination is recorded**:
1. **`chain.mjs` in a child process** (its env is read at load):
   - reads go to the verifier;
   - the pending nonce and exactly one submission go to the backend;
   - `chainAuthoritySelection` returns the verifier selection;
   - the sentinel gets 0 requests.
2. **Refusals:** a down verifier, no backend, and 4 invalid selections (`{invalid}`) all refuse, with the sentinel at 0
   and nothing sent. Legacy is unchanged (`selection` null).
3. **The startup reader:** `verifierReader` over the REAL `chain.mjs` authority client.
   - The value is read **at head − 2**, and the block is read twice.
   - An ordinary client is refused, and `quorumReader` still refuses a single client.
   - The sentinel gets 0.
4. **Startup refusals:** a reorg during the read, a stale block and a down verifier all refuse, with no fallback.
5. **The agent:** `baseConfig` gives `{addressBook, authority, verifier}` with no `rpc`.
   - Mixed and remote selections are refused; invalid gives `{addressBook}`; legacy is unchanged.
   - The REAL `LeaseReader({...cfg.chain})` (as `privacy-agent.mjs:237`) reaches the verifier, and the sentinel gets
     0. The invalid configuration's reader refuses.
6. **Admission:** the real `hostAdmissionFromEnv` with `rpc: []` builds under the verifier; legacy `rpc: []` still
   refuses.

## Root job (after review; offline, cap 1792)

```
./jobs/q-exit-status.sh windows-chain-authority-r2 1792 unshare -rn bash windows-chain-authority-stage/r2/jobs/windows-chain-authority-r2-tests.sh
```

**Setup:** a fresh `--no-local` clone at `aebf4c932`. It applies the r2 patch and checks `CANDIDATE.sha256`. It links
`node_modules` with an absolute link, only if `package-lock.json` is identical.

**Bundle plan:** **no bundled source changes**, so nothing is regenerated. The committed bundles must pass `--check`
unchanged (`build-windows-lease-runtime`, `build-metal-lease-gas`, `build-host-admission`). Any staleness is a SETUP
failure and is never silently rebuilt here.

**Checks:** `node --check` on the 5 files, then strict TAP per file in `EXPECTED-TAP.txt`.

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP (never a verdict) |

## Remaining (explicit; not solved here)

- **The owner CLI `windows/node/host-onchain.mjs`** (separate follow-up). Its exact dependencies:
  - `RPCS = BASE_RPCS || publicnode, drpc, mainnet.base.org` (`:39`);
  - `pub = createPublicClient(fallback(RPCS))` (`:45`), used for the owner's reads;
  - `quorumReader({clients: rpcClients(RPCS)})` (`:53`), for ownership and status decisions;
  - `wal = createWalletClient(fallback(RPCS))` (`:77`), used for `writeContract` (`:91`: fund-operator,
    declare-payout, deploy, ownership).

  It runs with the OWNER's key, not on the node runtime.
- **The agent's network host** (`network/enclave-network-host.mjs:72, :78`): with no `rpc`, the egress probes default
  to none, and `verifyOwnerSignature`'s `clients` is empty.
  - **EOA owner signatures:** unaffected (recovered locally).
  - **Contract-wallet (ERC-1271 / session-vault) owner signatures:** in **non-pinned** mode they now fail **closed**.
  - **Pinned mode:** it uses `leaseReader.agreed`, which is the verifier.

  This needs the verifier client passed to `verifyOwnerSignature`. That module is not changed here: **a platform
  feature (contract-wallet policy signatures without pins) is degraded under the verifier until then.** The work is not
  declared done for it.
- **Test risks:**
  - The admission test writes a minimal contract-pins file. If `loadContractPins` expects a different shape, that test
    fails at SETUP-like construction. That would be a fixture issue, not a product verdict.
  - The agent test asserts that the verifier was contacted and the sentinel was not. It does not assert a successful
    proven read, because the recorder does not serve proofs.
- **Trust tier:** the verifier is the unsafe tier (a sequencer-signed head), with no L1 finality. There is no
  independent reproduction and no live run. Lease consumers stay on HOLD, and Custody v2 stays refused.
