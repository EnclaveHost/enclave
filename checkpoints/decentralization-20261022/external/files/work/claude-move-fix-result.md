# Independent move: safe release fix, result (2026-10-19, frozen for integration)

## Scope and status

This fixes the blocking findings 1-5 and 7 of `work/claude-move-review-result.md`. The interface is
`work/independent-move-fix-interface.txt`.
- **Repo:** `work/enclave`, HEAD `45801c22`. The HEAD commits since `d0676ff3` touch none of these files.
- **Not done:** no commits, no contract edits or deploys, no production, SSH or live chain, and `cli/dist` was not
  promoted.
- **Frozen.** All checksums below were taken after the last edit, and every result reported here ran on exactly this
  source.

**Same-operator move parity is NOT achieved.** The CLI refuses those moves. Parity needs the ledger extension proposed
in `work/lease-epoch-proposal.txt`, which is not implemented.

## What changed

### `supervisor.js`: one durable release mechanism for every release (`supervisor.js:9538-9790`)

- **Decided on the lease's identity** (`beginRelease`, `ownLiveLease`):
  - this host's enclave id **and** operator **and** a live `leaseUntil`;
  - read at a block the RPC names, never below the deployment's ledger floor (`pinnedLedgerRow`). The floor is the
    last block this host saw for the id: a claim, renew, re-claim or release receipt (`noteLeaseFloor`).
  - A lagging node errors instead of returning an older row.
  - Without registration, the runner id is `keccak256(PUBLIC_URL)`, the same derivation as the management base.
- **Durable intent.**
  - The intent is opened before the decision read, so a renewal, resume or claim starting meanwhile stands aside.
  - Each release is signed locally, and `{hash, nonce}` is persisted (`saveStateNow`) **before** the broadcast.
  - It never holds a key or the signed bytes. It holds only fixed status words and no RPC error text.
  - It is restored by `loadState` (`supervisor.js:3561`, `serializeState`).
- **One unresolved release per id** (`runRelease`, `resolveReleaseTx`). A transaction resolves by:
  - its receipt, at `RELEASE_CONFIRMATIONS` (default 2); or
  - its nonce being consumed at a named block.

  A receipt timeout or a failed broadcast is **not** a failure. A nonce no node holds is consumed by a zero-value
  self-transfer at that exact nonce (`fenceNonce`, after `RELEASE_FENCE_SEC`, default 180). A retry (at most 4, with
  15 s × attempt backoff) happens only after resolution, and only if a read at or above the resolution block still
  shows the **same** lease. A lease ending within 60 s is left to lapse.
- **Success** is only the release's own success receipt carrying `Released(id, this enclave)`. A later stale read can
  neither turn it into a failure nor invent it.
- **Holds while an intent is open:**
  - `considerClaim` refuses the id (`:10742`); this covers the sweep's resume-first pass and both claim-hint routes;
  - `tryClaim` and `adopt` re-check after their awaits (`:11156`, and in `adopt`);
  - `renewLeases` skips the id, `auditClaims` skips it, and `restart` answers 409 `release_in_progress`.
- **Stand-down** (`_evacuated`, now persisted) is re-armed when the release resolves, not when it was asked for.
- **Restart with the state LOST:** a boot nonce fence (`checkBootTxFence`, `:9765`). Any resume (which sends no
  transaction) waits until the operator's mined nonce reaches the pending nonce seen at boot. An unreadable nonce stays
  "unknown" and holds (`:10764`).
- **Stale-view resume guard.** When the sweep's page row shows this host's own live lease for an id with a floor, it is
  re-read at or above the floor before resuming.
- **Transitional states.** `releaseBlockedReason` refuses (`release_blocked`, nothing stopped) during a restart, a
  launch (`tenantProvisions` or status `claimed`), a crash relaunch or a renewal.
- **Every legacy caller uses it:**
  - DELETE (which now also refuses `release_blocked`) and admin consolidation;
  - provision failure, version and config change, share resize, yank, `setActive(false)`;
  - abandonment, placement retirement and capacity-vanished;
  - shutdown (`retry: false`: the next boot resolves it and never keeps releasing a lease it could resume).
- **Owner release route** (`:7614`):
  - refusals before any effect: `not_releasable`, `release_in_progress` (naming the unresolved transaction),
    `release_blocked`, `release_unavailable`;
  - 502 `stop_unconfirmed` with nothing signed;
  - 200 `{released: true, txHash, blockNumber, standDownSec}` on the receipt;
  - otherwise 503 `release_unconfirmed` naming the transaction, while the host keeps resolving it.

### `network/management-outcome.mjs`
- `release_blocked` is a not-started refusal for `release`.
- `release_in_progress` is a not-started refusal for `restart`.

### `cli/enclave.mjs` (`cmdMoveIndependent`)
- **Same-operator refusal** (`:5215`): a target whose registry operator equals the live lease's `runnerOperator` is
  refused before any host or directory is contacted, with the ledger reason. A queued record sends no release and is
  not refused.
