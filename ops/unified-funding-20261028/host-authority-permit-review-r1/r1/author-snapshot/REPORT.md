# Host-authority permit r1 (task 0601c3e1), source only

**Status:** nothing has been run. No tests, compiler, CLI, network, Git, provider, wallet or service action. There are no pass results and no qualification claim.

**Baseline:** root r3, which is authoritative over the original repair-r1. The baseline inputs are listed in `../input-pins.json`:

- Generated adapter b648a3ed.
- Host files 76f5be11 / ae53da9f / 9a155041, plus the corrected host generator 7073e59c.
- Incarnation journal 49351d80.
- Runner 75590c8e.
- Protocol modules from the reviewed checkout.

The following stay unchanged:

- The seeded copies under `src/network` and `src/tools`.
- The Solidity, the registry source/artifact and the schema3 bundle.
- The original r4 test and its failure evidence.
- root r3's explicit-only default, adoption serialization, pending/quiescence refusals and owner-epoch checks.

## Files written in this stage

| File | Purpose |
|---|---|
| `src/network/deployment-host-authority.mjs` (new) | Canonical host-authority context (`enclave-host-authority/v1`):<br>• chain id, profile, registry address and runtime code hash, host id<br>• exact host generation and the immutable qualification digests (qualification, trust anchor, hardware, resource, descriptor)<br>• owner, owner revision, policy hash, reporter-policy digest, reporter revision<br>Every field is EIP-712-hashed, and uint64 values are exact decimal strings (an unsafe Number is refused).<br>Also contains:<br>• v2 ServingPermit typed data under domain `EnclaveServingPermit`/`2-host-authority`, with the context as a nested struct. It is selected only by `pins.servingPermit = {version: 2, profile: 'independent-host-registry-r1'}`. Any other value is refused, and a v1 record under v2 pins is refused.<br>• The verifier-side check: own-reader evidence, `proofVerified` (never a nested `verified`), same block, Online, host admission, and a monotonic two-axis floor.<br>• The real snapshot→servingContext conversion. |
| `src/network/deployment-host-authority-journal.mjs` (new) | Durable sidecar for gate and witness:<br>• Strict nested validation.<br>• `expectExisting` lost-file refusal; detects a file disappearing or changing underneath the process.<br>• Any write/fsync/rename/directory-fsync failure latches unknown for the rest of the process.<br>• Host-wide floor on two monotonic axes (host generation, owner revision).<br>• Per-app explicit handoff bindings (`fresh-queued-start` or `explicit-adoption`), never a genesis default. |
| `src/tools/generate-host-authority-permit-candidates.mjs` (new) | Hash-pinned insertion generator: restoration self-proof, marker `host-authority permit r1`, no output written into the input directory. Applied to serving-permit 82494ed8, permit-gate e198fe21, lifecycle-witness 9859a130, isolation-runtime 40333d5b, and a second stage over root's adapter b648a3ed (root's generators are never re-applied). |
| `test/host-authority-permit.test.mjs` | 7 protocol tests. |
| `test/root-host-authority-adapter.test.mjs` | 7 tests: the actual adapter against the actual registry on Anvil. |
| `test/host-generation-explicit-origin.test.mjs` | 3 tests: the r4 control, updated to start from an explicit adoption origin instead of the obsolete imported-running start. |
| `run-host-authority-permit-r1.sh` / `.py` | Proposed bounded harness, 175 exact checks. Root fills `SCRIPT_SHA256`. |

`REPORT.md` is this file; the seeded r3 report it replaces is preserved at its root r3 source path. The seeded `run-host-registry-r1.*` and every other seeded file are byte-identical to their seed sources.

## What the generated insertions do

### Serving permit
- Under v2 pins, permits use the v2 typed data.
- `validateServingPermitContext` additionally checks the verifier's own same-block host evidence, current host admission and the durable floor.
- `verifyServingPermit` returns the signed context.
- v1 is unchanged.

### Collector
The source is unchanged. Under v2 pins, signing and reply verification go through `servingPermitTypedData`, so they use the v2 domain and context. A record without the context is refused before the operator signs.

### Witness
- Under v2, the witness requires its own sidecar.
- It derives the host authority from its own authenticated `authority.read`, never from the request or transport.
- It persists the floor before signing.
- It re-reads authority after the readiness wait and again after signing. If the authority changed, the internally produced signature is never released.

### Gate
Before any resource is allowed, `install` checks the floor, persists it, and requires an explicit handoff binding for this app.

Grants are dropped in these cases:

| Trigger | What is dropped |
|---|---|
| A different host authority for the same app | That app's grants. Applies even at the same app assignment generation. |
| A host-wide advance seen through any app | Every grant of an older authority, for all apps. |
| An uncertain sidecar | Everything. |
| An install that lost an epoch race to a handoff or hold | That install fails. |

