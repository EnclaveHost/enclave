# Windows r12 root review: real consumer passes after narrow repairs; sender durability remains blocked

No production activation, Windows execution, live chain transaction, app recovery, signature request or additional deposit occurred. This is the highest-priority lifecycle/funding work within the censorship-resistance goal. Existing production grants, payments, apps, administrator controls and storage remain unchanged.

## Source and provenance

The same verified Max Claude invocation `bc915cd7aa3442a29e9e32f866184ae4` finished rc0, session `60733bbc-f643-47e3-9af9-df661721edfe`, duration706570ms. Its230-file delivery has20 changed/new files and no removals; manifest SHA256 `0c04ee45aa28215eb0cd5577654bda1f460d57261b4dbfdc0fda60e5b1d966d5`. All7285 readonly inputs stayed pinned. Mutation replay found no unexpected tool, outside write or discrepancy. Raw94 turn count and44 distinct assistant message IDs are different counters; configured cap55. All known author processes were gone before root execution. The original author delivery remains unchanged in `candidate/`.

The report's “authored first” description is inaccurate: the consumer fixture was written at mutation event50 of52, after production edits and the durable-record test. The original report is preserved. The original consumer also claimed two managers but configured `nativePins:null` and `nativePort:1`; its first actual execution failed before the Host path at “router configuration absent.” These are test/provenance errors, not production failures.

Root's separate `repaired/` tree changes exactly three product files (see `root-repair-changes.json`):

- `protected-supervisor.mjs`: derive catalog appId/index from the already validated authenticated appRef. The unchanged projection dropped them; the real Host/isolationPlan refused a valid app with `version.appId` absent.
- `control-client.mjs`: an optional synchronous `beforeSend` check executes inside the actual send path after session acquisition/renewal and reconciliation, immediately before request signing/transport invocation. No asynchronous callback is accepted.
- `protected-isolation.mjs`: stage and permit supply the live owner/policy check to that boundary. Stop, hold, cancellation and read-only reconciliation do not depend on new-work admission. Existing uncertain-operation retention is preserved.

## Executed results

All runs use sequential process isolation, an owned loopback-only network namespace,512MiB hard/noSwap,450MiB RSS guard,27648MiB host floor and one CPU. Eleven owned units ended with MainPID0; their private temporary directories were removed. Guard logs and exact failed outputs are retained. Runs overlap; do not add their counts as unique coverage.

| Evidence | Result | Meaning |
| --- | --- | --- |
| `consumer-result.tap` | 0P/1F | Original author fixture omits required router/native configuration. |
| `fixture1-result.tap` | 0P/1F | Root fixture typo used record.component.cid; vector actually carries record.cid. Retained, corrected only in fixture2. |
| `fixture2-result.tap` | 0P/1F | Valid external inputs reach actual Host/isolationPlan; product drops authenticated appId/index. |
| `repair1-result.tap` | 0P/1F | Projection repaired; TEST authority label must be exactly TEST, not descriptive text. |
| `repair2-result.tap` | 1P/0F | Full positive consumer succeeds after fixture-label correction. |
| `consumerall-result.tap` | 3P/0F | Full positive, plan A/context B refusal then replan, policy corruption after planning with Stop available. |
| `transportbefore-result.tap` | 2P/2F | Actual GuestdControl handshake held: revoked stage and permit still reach real authenticated ControlServer handler. Unchanged-authority controls pass. |
| `transportafter-result.tap` | 4P/0F | Same tests pass after the final-send check. No mutation reaches destination after revocation during handshake. |
| `regression-result.tap` | 71P/12F | Broader repaired-source suite, including full consumer and transport checks; obsolete fixtures described below. |
| `fixtureclosure-result.tap` | 29P/1F | Corrected external fixtures; remaining sponsored release pending-result assertion fails and remains unresolved. |
| `durablegaps-result.tap` | 3P/2F | Three author durable-sender cases pass; two new independently reproduced durability gaps remain. |