- **Messages:**
  - "claimed back by the source" (`:5279`) instead of a false "queued";
  - "no live lease … ran out rather than being released" for a lapse;
  - the new release states in `RELEASE_STATES`;
  - a landing snapshot older than the confirmed clear is ignored.

### Docs
`docs/network/independent-management.md` (the release semantics and the same-operator note) and
`docs/network/independent-cli.md` (the move guard and the result messages).

### Proposal
`work/lease-epoch-proposal.txt`: a per-deployment claim generation in a separate mapping (the `get`/`getPage` ABI
stays byte-identical), plus:
- `leaseOf`, `releaseLease(id, expectedRunner, expectedGeneration)` and `LeaseOpened`;
- an operator opt-in `guardedReleaseOnly`;
- the reason `(runner, leaseUntil)` collides on a same-block release and re-claim;
- feature detection, migration, and the condition for lifting the CLI refusal (schema ≥ next **and** the source
  operator opted in).

## Tests

**New test files:**
- `test/move-release-durable.test.mjs`
- `test/move-release-restart.test.mjs`
- `test/cli-move-same-operator.test.mjs`
- `test/helpers/move-release-rig.mjs`

**Extended files:**
- `test/helpers/cli-independent-rig.mjs`: mining switch; `startActualHost` options for the claim loop, RPC, state reuse,
  script and appRef; launch attribution by deployment;
- `test/management-move-unit.test.mjs`.

**The actual-supervisor cases** use the unmodified `supervisor.js` with its real claim loop:
- registration on the schema-4 registry;
- a loopback attestation document whose format names SEV-SNP;
- `CLAIM_POLL_SEC` 2 and `MOVE_HOLDOFF_SEC` 30;
- the real ledger on anvil;
- a servable catalog app on port 3000. The rig's port-8080 app can never be claimed, which would make "never resumed"
  vacuous. The positive re-claim at the end of A proves the gauntlet runs.

**Durable cases:**
- **A:** mining paused for 40 s past the stand-down: no resume. Release and restart are refused naming the pending
  transaction, the answer is 200 only on the receipt, and the source re-claims ≥ 30 s after resolution under a new
  lease.
- **B:** `latest` reads lag behind the release: the answer is still 200, there is one release and no resume. The proxy
  is proven stale by a direct read and by the sweep log.
- **D:** a release swallowed before any mempool: one unresolved at a time, then its nonce is consumed, a second release
  is sent, and 200 comes on that second receipt.
- **E:** a release or DELETE during an owner restart gets 409 `release_blocked`, with nothing released.
- **F:** a same-operator sibling's lease: `not_releasable`, nothing stopped or sent.

**Restart cases:**
- **C:** the release is in the mempool and the new process's RPC hides it pending, so only the restored intent holds.
  No resume, nothing re-sent; it resolves when mined, and the stand-down persists.
- **C2:** the state is lost: the boot fence holds the resume, and every later launch runs under a lease claimed after
  the release.
- **D2:** the release never reached any mempool: held as unknown, its nonce is consumed, and it is decided again. The
  state file holds no key, no signed bytes and no RPC error text.

**Run conditions:** every run was serial and foreground under `/tmp/s6/run-768.sh`, which kills its own process group
at more than 768 MiB own RSS, below 16384 MiB MemAvailable, or after 900 s. Every run started at ≥ 18 GiB available,
and none was killed. Logs are copied to `work/move-fix-evidence/`.

| Run (final source, hashes below) | Result | Peak own RSS | Min available |
| --- | --- | --- | --- |
| move-release-durable | **5/5** | 508 MiB | 17221 MiB |
| move-release-restart, 1st (final3) | 2/3: D2 failed on my new `broadcast` assertion (it expected `unconfirmed`, but the process died before the broadcast answered). A test expectation; the assertion was corrected. | 513 MiB | 17413 MiB |
| **move-release-restart** (final4) | **3/3** | 381 MiB | 17040 MiB |
| cli-independent-move (existing) | **6/6** | 662 MiB | 17808 MiB |
| cli-move-same-operator | **1/1** | 499 MiB | 17817 MiB |
| management-move-unit | **3/3** | 42 MiB | 18182 MiB |
| direct-only-supervisor / claim-sweep / isolation-guest-pool / management-plane (existing; they reach changed code) | **4/4, 4/4, 14/14, 38/38** | ≤ 344 MiB | ≥ 17902 MiB |
| staged bundle: cli-move-same-operator | **1/1** | 357 MiB | 18068 MiB |
| staged bundle: cli-independent-move | **6/6** | 484 MiB | 17670 MiB |

