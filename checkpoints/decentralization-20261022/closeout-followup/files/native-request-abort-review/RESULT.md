# native-certificate.mjs request lifecycle: reproduced and fixed in a private copy (RESULT, 2026-10-22)

**Status: committed locally in a PRIVATE COPY, tested offline.**
- Not applied to the issuer repository, not bundled, not imaged.
- No SSH, RPC, production, real keys or funds. Every key here is a disposable test key made by openssl in a temp dir.

## Snapshot (what the copy is)

| file (copied from `native-issuer-implementation/repo`) | sha256 | note |
|---|---|---|
| `metal/guest/native-certificate.mjs` | `fa0e6e577db01838f9a7ba19ac0d783364a8a08d85b4f87f5f395c49f3b4d3d9` | issuer's uncommitted file. **Not a live mutant:** all 9 mutation sites of `jobs/mutants-r1/r2/r3.py` that target it hold their ORIGINAL text, and no replacement text is present. mutants-r3 had ended with rc 0 (files restored) |
| `metal/guest/measured-control.mjs` | `318a84ce…c011c105` | == `git show 8e77ff1e` |
| `metal/guest/owner-nomination.mjs` | `a2fb3eb6…25431d0` | == HEAD 8e77ff1e |
| `metal/guest/lease-gas-conduit.bundle.mjs` | `421d6584…34ba8d6` | == HEAD 8e77ff1e |

- Copy commit: `e60cfeb` in `native-request-abort-review/snapshot` (local git; `SNAPSHOT.sha256`).
- The issuer's live file was still `fa0e6e57` after the work, so the patch applies to the current issuer bytes.

## Fix

- **Commit:** `4e079db191ea6f059252a01c30e60cd1e66d6aaf`, tree `5f40840c…`, author and committer
  SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>.
- **Patch:** `native-request-abort.patch` (`git diff e60cfeb 4e079db`), sha256
  `2c8dc3eeebebb507514bc06e399d1ab5564b207857d02770ea199d68875610b8` (2 files, +160/−7).
- **`metal/guest/native-certificate.mjs`:** `fa0e6e57` → `9e103964b748d2a7b07b2a79d797c89f11603d161cb90db18abf853d8fc27add`
  (`httpOver()` only, +25/−7).
- **`test/native-certificate-request-abort.test.mjs`:** NEW, `a822373ba98fe8032a805fac638b3c8e3fa6561e22a54b10735738ffa72e494b`.

`httpOver()` now settles exactly once through `settle()`:
- **Abort.** An already-aborted signal is refused before the request is created, so no byte is sent. A later abort
  settles it. This closes the window between `tlsTo` releasing its abort listener (on `secureConnect`) and `httpOver`
  registering its own.
- **Deadline.** ONE `timeoutMs` deadline covers the whole exchange: request, headers and body. The socket idle timeout
  stays as a second bound.
- **Answer.** Its `error`, `aborted`, and a `close` before `complete` reject. So do the request's `error` and `close`.
  The `maxBytes` overflow now rejects through the same path.
- **Release.** Every outcome clears the timer, removes the abort listener, destroys the request and the socket.

Unchanged:
- `tlsTo`, `pinnedSocket` (the SPKI pin is checked on the secure socket before any request byte; a missing or malformed
  pin is refused before connecting);
- `untrustedRead`'s GET-only shape and `installNativeCertificate`;
- the signer and DER code, the certificate profile, CA trust and every admin decision.

## Tests

All runs used `work/claude-test-queue.py --mib 256` inside a private network namespace (`run-test.sh`: `unshare -rn`,
loopback only, `timeout 120`). The servers are real Node TLS servers that misbehave at each point of the exchange.
Socket release is observed as the server's TCP `close`; "no bytes" is counted on the server.

| run | tree | result | guard |
|---|---|---|---|
| base-1 | e60cfeb | not a result (my setup: the test file was not in the worktree) | — |
| base-2 | e60cfeb | 3 pass / 5 fail: one of the 5 was my test (the pin case looked for a TLS-level record that the server never creates when the client drops right after the handshake) | 131 MiB |
| **base-3** | e60cfeb, corrected test | **4 pass / 4 fail** | 131 MiB |
| **fix-1** | **4e079db** | **8 / 8, EXIT 0** | 130 MiB |

