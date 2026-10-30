# Host-authority completion r2 (source only)

**Status:** nothing was run (no tests, compiler, shell, network, Git, services, wallet or provider). There are no pass results for this code, and the profile is not claimed qualified.

**Baselines preserved:**
- The root r1 terminal delivery.
- Root r2's two required corrections: same-host-only invalidation in the generator, and the `snapshot.verified` mapping in `deployment-host-authority.mjs`.
- Root r3's corrected composer/dispatch, the explicit-only default and safe adoption (host generator 7073e59c, dispatch 9a155041).
- Runner 75590c8e.
- Solidity, the registry source/artifact, the schema3 bundle and ABIs.

The seeded `src/network` protocol and adapter copies are untouched generator **inputs**. The harness overlays the actual generated outputs.

## Files written (all under `candidate/`)

| Path | What it does |
|---|---|
| `src/network/deployment-host-authority.mjs` | Root r2's version (verified fix kept), plus:<br>• `isHostAuthorityPermit` refuses `profile: independent-host-registry-r1` without exact `servingPermit` v2 (no v1 fallback).<br>• `offlineObservationOf`: only proof-qualified evidence for its own host counts.<br>• `compareHostAuthority` refuses any context at or below a recorded Offline generation.<br>• Evidence carries the observation `blockNumber`. |
| `src/network/deployment-host-authority-journal.mjs` | Gate/witness sidecar (format v2):<br>• durable host-wide Offline record; no identity increment needed, and only a newer qualified generation clears it;<br>• `<file>.established` marker and `established()` owned-journal coupling;<br>• detects a lost or changed file;<br>• latches unknown on any write/fsync/rename/directory-fsync failure;<br>• explicit `recover()` only when the intended bytes are on disk and file + directory fsync succeed;<br>• deep validation;<br>• `openLockedHostAuthorityJournal`, which holds the existing runtime flock (`runtime-lock.mjs`). |
| `src/network/lifecycle-host-incarnation-journal.mjs` | Replaces root r3's faulty dispatch sidecar as the active boundary. Fixes all four of root's demonstrated defects:<br>• same-generation Offline persists, and an older Online view is refused;<br>• a lost observed or established file is unknown, never first use;<br>• a malformed nested floor refuses;<br>• a directory fsync after rename latches.<br>Also: established marker, coupling to the actual owned journal's host-authority floor (recorded at dispatch attach), explicit `recover()`, `openLockedHostIncarnationJournal` (flock), and a durable `requeue` flag on bindings. API and shapes are unchanged (`floor.generation`/`digest`/`context`, `genesis`, `bound`). |
| `src/tools/generate-host-authority-permit-candidates.mjs` | Root r2's corrected generator plus completion edits (insertions only, restoration self-proof, same five pinned inputs):<br>• **Gate:** records authenticated Offline evidence durably and withdraws every grant of that host before verification (other hosts untouched); owned-journal coupling.<br>• **Witness:** records its own reader's Offline. After the internally produced signature, a final asynchronous read; after that read it re-checks the full app/host context, durable floor, cancellation, closed, fenced, denial and supersession before releasing anything.<br>• **Runtime:** exposes `hostAuthorityPermit`; a v1 runtime refuses new-profile snapshots; the adoption handoff is documented for the dispatch caller only.<br>• **Adapter:** evidence `blockNumber`. |
| `src/tools/generate-host-authority-dispatch-candidate.mjs` (new) | Hash-pinned second stage over root's 9a155041 (root's generator is not re-run on its own output):<br>• adoption performs the v2 runtime/gate handoff under the same final fresh read, inside root's serialized and quiescence-checked adoption, then binds with `requeue`;<br>• while `requeue` is set the app is denied, so the actual runner confirms the stop and records an authorized queued transition (no invented ended evidence, no financial state cleared);<br>• `requeue` clears once the authenticated assignment is not running and no old work can exist, and the normal fresh queued start proceeds;<br>• a durably Offline floor refuses serve and start host-wide;<br>• the new profile serves only through the v2 runtime. |
| `test/helpers/real-v2-host.mjs` (new) | The real v2 host stack around the actual generated adapter. Each witness reads through its own adapter instance. |
| `test/root-host-registry-profile.test.mjs` | Root native 16, moved onto the FINAL layered adapter and dispatch plus the real v2 runtime:<br>• the generator test proves both layers byte for byte;<br>• line-147 Offline prepare now asserts `/offline/`;<br>• a stale Online read cannot undo a durable Offline;<br>• adoption → v2 gate handoff → one authorized queued transition → fresh start that serves again. |
| `test/root-completion-protocol.test.mjs` (new, 7 tests) | • Root's failing same-generation Offline case plus reopen and qualified generation-2 recovery.<br>• Two simultaneous app grants with A-only invalidation preserving B.<br>• Per-witness final-read Offline and close races, plus the positive unchanged-state signing case.<br>• Hold during gate install.<br>• Mandatory v2 at direct entry points.<br>• Repaired sidecar failure modes, recovery and owned coupling.<br>• Gate sidecar Offline/marker/coupling and flock writer exclusion. |
| `test/host-authority-permit.test.mjs` | The prior 7 tests. Only the 7b fault loop changes: it also removes the owned marker. |
| `test/host-generation-explicit-origin.test.mjs` | The obsolete imported-running positive is now an explicit-origin control. A non-v2 runtime is never served, and adoption makes forward progress by preparing the queued revocation. |
| `run-host-authority-completion-r2.py` (new) | The bounded harness. ONE file with the bash job embedded, so root pins only this file; there is no unfilled self-hash and no missing output directory. |

