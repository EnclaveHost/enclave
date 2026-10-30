# Ownership completion review: partial implementation, not activated

Claude ownership-r3 stopped at its45-turn limit (CLI reports46), rc1/error_max_turns. All240 read-only input pins remained unchanged. Frozen41 author files have manifest221a4a6265cfb1db48d07dac5f4456d43b6df1692bdb76cc97d7d4165995a304. The inherited REPORT and broad harness are not new deliverables or results. Verified account: steven.r.batchelor@gmail.com, Max. No production mutation.

## Direct terminal-source findings

Root tested the exact terminal owned-durable-state implementation plus real runtime flock. Three cases: control PASS, two failures, no skips. An asynchronous withdrawal listener remained pending while release returned success and a second real owner acquired the lock. A fault at the final intent-removal directory fsync caused the current handle to refuse, but a fresh open had no intent, failed:null and accepted the new state. This is isolated local filesystem/owned-process evidence, not a production incident. Unit eaa5bb0358af4b158e35b4b1b5c66a22 ended/MainPID0. Small256MiB/220RSS/floor27648/oneCPU/noSwap; source pins rechecked after tests.

The separately frozen previous runtime/real gate test had a positive open-gate control PASS and closed-gate lookup race FAIL: close during initial manager lookup, then spawn1/ready:true/instances1. The manager is a TEST double. This test used completion-r3 protocol modules, not the new terminal generator. Terminal source review found no ensureStaged post-await lifetime repair, so it remains an acceptance case for the next candidate. Do not conflate the two source versions.

## Narrow root adoption repair

The terminal generator added a canonical authority read after runtime adoption but followed it with an awaited inventory lookup. Root reproduced owner, Offline and generation changes during that final lookup. Actual generated dispatch/composer and durable incarnation file, with MOCK chain/runtime/inventory: before5 cases2PASS3FAIL; after5PASS0skip. The fix moves inventory lookup before the canonical authority read and local epoch validation. Failed current authority triggers the revocation hook; no durable old binding is created. Existing unchanged-state positive and earlier runtime-await owner-change rejection still pass.

`adoption-await/after/generator.mjs` is the reviewed corrected generator. Its generated dispatch is output under after/generated; exact baseline hash/insertions/restoration are verified by the generator. It is a root overlay for the NEXT combined candidate, not a claim that all41 author files pass or are installed. Production snapshots can change after any observation; this test proves refusal when changes occur across the specific awaited local operation.

The first root fixture preparation failed before creating after/generator and a shell continuation started a unit without run.py; NO tests ran in that invocation. Preparation error retained. Corrected unit69f8adaa46d548f3b40f00aaea107b5c ended success/MainPID0; before/after result codes1/0; input pins unchanged. Bounds256/220/floor27648/oneCPU/noSwap.

## Remaining implementation

Actual resource withdrawal must finish before either owner lock is released; failures remain fenced. Gate/witness/runtime/dispatch retained references and in-flight manager operations must share the same owner lifetime. Final durable intent acknowledgements and recover acknowledgements must preserve ambiguity across reopen. Parent-journal coupling and forwarded operations still need review. Runtime handoff revocation must invalidate bindings even if boundary cleanup fails. Full93+8 regressions and native16/adapter7 must run against the combined corrected candidate, not an inherited harness/report.

Root reviewed one focused Claude r4 source-only task, next-task/TASK.txt. Its35turn/1200s/1536MiB1408RSS/floor27648/CPU1/noSwap run is separately coordinated; no automatic retry. Root canonical-order fix must be merged after delivery without mutating frozen author inputs. Independent Base authority, actual manager deadman/ingress/storage/secrets, prelisting capacity+attestation, protected Offline funding/sponsors, automatic authorized funding and per-app production migration remain required within the full censorship-resistance goal. No app recovery or production readiness claim follows these tests.