The baseline failures, each passing with the fix:
- **Partial Content-Length, then the peer disconnects.** Base: pending after 3 s. Fix: rejects in ~87 ms, socket closed.
- **Trickling answer** (1 byte per 100 ms, `timeoutMs` 800). Base: pending after 4 s. Fix: rejects at ~823 ms.
- **Abort between handshake and request** (injected exactly when `tlsTo` releases its listener), on an install PUT.
  Base: the install **resolved, so the body was sent**. Fix: rejects `aborted`, **0 HTTP bytes** reach the peer,
  connection closed.
- **Cut answer in the late-cancellation case.** Base: pending. Fix: rejects; later `abort()` calls on settled requests
  raise **no unhandled rejection or uncaught exception** (process-level listeners record none).

Already correct on base and still correct:
- `maxBytes` overflow rejects;
- an abort mid-answer rejects and closes;
- a complete answer is exact (status, 3 KB body split across writes, `peerSpkiSha256`), for both pinned and untrusted
  reads;
- a wrong pin refuses with 0 bytes.

**Regression.** The issuer's own `test/native-certificate-leaf.test.mjs` (`67d32451`) was run with the issuer's CLI
`scripts/native-control-certificate.mjs` (`4eabe79e`, it imports only this closure). Both were copied untracked into each
tree (`REGRESSION-INPUTS.sha256`). Result: **5/5 on base and 5/5 on fix** (reg-base, reg-fix; 132/140 MiB).

Logs and hashes: `logs/`, `EVIDENCE.sha256`.

## Limitations (honest)

- **Scope.** Only this module's client request is covered. `native-issuer.mjs` and `platform-api-role.mjs` callers were
  not run here: their suites need the issuer's full tree, owned by its worker. The callers keep the same promise
  contract, which now also settles on the cases above.
- **Deadline semantics.** `timeoutMs` now bounds the request phase from `httpOver`'s start. Callers that relied on the
  idle-timeout semantics, with a slow but steady answer longer than `timeoutMs`, will now get a rejection. Today's
  answers are small: a PEM chain and JSON statuses.
- **Handshake vs HTTP phase.** The handshake has its own `timeoutMs` bound in `tlsTo` (unchanged), so the worst case
  for one call is ~2 × `timeoutMs`.
- **Abort reason.** An abort inside the TLS step is still reported as `aborted` by `tlsTo` (unchanged). The new path
  uses the same message.
- **Integration.** The issuer worker must apply the 1-file patch to its tree, then rebuild the platform-api bundle,
  which inlines this module (bundle manifest step), and redo the measurement. I did not touch the issuer repo, the role
  or the bundle.

## Activation report correction (done)

`adapter-activation-review/RESULT.md` is now `08f856ff`; the previous version is kept as `RESULT.v1.md` (`d5a06fdf`).
- **Renewal lead.** The adapter's app-funded renewal starts **285 s** before its lease end (~22:10:34Z for 22:15:19Z).
  `host.mjs:2220` uses `chain.renewLeadMs(id, RENEW_LEAD_MS)`, and the lease sender answers from minipc's sponsored
  renewWindow of 300 s. 15 min is only the fallback that arms the check. The forward and rollback budget is re-derived
  from that.
- **Bounded restart.** `node-restart.ps1 -Mode restart` uses unbounded `Stop-/Start-ScheduledTask` and is no longer
  proposed; an SSH observation timeout does not bound it. No existing helper offers a bounded node-only restart: the
  bounded `Invoke-TaskCommand`/`StopNode`/`StartNode`/`AgentUp`/`LeaseReady`/`BeforeStop` live only behind
  `node-hold-cutover.ps1`'s config-editing modes.
  - S5 is BLOCKED until a reviewed restart-only extract of those functions exists, tested with the existing mock
    harness.
  - Only `-Mode identify` is still used.