`assert`/`track` and the returned grant carry the exact digest, and the existing expiry, monotonic-clock and epoch logic is kept.

`handoffHostAuthority` is the only path for a legitimate owner-revision increase: the app context must be fully withdrawn first, and there is no permanent equivocation for a legitimate increase.

### Runtime
- The v2 record carries the context taken from the authenticated snapshot.
- `gate.install` receives `servingContextOf(snapshot)`. This keeps the runner's operational `generationAuthority` and adds the same-block host evidence plus the current host admission, which the runner already folds into `snapshot.admitted`.
- The boundary `allow` acknowledgement must echo the context digest.
- A fresh queued `ensureStaged` is an explicit handoff.
- `adoptHostAuthority` fences, then hands off.

### Adapter (new profile, Running only)
- **Prepare:** does a fresh proof-qualified read and requires the host Online and equal to the admitted snapshot evidence. It persists `{context, provenance: {intentDigest, block}}` inside the canonical payload, which the runner already writes durably with `prepareTransition`.
- **Parse:** accepts exact old payloads without the context, so resolve/finalize of in-flight transactions keep working.
- **Submit:** refuses a Running payload that has no context. After the actor and witness signatures, a final guard re-reads the assignment, budget, emergency state and canonical host at one block. It checks deadline, fee, admin, assignment generation/revision, Online status and the exact context digest. This is the last await before `relay.send`.
- **Read:** snapshots expose `hostAuthorityEvidence`, or `null` when there is no servable authority. A nested `verified` is never emitted.
- Stop, queue, emergency and reconciliation paths are unchanged.

## Acceptance coverage (tests authored; none run)

| Item | Where |
|---|---|
| 1 | Protocol test 1 (fresh queued origin). |
| 2 | Protocol test 2, plus root r3's own controls. |
| 3 | Protocol test 3. |
| 4 | Protocol test 4. |
| 5 | Adapter tests 5a–5d (send spy stays at 0; exactly one send in the positive case). |
| 6 | Adapter tests 6, 6b, 6c. |
| 7 | Protocol tests 7a/7b, plus root r3's pending/quiescence/serialization tests run unmodified in the r3 tree copy. |
| 8 | r5 abi/policy/proof regressions on this stage's second-stage adapter; schema3 and independent regressions; root r3's 101 recorded checks; the updated r4 control. |

The original r4 imported-running positive control is not run, because under the explicit-only default it is obsolete.

**Test doubles, named:** witness transport (an in-process fetch instead of `deployment-witness-http`), each witness's chain reader, the manager client, plans, readiness, the runtime boundary `hold`/`allow` acks, Anvil finality authority, receipts and the relay spy. A mock `allow`/ack is not production enforcement.

## Blockers and limits
- **Production enforcement adapter (blocker):** the boundary that actually enforces `allow` (ingress/storage/secret/compute expiry, bound to the host-authority digest) is not among the pinned inputs. v2 activation stays blocked until that adapter exists and echoes `hostAuthority`.
- **Dispatch adoption wiring:** root r3's `dispatch.adoptHostIncarnation` does not yet call `runtime.adoptHostAuthority`. Explicit adoption therefore currently reaches the gate only by calling the runtime directly, or through a fresh queued start. A follow-up hash-pinned stage over root's dispatch 9a155041 is needed for that wiring.
- **Residual on-chain race:** the chain can still change after the final qualified read and before mining. The transition ABI and digest are unchanged, so the host authority is not bound on chain, and no atomic preflight is claimed.
- **Witness adapter contract:** each witness's `authority.read` must return `hostAuthority: {context, status, blockHash, proofVerified}` from the same block as the assignment. No production witness reader implementing this exists in the inputs.
- **Lost-journal detection:** `expectExisting` must be supplied by the operator. A lost sidecar on a fresh install can't be told apart from a first run.

## Root must verify before or when running
- Whether the REPO collector, witness-http and serving-permit (and their imports) are compatible with the KVM-commit tree versions they replace.
- The `root-r3` expected count of 104 (= 101 recorded + 3).
- Harness nit: `$OUT/one` must exist before the second `precompile-test-doubles.py` call. Add `mkdir "$OUT/one"` — I left this unfixed rather than assume the script's behaviour.
- Node test-reporter counts for each suite.

## Still required, separately
- Real qualification and prelisting-capacity service.
- Sponsor/economic envelope and Stripe liability checks.
- Independent funded Offline sender.
- Positive live Base authority.
- Fenced production migration.
- Hardware/boundary enforcement adapter.
