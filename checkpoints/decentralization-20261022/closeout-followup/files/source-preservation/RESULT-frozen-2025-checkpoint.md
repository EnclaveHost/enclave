# Checkpoint publication, batch "2025": custody v2 r2, recovery evidence, dashboard, live reconciliation and metal0 enrollment records

"2025" is this batch's identifier: its actual start, 2026-10-23T20:25:57Z (`date -u`). It is not a year. Every time below is
measured. This is SOURCE and EVIDENCE preservation only.

- **Custody v2:** the corrected custodian r2 (from ab589bf8, measurement 70aadff5) is reproducibly built and has quote-only SNP
  startup and outage-recovery evidence. It is NOT activated. Existing custody is the original single-seat bootstrap, NOT
  decentralized custody.
- **metal0 handoff 7b49cd99:** its old plain-transfer fund stage REFUSES the EIP-7702-delegated operator and is not usable.
- **Not done:** nothing was signed, sent, funded, served or activated.

**Pushed:** `checkpoint/decentralization-20261022` dc551728 → **`619e0e34ca6321dad2e872a76d4da565969c4e66`**, tree
**`20888f8079a72cc2e63f86195d13573dfe647d02`**.
- **Commit:** made at 20:33:55Z (git 13:33:55-07:00), by SteveDeFacto (noreply) as author and committer. The pre-commit and
  pre-push hooks ran (pre-push: gitleaks with the pushed commit's config); none was bypassed.
- **Push:** a normal fast-forward, which returned by 20:34:30Z.
- **Independent check:** `ls-remote` at 20:34:35Z (postpush job) reads checkpoint 619e0e34 and main
  **68b82926968c99503d38ae78dbcb04694cc2c56c**, unchanged.
- **Not done:** no main write, force push or history rewrite, no SSH, production, wallet, RPC or live action, and no edit in any
  worker tree.
- **Queue:** every job ran through the unchanged queue in the **256 MiB lane**, and no job was stopped. Peaks: 0–91 MiB.
  - 13 tries answered `NOT STARTED: small allocation held`: 7 for export-1, 5 for snapshot, 1 for snapshot-2. They are kept as
    `*.tryN.out` and were retried at the same cap.

**Frozen input list.** Root's designated heads (ROOT-PRESERVE-TASK.txt), resolved at 20:25–20:27Z and not grown afterwards. Every
author and committer is SteveDeFacto (noreply); there are no merges.

| Side | Base (pushed in dc551728) → head | Head tree | Reproduces |
|---|---|---|---|
| durability3 | a5eae96c (frozen-1951 durability2) → **ab589bf8** | 0a1f82e1 | touched files only (2 new tests) |
| custody-release2 | 44bf8f4f (frozen-1951) → da6e3496 → **23f7e51a** | 62adfd03 | exact |
| dashboard2 | 4acad4a7 (frozen-1951) → 10cea38b, 7f0320a4, dd6cf94a → **e24a47fb** | 413e76ec | exact |
| custody-live3 | 70019fdf (frozen-1951 custody-live2) → 574fdc97 → **3fd6e8ff** | b7857703 | exact |
| wallet-handoff | root → **7b49cd99** | da50e554 | exact |
| operator-proposal | root → f2a7b81e → **1ac9ad2c** | e6a98714 | exact |
| snp-harness | root → e9b9709a → **7c4844a1** | 0fb8af49 | exact |
| direct-route | root → **fc7bff94** | 474c9922 | exact |

- **Reproduction:** `frozen-2025-export/REPRODUCE-CHECK.txt`. All 8 sides are true. Every base was rebuilt offline from dc551728's
  stored patch chains: dashboard from dfe020ab plus 26 patches, custody-live from 2 patches, custody-release from 1.
- **durability3:** it continues the touched-file mode of frozen-1951 and frozen-1852, because the base descends from the
  unpublishable pre-rewrite c635fd68. Both touched paths are new, so `base-files/` is empty.
- **Stability:** INVENTORY `f4c131d4` was byte-identical across two exports, in both the export-3 and capture-2 jobs.

**Scans, with no allowlist and `.gitleaks.toml` unchanged:**
- Prescans in export-1/2/3: gitleaks (checkpoint config) found no leaks over the export directory or the 4 frozen/evidence files,
  and `scan-crypto-keys --files` gave 0.
- Range scan `dc551728..619e0e34`: scan-crypto-keys 0, gitleaks no leaks. The pre-commit and pre-push hooks also passed.
- Nothing needed omission or sanitizing, so there are no derivative sides.
- The repositories' own committed scanner reviews are preserved unchanged as evidence. These are root's reviews of public values
  under the repos' own scans: the release `SCAN-REVIEW.txt` (public snpkey executable SHA256 and canary X25519 key), the SNP
  harness `SCAN-REVIEW.md` (public encKey) and custody-live `SCAN-REVIEW.txt` (public source-file SHA256 values).

**Manifest:** 5386 → **5530** (+144, 2,036,820 bytes).
- **Old entries unchanged** (`frozen-2025-oldbytes-check`):
  - `dc551728..HEAD` only adds files, apart from MANIFEST.json and README.md;
  - all 5386 old entries and the earlier `appends` records are identical JSON;
  - every old entry's committed blob still matches its sha256 (0 mismatches);
  - README.md kept every old line.
- **Content check:** 146 committed files, with no binary, no file over 5 MB, no rewritten literal in either case, and no
  private-key block.
- **Tracking:** 5530/5530 entries are tracked and match their committed blobs.
- **Force-added after sha verification:** three ignored-pattern evidence logs: the snp-harness `memory.log` and the direct-route
  `probe-tools.guard.log` and `scan.guard.log`.

**Captured besides commits:**
- root receipt `custody-v2-snp-startup-recovery-20261023.json` (20:16Z);
- the 1951 receipt;
- a dated snapshot of ROOT-CONTINUE-LATEST (through the 20:23Z entry);
- a dated snapshot of root's living `custody-v2-live-verification-20261023.md`.
  - capture-1 (rc 1, before any write) refused it as a source already in the manifest. Its earlier bytes (`23c9aeba…`) stay
    stored unchanged, and the current bytes (`a033b002…`) are `snapshots-2025/custody-v2-live-verification-20261023.snapshot-2025.md`.
- ROOT-PENDING-LATEST and effective-goal-requirements are byte-identical to their frozen-1852 snapshots (asserted), so they were not
  copied again.

**Never read or captured:**
- images, binaries, node_modules, raw quotes, guest console logs, sealed state, private config and keys;
- untracked files in any repo, including root's ROOT-* task files and the worker progress/err files in custody-wallet-handoff;
- outer non-repo files;
- commits after the frozen heads.

**Post-push:** the 4 frozen inputs are unmoved, and 6 of 8 source repositories are at their frozen heads.
- **dashboard** advanced to 2d3839c5 (13:28:04-07:00, docs). It is **NOT captured**; e24a47fb is its ancestor.
- **custody-live** advanced to bc3f93c0 (13:30:16-07:00, "Pin the original v1 vault before consumer inventory reads"). It is
  **NOT captured**; 3fd6e8ff is its ancestor.

**Attempts (all logs retained):**
- **export-1, export-2, export-3, snapshot, snapshot-2:** passed.
- **capture-1** (rc 1): the manifest-source refusal above; nothing was written.
- **capture-2, commit, scan, content check, old-bytes check, push, postpush and derivative-heads:** passed.

Root will verify the remote independently.