## Harness (`run-host-authority-completion-r2.py`)
- **Guards:** 1 CPU, `unshare -Urn`, 1408 MiB RSS, 27648 MiB floor, no swap, 1500 s, owned session reaping.
- **Preserved checks:** every dependency/compiler/artifact/closure pin of root's `run-native-subset.sh`, plus `/usr/bin/flock`.
- **Generation order:**
  1. Layer 1 (b648a3ed) and root host files are reproduced in scratch and compared.
  2. The completion dispatch stage runs.
  3. Layer 2 permit generation runs over the exact baselines.
  4. Generated outputs are overlaid, never double-applied.
  5. The TEST-double precompile exits before any Anvil starts.
- **Suites:**

  | Suite | Count |
  |---|---|
  | denial-boundary (root's test, unchanged, vs the repaired sidecar) | 5 |
  | root-r2-integration (root's 3, including the previously failing Offline assertion) | 3 |
  | permit-protocol | 7 |
  | completion-protocol | 7 |
  | permit-adapter | 7 |
  | host-registry (final layered) | 16 |
  | root-r3-pristine (root's recorded 8 + 93) | 101 |
  | root-r3-final (root r3 tests minus the two byte-equality generator files, on the final dispatch and repaired sidecar) | exactly equal to their pristine run |
  | explicit-origin | 3 |
  | isolation-runtime / generation-certificate (final) | exactly equal to their pristine KVM runs |
  | schema3-composition | 3 |
  | root-schema3 | 6 |
  | schema3-pure | 3 |
  | independent-r3 | 5 |
  | r5 abi / policy / proof | 5 / 9 / 10 |

- **Root should verify on its first run:**
  - The 101 matches root's own r3 log.
  - The two excluded r3 files are the only byte-equality tests.

## Remaining dependencies and limits
- **Production witness reader (missing):** each production witness needs a real authenticated `authority.read` that returns same-block assignment plus host evidence `{context, status, blockHash, blockNumber, proofVerified}`. The tests use the adapter and labelled doubles.
- **Hardware enforcement adapter (missing):** production ingress/storage/secret/compute enforcement must honour `allow`/`hold`, expiry and the `hostAuthority` digest. A mock ack is not enforcement, so activation stays blocked until it exists.
- **Old-format sidecars (no migration tool):** existing sidecars on the old formats (`enclave-host-incarnation/v1`, `enclave-host-authority-permit/v1`) are refused as unknown. No automatic or migration tool is provided, so an operator must deliberately re-establish them. The old faulty file therefore cannot remain the active boundary.
- **Locked opens:** production composition must use `openLockedHostIncarnationJournal` and `openLockedHostAuthorityJournal`. Tests use the bare primitives except C7.
- **Owned-journal coupling:** for the incarnation sidecar, coupling relies on dispatch attach reading the owned host authority first, which it does. A host that loses both the owned journal and the sidecar can't be told apart from a fresh install.
- **On-chain race:** the chain can still change after the final qualified read and before mining. The transition ABI and digest don't bind host authority on chain.
- **Separate items still required:** a real qualification/prelisting-capacity service, the sponsor/economic envelope, an independent funded Offline sender, positive live Base authority, and fenced migration.
- **Superseded seeds:** the seeded `run-host-authority-permit-r1.*` and `run-host-registry-r1.*` are superseded seeds kept for provenance. Use only `run-host-authority-completion-r2.py`.
