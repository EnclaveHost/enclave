# Checkpoint publication, batch "1517": A receipts, E production build, F runtime + gap repair, M, S, C, T, root API/MCP

"1517" is this batch's identifier: its actual start, 2026-10-23T15:17:16Z (`date -u`). Every time below is measured. These are
source and test CANDIDATES, not production completion. No pending result is reported as passed.

**Pushed:** `checkpoint/decentralization-20261022` 4aaba75b → **`b995a73b6b3ae51d1812607da0e4d8ea6fd32f6e`**, tree
**`ebfd8cc15fa1f6b8615843833b029cc9ee9197e7`**.
- **Commit:** made at 16:29:07Z (git 09:29:07-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran; none was bypassed.
- **Push:** a normal fast-forward at 16:30:42Z, on the second attempt (the first got GitHub HTTP 500; see below). An
  independent `ls-remote` at 16:31:00Z reads checkpoint b995a73b and main **68b82926968c99503d38ae78dbcb04694cc2c56c**,
  unchanged and not touched.
- **Not done:** no force push, rewrite, SSH, production, wallet, signing or contract action, and no edit in any worker tree.
- **Queue:** every job ran through the existing queue. Git, scan and capture steps used the 256 lane (peaks 60–189 MiB);
  exports and the bundle check used 1024 (peaks 115–298 MiB). Nothing about the queue was changed, and no job was stopped.

| Side | Base (in pushed 4aaba75b) → head | Head tree | Reproduces |
|---|---|---|---|
| e-prod | dc2e5d74 → e078490d (merge of published main 68b82926; one diff vs first parent) → **ae00cd96** | 51591856 (= root's) | exact |
| m-cancel | 4c059b99 → 1c386e23, 808f36c5 → **3746e4fc** | 77680c02 | exact |
| s-iface | 36919aaf → **4f7632d7** | b246ba51 (= root's) | exact |
| t-compose | a9f0155c → 29c6de87, cfa165fb, c55917de → **4bb72315** | bf6d3c7a | exact |
| ts-compose | 92b71784 → 97758444 → **fb9ce4a7** | 95fb9917 | exact |
| root-api-mcp | root → **95ee73dc** | 5d4c8269 | exact |
| f-runtime-gap | 1f19ad15 → 896c5d49 … **0de09415** (orig 5cbdb670 = root's) → **dda47a35** → **0ed6b6d9** (orig dfb63eaf = root's) | 21fc9a74 | derivative (1 file) |
| a-receipts | 554a251c (a-gaps derivative) → 1d829457, cdcbdf59, 23fa880a → **eab4cfac** (orig e0e07f21 = root's) | 29a70f5d | derivative |
| c-shard | root → 5c9717fc … **5c317531** (orig 436f191f) | 6a562d19 | derivative (5 vendored files) |
| tp-compose | f8c999ed (p-compose derivative) → 1db4d408 → **ed814e58** (orig 84a0b214) | 963d1a97 | derivative |
| s-iface-report | root → eb7f0db6 → **a32d209e** (orig d4b36e6e) | fd0bbaaf | derivative (1 file) |
| t-report | root → **be3392d2** (orig c42cb04b) | 6d450219 | derivative (1 file) |
| e-prod-report | root → 3d47052b → **4beedc5b** (orig 5549e103) | 92b8be9b | derivative (`exports/`) |

- **Reproduction:** `frozen-1517-export/REPRODUCE-CHECK.txt`. All 13 sides are true, from 4aaba75b's stored patches.
- **Stability:** the final INVENTORY `bfa44164` was byte-identical across two exports, in both the export-4 and capture-2 jobs.
- **Export format:** first-parent, one patch per commit. A merge is one diff against its first parent. Hunk headers have no
  function context; this is cosmetic, and `git apply` ignores it.

**Omitted, with restore recipes** (INVENTORY `derivatives` / `untrackedBuildOutputs`):

| What | Why | Restore |
|---|---|---|
| A `metal/guest/mcp-server.bundle.mjs` @eab4cfac (5,064,161 B, sha256 17cfb64f…) | compiled, over 5 MB | `build-mcp-guest-bundle.mjs` with A-receipts' node_modules links. **Validated** by frozen-1517-a-bundle-check: queue EXIT 0 at 15:22:03Z, `--check` rc 0, 3032 inputs. The text was written only after that log existed. |
| A `…bundle.mjs.manifest.json` @eab4cfac | gitleaks false positive | `converted/` sums + meta; exact rebuild asserted |
| A patch 0021 | A's diff of the compiled bundle | hash recorded |
| F `test/service-index.test.mjs` (held at 1f19ad15) | gitleaks generic-api-key on a test argument | F's repository |
| C 5 vendored sia-sdk-rs files (`seed.rs`, `types/{spendpolicy,v1,v2}.rs`, `sia_storage/src/builder.rs`) | upstream public test vectors and BIP39 TEST mnemonics | upstream sia-sdk-rs e1d1ebe0. **Not verified** against upstream (offline); blobs recorded |
| tp-compose: P's 5 paths | as frozen-0931 p-l1 (identical blobs) | frozen-0931 recipes |
| S `patch/…36919..4f7632d7.patch`, T `receipts/run4/journal.txt`, E report `exports/` | duplicate patch with dev-key fragment / kernel build-key fingerprint / git bundle + duplicate patches | the source repositories |
| E dist / build-tree / compiled tar | build output | E RESULT-PRODUCTION-BUILD.md. `outputs/dist-manifest.sha256` = 9904f5e0… (captured). Two generated files are stale (root); not accepted as final production. |
| F `node-closure.tar` (binary) | build output | `.sha256`, deploy lists and F's `verify-closure.sh` captured; D did not run that script |
| C `artifacts/*.wasm` (candidate 55888a41, 4,556,225 B) | compiled Wasm | C RESULT (rebuilt from 9eb6533 to the identical 55888a41, per C). The deployed old artifact still has the bug. |
| S untracked `packages/` (12 files) | build output | recipe recorded; `public-rpc.package.json` = 78f06b5b, matching S's report; not rebuilt by D |

**Manifest:** 3910 → **4439** (+529, 12,076,921 bytes); 0 changed, 0 removed.
- **Prescans** (export-4): gitleaks found no leaks over the export directory or the 88 staged frozen/evidence files.
  `scan-crypto-keys --files` over the same bytes gave 0.
- **Range scan** `4aaba75b..b995a73b`: scan-crypto-keys 0 and gitleaks no leaks (12.46 MB).
- **Content check:** 531 committed files, with no binary, no private-key block, no rewritten literal, no file over 5 MB, and
  no wasm, tar or bundle file.
- **Tracking:** 4439/4439 entries are tracked and match their committed blobs.
- **Post-push:** 88/88 frozen inputs are unmoved.
- **Source heads:** 13 of 14 are still at their frozen commits. `api-mcp-recovery` has moved to 844edbf2, root's newer active
  work; the frozen 95ee73dc is its ancestor and was captured exactly, and 844edbf2 is NOT captured.

**Captured besides commits:**
- outer files for F runtime and gap repair, M, and A (RESULT, HANDOFF, patches, deploy lists, job scripts);
- root notes from those directories, and from my directory (the NEXT designations, REBUILD-STATUS-REVIEW, SMALL-LANE);
- root receipts `windows-integration-j1-review` (F is now terminal) and `api-mcp-recovered`;
- the 1339 receipt;
- snapshots (15:28Z) of root's journal and the requirements.

**Not captured:**
- **Active successor work:** A credit-vault-submitter-verifier, E site-generated-artifacts-reconcile, new F/S/T work, B, P,
  and root's api-mcp work after 95ee73dc.
- **Untracked files**, including api-mcp's untracked progress/task files and its live root notes.
- **Root's journal additions after the snapshot.** At 15:44Z root marked its RPC integration review 1d4920ca for the NEXT
  batch and said the NucBox 96 activation evidence is not to be captured yet.

**Attempts and failures (all logs retained):**
- **a-bundle-check:** passed first time.
- **export-1** (rc 1): my relative paths to `work/` were one level too high (FileNotFoundError). Fixed and pre-checked.
- **export-2** (rc 1): gitleaks prescan, 18 false positives. The report is kept as `frozen-1517-prescan-gitleaks.export-2.json`.
  The fix was four derivative omissions and patch format without function context.
- **export-3:** passed all three checks then in place: export, verify and the gitleaks prescans.
- **capture-1:** passed, but the commit was REFUSED by the pre-commit `scan-crypto-keys` hook. It found 54 BIP39 test
  mnemonics in two more vendored upstream files, which gitleaks had not flagged.
  - No commit was made. I reset the index and removed exactly that capture's 531 stored files by its own manifest entries,
    byte-checked (`frozen-1517-capture-1-revert.txt`). MANIFEST.json and README.md were restored.
  - The two files were added to C's omissions, and `scan-crypto-keys --files` now runs in the prescan. **My gap:** earlier
    batches prescanned with gitleaks only.
- **export-4, capture-2, commit-2, scan:** passed.
- **push-1** (rc 1): GitHub answered `remote rejected (Internal Server Error)`, and the remote stayed 4aaba75b. **push-2**,
  the same fast-forward, succeeded.
- **Wording I corrected:**
  - I first wrote that F's `verify-closure.sh` rebuilds the tar. I haven't run it, so that is now "captured; not run by D".
  - The revert note's first line first said the capture "was committed". It was only staged.

**Limitations:** offline source and test evidence only.
- C's fixture used known hosts with filtering, not WAN.
- T ran local systemd/guest tests only, with no physical deployment.
- S's TLS and history gaps remain.
- E has not proven real MetaMask or Alto, and its stale generated files are unresolved.
- F's native and integration gates are unrun.
- A's restored bundle was validated, but the C upstream restores were not checked offline.

Root will verify the remote independently.