**Negative control.** The same test files were run against the pre-fix `supervisor.js` (`b7e11e14…`, kept as
`work/move-fix-evidence/supervisor.prefix.js.txt`). Its temporary in-repo copy was removed afterwards.
- **Durable: 0/5,** each on its hazard:
  - A: the app relaunched onto the pending-release lease (`1 !== 0`);
  - B and D: 503 `release_unconfirmed` (a false failure, then blind retries);
  - E and F: 200 where 409 was due (a release mid-restart, and the sibling's lease released).
- **Restart: 0/3,** each on a resume onto a lease a pending or unknown release could end.

This ran on the test files' pre-final revision (`negfinal-*.log`). The two later test edits only added assertions after
those hazard checks, and changed no supervisor behaviour the control exercises.

**Not rerun:** the pure model (`/tmp/move-review-model`). It remains evidence only, not proof.

## Frozen source (sha256)

```
8d1b9262c5af5f2f51d8fbc20b398e2c8f6a63a4cac10b75f0bac72ef66077be  supervisor.js
5c21db40f393806f9da44392c35174d626e580356a7b206c0f30a361e599125d  cli/enclave.mjs
fea5703454b1cc9323eacc931a42c0f99f1895526f4926e787155d57e44c0398  network/management-outcome.mjs
951bbf445961bfc73d06fc87caf98a3817198d6f08b241ee4c10a61b10463171  test/helpers/cli-independent-rig.mjs
46eea6fb943039419bfb58f0bc82252156ccfcc32c8371f625289d0952070228  test/helpers/move-release-rig.mjs
15c85973c6a77e0b964ac68cd7ee4ba1558cc309f10545d2dff3ff933650a5b2  test/move-release-durable.test.mjs
c29954f2ae55188dbc5b9062335ee3a8646bd621183cd74b554d830c7dccc624  test/move-release-restart.test.mjs
fa8752be3c54e9884eb81e7fbd2a7a2d85a5fb051bb6b994b9a7ad88e457bbf7  test/cli-move-same-operator.test.mjs
7e42e293931ebeb964450388b891c285bcdd2212b2c26dbd525850c3796bcf18  test/management-move-unit.test.mjs
cd17ff42f70f2d6fd9c3a17f62ab733da35ee6c98c02f140581faa4cd287ca28  docs/network/independent-management.md
d3660d23c4eda701d19e9cbae883c811ff294a5bc7eec884bf699106baa6f918  docs/network/independent-cli.md
6b6f8ad3077e3eebf79811d6c8a4d082e41fdb26fd14b8b66ab9bf34422eec53  work/lease-epoch-proposal.txt
5d2addd019d2426a8ee1e6402ef0870dcb04fb0daa101946c38ae14ce08c7d3d  work/cli-staging-move-fix/enclave.mjs (staged, 2014564 bytes)
```

**Left untouched:**
- the prior staged bundle `work/cli-staging/enclave.mjs` (`adc4c0cf…`);
- `cli/dist/enclave.mjs` (`9db0f36a…`).

**Untracked files for integration:**
- the four new files listed under Tests;
- `test/helpers/cli-independent-rig.mjs`, `test/management-move-unit.test.mjs` and `docs/network/independent-cli.md`,
  which carry the earlier move round's untracked work, extended here.

## Remaining boundaries (precise)

1. **Same-operator moves: OPEN.**
   - The CLI refuses them, and the supervisor refuses to release a same-operator sibling's lease.
   - A release signed by one process can still end a lease another process holds with the **same key**. Two processes
     share no intents, and a host running an older binary still sends blind `release(id)`.
   - Only the ledger extension in `work/lease-epoch-proposal.txt` closes this, together with the operator opt-in. It
     is not implemented.
2. **Boot fence depends on the RPC's pending view.** With the state lost, a release that only a different node's
   mempool holds (this RPC reports pending == latest) is invisible at boot, and a resume could follow it. With the
   state kept, the restored intent covers this case (test C).
3. **Unresolvable nonce.** If the operator can send nothing (no gas), an unresolved release holds its id indefinitely.
   This is deliberate: unknown stays unknown.
4. **A pre-existing broadcast race.** A transaction broadcast but dropped by every node, then re-broadcast by a third
   party, can still land before its nonce is consumed by any later transaction. It is covered by the hold and the
   fence, which resolve only by receipt or consumed nonce.
5. **Behaviour changes to note at integration:**
   - DELETE and admin consolidation now answer 409 `release_blocked` during a restart or launch, or for a `claimed`
     record;
   - `restart` answers 409 `release_in_progress` while a release is unresolved;
   - legacy releases no longer fire when the ledger shows no live lease of **this host**. Previously a blind release
     reverted, or ended a sibling's lease.
6. **The vendored browser bundle** (`site/vendor/management.js`) is site-owned and still stale (it was already stale).
   It is not rebuilt here. It needs `release_blocked` only for classification, and it offers no move.
7. **Not covered:** a host running a pre-fix supervisor during a rolling update. Its blind retries remain until it
   updates. The opt-in in the proposal is the on-chain remedy.
