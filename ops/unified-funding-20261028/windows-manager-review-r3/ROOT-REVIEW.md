# Windows manager r3: repairs verified; actual integration incomplete

Status: NOT deployable. Frozen Claude delivery completed rc0, 37 turns; required account/Max and unchanged inputs verified. Manifest covers152 files, seven changed, none removed. This package retains those seven deltas and exact manifests/results, not a standalone portable install. Dependencies and full candidate remain in the recorded local review directory. No production mutation or Windows execution occurred.

## Executed results

The unchanged candidate ran80 tests:78 passed, two failed, zero skips/cancellations. The three prior root deadline/storage failures now pass, and the actual authenticated false-ingress-ack test still passes. Owned Linux network namespace, actual classes/signatures/MAC HTTP/separate guard/TCP, TEST backend/authority/inventory/exclusion; not Windows hardware, actual authority or production qualification. Shared512MiB/inner450, floor27648, one CPU/no swap; peak253MiB, minimum available33291MiB.

One failing cold-replay fixture lacked `confirmed.vmId`, now required by the exact-survey schema. Root changed only that field plus external test import paths; all41 tests in that file pass. Candidate/product bytes remain unchanged. Corrected fixture run peak107MiB/min33414. This gives79 distinct original tests passing, with one remaining test/policy mismatch. Do not count the overlapping41 as additional distinct coverage.

The remaining authored test expects an older permit sequence to withdraw compute within8s after a valid newer sequence. R3's new early sequence check returns403 before withdrawal. This is an explicit behavior mismatch, not proof of expired-permit serving. The next implementation must resolve and document the replay policy: reject stale sequences without extending validity; do not silently turn harmless replay into a denial-of-service against a still-valid newer grant. Genuine authority revocation/expiry/owner Stop must still withdraw.

## Four new root failures

`root-client-route.test.mjs`: zero passed/four failed/zero skips or cancellations against unchanged candidate; unit9908419b770b4962b39fea1de2648892. Guard peak170MiB/min33409.

Three scripted-control cases demonstrate client logic defects: an empty inventory drops an unknown possibly-late stage obligation; a failed hold also drops it; a held/expired view with matching digest is returned as serving. These are deliberately scripted transport tests, not evidence of an actual duplicate VM.

The fourth uses actual ProtectedManager, ControlServer, GuestdControl MAC requests and an existing loopback TCP splice. Injecting failure in the instance-journal read makes authenticated DELETE return500 before calling closeInstance at all. Cleanup restores the reader and explicitly withdraws. Direct enforcement.withdraw is repaired, but the actual Stop route still reads the journal first. An unconfirmed cleanup must remain owned while ingress and independent removal are requested regardless of journal failure.

## Remaining source findings and next work

The new ProtectedIsolationClient has no actual supervisor consumer. Main still rejects protected configuration on native/desktop paths. Composite authenticated routing lacks GET/vms needed by reconciliation. Stage reconciliation picks the first same-name instance rather than a unique exact attempt; the underlying GuestdControl retries a non-idempotent request when an unsigned401 reconciliation returns null. This is a concrete resend condition, not a demonstrated duplicate VM. Held state/digest alone is not serving proof. Backward wall timestamps currently reject withdrawal journal transitions. Boundary-close callbacks are discarded after failure, and the independent-remover author fixture checks only that a legacy VM was not removed, without asserting its intended target was removed.

The next reviewed Claude source pass must deliver actual supervisor/client/main/direct-and-composite integration and the demonstrated repairs. Genuine derived authority, Windows exclusion/Job qualification, full workload boundaries and fenced migration remain required within the full decentralization goal. Caller JSON is not qualification. No narrowing to wrapper-only or refusing desktop/GPU/storage/secrets as a completed implementation.

Production apps, payments, relay, site, pad guards and RPC-off state are unchanged. Previously completed deposits/grants must never be repeated. Windows test-launcher cross-compilation is separate and remains unexecuted on Windows.