All results above have zero skipped/cancelled tests. The transport handler is a TEST destination that counts authenticated mutation arrival and refuses it; it launches no VM. Test sender accounts/wallet RPCs are inert public TEST fixtures: no real transaction or money movement.

The positive consumer is actual Host.protectedTick/private launch/isolationVerdict/real envelope parsing → real factory and owned parent/incarnation/permit journals under Linux flock → real route attach/quiescence binding/activation/admission and runtime/gate → ProtectedIsolationClient/GuestdControl handshake+MAC → actual router snapshot/precheck/admission and both manager servers → real guard process → router TCP splice. It verifies one queued stage with repeated-pass stability, Running, two increasing off-chain permit sequences/new digests, TCP echo, authenticated Stopped stream closure/exact removal and owner release. No claim/renew/release/heartbeat was called for the enrolled route; no retired ledger/catalog read occurred.

Explicit external TEST inputs remain: canonical snapshot/finality and quiescence evidence, public TEST witnesses, host identity/legacy-service stand-ins, JSON Hyper-V inventory/launcher/readiness and headroom. The native-role manager is real with TEST desktop.ready=false; no native protected workload or ordinary neighbor is established by this new fixture. It is not a real Windows/Hyper-V boot, live Base authority, crash recovery, complete Host.tick housekeeping or independent ledger Offline submission. Prior neighbor evidence remains separately scoped.

External corrections preserve source and security assertions: r5 forwards the real transport timeout/cap arguments; r7 releases ownership after actual fetch invocation (the earlier fixture released before request setup, now correctly refused by the new fence); r8 supplies its real pinned TEST policy; r11 supplies explicit TEST journal paths and calls the new diagnostic function rather than mutating its former array. The r11 sponsored path still uses the historical TEST lease-client emulator, not the shipped bundle. Its release/signature-time-refusal case expected pending=true and a retained release-journal intent, but the new withheld-signature path returns pending=false. The durable sponsored record may still retain the signature; this result is an unresolved compatibility/reconciliation check, not evidence of a disclosed signature or actual duplicate payment.

## Remaining reproduced sender failures

`root-durable-gaps.test.mjs` exercises the actual serialized sender and record store with inert wallet/RPC fixtures:

1. An unresolved write is recorded, its exclusive TEST journal file is deleted, and a fresh module with the same identity/nonce performs another inert write. Missing established state is treated as genesis. Expected one write, observed two.
2. Permission ends after intent persistence but before wallet invocation. Zero writes occur, but the exact sending record remains and waits for a nonce that was never broadcast. Expected zero unresolved records, observed one.

These are module-reconstruction/file-loss tests, not OS power-loss or live-payment observations. The previous ordinary fresh-module/retained-file test now passes. That does not qualify file loss, independent owners or storage errors.

The frozen peer source review additionally identifies missing physical exclusion; directory-fsync errors swallowed as unsupported; unchecked short writes; truncated intent arguments; and sponsored recovery using current account/chain rather than the recorded signing domain. These are source findings unless independently executed above. Reuse reviewed platform-specific ownership/durable primitives, with explicit installation/genesis and ordinary opens requiring established state. Retain unresolved records and their exact identity; no automatic replay, replacement, nonce jump or operator-funds fallback. A focused repair is next, not another broad integration rewrite.

## Deployment and remaining goal

This candidate is NOT deployable. Remaining work includes sender ownership/durability and actual sponsored-client qualification; config/version closure (including separate configuration CIDs); independent live authority and quiescence; Windows storage/exclusion and native useful-workload qualification; zero-gas measured capacity/attestation bootstrap; paid-work/provisioner sponsorship preserving liabilities; protected Offline gas/independent submitter; authorized automatic refill and self-host Top up; fenced production migration. The full refusal/cold-recovery/new-user/storage-failure decentralization demonstrations remain outstanding.

The published package is an evidence/source delta, not a standalone runnable release. Full230-file original and repaired snapshots are local at the corresponding `windows-manager-root-review-r12` directory. Exact manifests pin both. Runtime installation, source activation and production payments require the outstanding technical gates; existing finite grants do not expand to new contracts.
