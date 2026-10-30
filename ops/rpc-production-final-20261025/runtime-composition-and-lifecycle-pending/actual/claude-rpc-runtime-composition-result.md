# RPC runtime production source composition: scope + script PREPARED (no test, build, queue, SSH, network, commit or push)

Stage: `rpc-runtime-composition-stage/`, SHA256SUMS `c3a9aec8c47e690d…`, manifest `b854781ac2bfed03…`, `compose.sh` `c4efd37b7e3e4233…`, validation job `87d0ac69539b7d02…`.
- **Source repos read only:** linux-rpc-consumer-closure repo (verifier/consumers/lease-relay worktrees) and ~/Projects/enclave (route).
- **What ran here:** read-only inspection plus `merge-tree` trial merges, in a private `inspect.git` whose objects come from the two repos through alternates.

## Exact heads (all on github EnclaveHost/enclave fix/* branches)
| component | branch | head | base | segment |
|---|---|---|---|---|
| consumers | fix/rpc-relay-consumers-20261025 | 81ba66853 | 9fa02e1bc | 7 commits (v1 custody verifier mode, v2 canonical reads REFUSED, DNS/relay authority, opt-in self-hosted browser RPC) |
| leaseRelay | fix/rpc-lease-relay-verifier-20261025 | 433f04fa1 | 9fa02e1bc | 1 |
| verifier | fix/rpc-attested-verifier-20261025 | 2b8894a37 | 9fa02e1bc | 7 (…77d6cc859, c61dbe5fd canonical 8250 pin, 2b8894a37 portable recipe) |
| route | fix/rpc-attested-route-composition-20261025 | b3fde1812 | origin/main 5ca9e61dd | 6 = **9a4880464 snapshot** + 5 route commits |

- **History:** 9fa02e1bc sits 73 commits above 7752a4239, which is the octopus base. origin/main = 7752a4239 + 10 commits (21 docs/site/test files).
- **The route snapshot** (9a4880464, "preserve tested RPC route source without checkpoint archive ancestry") **has no lineage ancestry**:
  - it changes 1207 files vs main;
  - its tree matches no 7752..9fa02 commit (the closest is 193 files apart);
  - 221 files carry route-only content.

## Composition (compose.sh; private new repo; `git fetch` of the pinned branch refs from local paths only)
- **Stage 1: automatic, pinned.**
  - **Order:** consumers, then `--no-ff` merges of leaseRelay and verifier.
  - **Conflicts:** 0 (trial). Trees are pinned: after leaseRelay a10153ac…, final 2c034059….
  - **Invariant:** every file changed by exactly one component keeps that component's blob.
  - **Review needed:** one auto-merged overlap, `metal/guest/measured-control.mjs` (changed by all three; composed blob cdcd2679).
  - **Fixed identity/dates and recorded parents:** the merges are deterministic. Each message records the source branch, full SHA and manifest sha256.
- **Stage 2: route, real conflicts, RESOLUTION REQUIRED.**
  - **Trial size:** a trial 3-way merge (base 7752a4239) has **124 conflicts** (`CONFLICTS.tsv`). Areas: test 25, network 22, windows/node 10, metal/guest 7, scripts 6, relay 6, host-services 6, …
  - **63 are "route-older-lineage":** the route snapshot holds an older version of the 9fa02 lineage's file.
    - **62 PROPOSED, UNREVIEWED, "keep lineage":** none of them is touched by route's post-snapshot commits.
    - **1** is touched by those commits and is manual.
  - **61 have diverged.** In total **62 need manual resolution**, including the 10 that route's post-snapshot commits touch.
  - **Replay is not an option:** replaying only route's 5 post-snapshot commits conflicts at the first pick (4 files) and would drop the 221 snapshot-only route files.
  - **Mechanics:** without `--resolutions DIR --resolutions-sha256 <reviewed>`, compose stops at the stage-1 candidate and writes `review/` (base/ours/theirs/diff3 plus the route post-snapshot delta per file). With them, `apply-resolutions.py` requires exactly one entry per unmerged path, no extras, and each result's reviewed sha256.
- **Critical resolutions** (they carry the invariants):
  - **custody/v2/quorum.mjs** (v2 REFUSED; proposed: keep lineage);
  - **network/verified-chain.mjs** (unsafe tier and reorg check; diverged, and touched post-snapshot);
  - **metal/guest/measured-control.mjs**, **metal/overlay-control-image.py** and **docs/network/measured-control-guest.md** (admin controls and image; diverged);
  - **scripts/platform-api-admin.mjs**;
  - host-services and host-admission.
- **main:** it enters only as route's base (10 commits, 21 files, listed in the manifest). It is never merged separately and needs review in stage 2.
- **Seam 26393ac5: NOT included** (root r3 not passed). It is an explicit later input: `--seam <sha> --seam-repo <repo> --seam-receipt <root .out> --seam-receipt-sha256 <sha>`. The receipt must name the SHA and end `## rc=0`, and the seam is merged only after stage 2.
- **Excluded:** the Base wrapper producer, the deep-recovery workers, and any file copy outside a listed commit.

## Validation job (bounded, offline; reuses only existing repo tests)
    ./jobs/q-exit-status.sh rpc-runtime-composition-validate-1 1536 unshare -rn bash rpc-runtime-composition-stage/jobs/validate-composition.sh
    # stage 2 later: RESOLUTIONS=<dir> RESOLUTIONS_SHA256=<reviewed sha> (same command)
- **Compose:** it runs compose.sh into a fresh run dir.
- **Component tests:** for each composed component, the tests that component's own segment added or changed (`test/*.test.{mjs,py}`, no e2e) run in the component tree **and** the composed tree.
  - **Pass rule:** component pass with composed fail = REGRESSION, which fails the job. A component failure is recorded as pre-existing, never as a pass.
- **Invariant probes:**
  - no safe/finalized tier; `finality: 'none'`;
  - no provider pool or fallback; no implicit public gateway or fallback dial;
  - v2 readers REFUSE a verifier client;
  - the runtime pin and recipe files are byte-equal to the verifier head.
- **Precheck:** node_modules (attested-verifier-source) must match the composed package-lock.
- **Acceptance:** only `## rc=0`. A pass would be component-test parity on a CANDIDATE, **not an integration test** of the stack, host/control/proof-route packages or the SNP image.

## Next decisions (root)
1. Run the validation job on stage 1.
2. Review `metal/guest/measured-control.mjs` (stage-1 auto-merge).
3. Resolve stage 2: approve or replace the 62 proposals, hand-resolve the 62 others (critical files first), then pin RESOLUTIONS.tsv and rerun with it.
4. After root r3 passes, add the seam receipt.
5. Package and image builds come later, from the composed commit only.

## Not claimed
- no composed commit exists outside a future run dir;
- no integration-tested, built, packaged, imaged or SNP-qualified state;
- nothing pushed or committed upstream.

Admin controls, v2 REFUSED, the unsafe/finalized distinction and no implicit public fallback are guarded by the probes and component tests, and must be kept in the stage-2 resolutions.
