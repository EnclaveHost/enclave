# SNP startup-recovery canary (source only, root-run)

**Status.** Source and unit tests only, for root review. Nothing here has been run on hardware. No QEMU, SSH, chain
write, live service, real config, key or sealed state was touched while preparing it. **No hardware pass is claimed.**

## What it shows

It boots the REAL measured custodian image three times on one fresh, canary-only sealed state:

| phase | host behaviour | what must hold (REQUIRED) |
|---|---|---|
| `fresh` | unmodified host behaviour (canary copy, fault off) | the state dir is empty at launch; the first `GET /state` is 404; at least one `PUT /state` returns 200; the serial log shows `new custodian identity sealed`; `/v2/custody/info` is ready; there is a fresh AMD-verified quote of the pinned measurement that binds the served machine record |
| `fault` | the canary copy answers **every** `GET /state` with **503** | at least one 503 is observed; every `GET /state` got a 503; there is no `PUT`/write to `/state` and no `/submit`; the mgmt port gives **no HTTP response** for the whole window; the serial log shows `sealed state read failed: HTTP 503` and never `new custodian identity sealed`, `sealed state opened` or `custodian-v2 on :8787`; the `state.bin*` names, sizes and sha256 match the post-`fresh` save |
| `reopen` | fault cleared | the first `GET /state` is 200; there is no 404 and no 503; the serial log shows `sealed state opened` and no new identity; the **same identity, encKey and machine record** as `fresh`; a fresh AMD-verified quote (new nonce) binds that same record |

This is **startup-recovery evidence only**. It is not secret release, not the custody lifecycle and not activation. It
uses no committee, genesis, operator, registry key, submitter key, secret or production state. `genesis=false`, and the
endpoints are `https://custody-recovery-canary.invalid`.

## Pins for root's r2 build (from ROOT-FOLLOWUP 20:04)

| pin | value | source |
|---|---|---|
| `--dist` | `/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/out-r2/A-custodian` | root |
| `--repo` | `/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2` | root |
| `--expected-commit` | `ab589bf80b669c9671b53573d489b6c6c45779ea` | read: `repo-r2` HEAD, clean tracked tree, `manifest.commit` |
| `--expected-measurement` | `70aadff5455fd65f752c1dcec2d6f1ac4984bebf6c63b284d15fcf47851fb96def231af40c39a3bca6fbf9748f01c429` | read: `manifest.measurement`, matches root |
| `--expected-manifest-sha256` | `60bde3e90a9d9984def551c21c8815108272d57d2d37bf2e1eb9f2d209e1ad5b` | read: sha256 of `out-r2/A-custodian/manifest.json` |
| `--expected-host-sha256` | `c2923901a78f6253aa405ef051246211f97e63d8e9ea0267b00e9a836b80090f` | read: `repo-r2` `custody/v2/host.mjs` on disk and at HEAD; byte-identical to `a5eae96c` |
| `--expected-copy-sha256` | `93c4030573aad84d826f8f5b62c0cc575d0266f65e8c59a9ee040b95b41893d1` | computed by `transform_host` in the queued test job, for both the fixture and `repo-r2` |

- **Other r2 file hashes (read, not pinned by argument).** The headroom check verifies these against the manifest.
  - `vmlinuz`: `1a3a02d5…a124e7`
  - `initramfs.cpio.gz`: `bed627f6…d41623`
  - `cmdline`: `17a9bc3b…604827`
  - `manifest.ovmfSha256`: `142589cc…f4f8a9`
- **`manifest.measurementSha256`:** `0xfbe2f581…cb8d7`. This matches root.
- **Image or repo changes.** If root changes the image or repo, re-read all five values. If `host.mjs` changes,
  `transform_host` refuses unless the new source still carries the exact anchor once. Then `--expected-host-sha256` and
  `--expected-copy-sha256` both need new pins (the copy hash comes from the same function).

## Exact run command (root only; one terminal; no Claude jobs concurrently)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/custody-snp-recovery-harness-20261023 && \
python3 canary/recovery_canary.py \
  --dist /home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/out-r2/A-custodian \
  --repo /home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2 \
  --expected-commit ab589bf80b669c9671b53573d489b6c6c45779ea \
  --expected-host-sha256 c2923901a78f6253aa405ef051246211f97e63d8e9ea0267b00e9a836b80090f \
  --expected-copy-sha256 93c4030573aad84d826f8f5b62c0cc575d0266f65e8c59a9ee040b95b41893d1 \
  --expected-measurement 70aadff5455fd65f752c1dcec2d6f1ac4984bebf6c63b284d15fcf47851fb96def231af40c39a3bca6fbf9748f01c429 \
  --expected-manifest-sha256 60bde3e90a9d9984def551c21c8815108272d57d2d37bf2e1eb9f2d209e1ad5b
```

- **Exit codes.** The command prints `CANARY TERMINAL <code> <run dir>`. Code 0 only when:
  - every REQUIRED check is true;
  - the scope's cgroup is proven empty;
  - no process references the run dir;
  - `private/` was scrubbed.
- **Not started.** Exit 98 means the run did not start: a queue lane was busy, or the reserve was unavailable. Exit 2
  means a pin failed. The preflight's own exit code means the preflight failed.

## Allocation and wall time

### Allocation (unchanged from the reviewed Oct 21/23 root hardware allocation)

- One guest at a time, 3072 MiB.
- `systemd-run --user --scope -p MemoryMax=5120M -p MemorySwapMax=0`.
- `memory-guard.mjs --max-rss-mib 5120 --floor-available-mib 16384`.
- An admission gate of MemAvailable ≥ 16384 + 5120 + 1024 MiB. The reviewed `headroom-check.sh` also requires
  ≥ 16384 + 3072 + 1024 MiB.
- Both `claude-test-queue.lock` and `claude-test-small-queue.lock`, taken non-blocking and held for the whole run.
- The phases are strictly sequential. The next guest launches only after the previous phase's group is proven empty,
  ports 18970/18971 are not listening, and the scope cgroup holds only the harness's own chain. So the scope never
  holds two guests.
- The previous single-boot run peaked at 828 MiB tree RSS (qemu 597).

### Wall time: one bounded extension, 330 s → **1080 s**

`timeout --signal=TERM --kill-after=20s 1080s` wraps the in-scope child. The parent waits for at most 1200 s, then stops
only its own unit.

| step | bound |
|---|---|
| fresh: ready + verify + stop | 240 + 65 + 13 s |
| fault: first 503 + hold + stop | 240 + 45 + 13 s |
| reopen: ready + verify + stop | 240 + 65 + 13 s |
| total | 934 s, + pin re-verification at 3 launches (git status/show, file hashes) and slack |

- **Why the extension is needed.** The reviewed 330 s covered one cold boot (240 s ready + 65 s verify). Three cold boots
  plus the negative window cannot fit in it.
- **Expected run.** The previous cold boot reached ready in about 13 s, so roughly 2–3 minutes.
- **Memory is unaffected.** Only the wall time changes, not the memory bound.

## Fault injection (canary-only copy; measured image, source and runtime untouched)

- **The copy.** `private/host-canary.mjs` is generated at run time from `<repo>/custody/v2/host.mjs`. `transform_host`
  refuses unless:
  - the source sha256 equals `--expected-host-sha256`;
  - the source is UTF-8;
  - it carries no canary strings;
  - the exact 4-line anchor occurs once: the `createServer` line, the `send` line, `try {`, and the `GET /state` line.

  It then inserts `canary/fault-inject.mjs.txt` (5 lines) between `try {` and the `GET /state` line. It asserts that this
  was exactly one insertion: removing the inject lines once gives back the source byte for byte. The result's sha256 must
  equal `--expected-copy-sha256`. The copy is written `O_EXCL`, mode 0600, under the 0700 `private/`.
- **What the inject lines do.**
  - Only `GET /state`, and only when the phase config has `canaryStateFault: "get-503"`, returns 503.
  - Every request appends `{ev:"req", at, method (≤8 chars), url (≤64 chars)}` to `events-<phase>.jsonl`, and on close
    `{ev:"res", …, status, finished}`. Bodies are never recorded.
  - A missing event log makes the handler throw inside host.mjs's own `try`, giving HTTP 500, never a silent pass.
  - `fwcfg.json` is identical in all phases, so the guest's inputs do not change; only the host's behaviour does.
- **Import resolution.** `node --import canary/resolve-register.mjs` registers `canary/resolve-as-original.mjs`.
  - Every specifier imported BY the copy resolves with the original `custody/v2/host.mjs` as its parent: `./chain.mjs`,
    `./host-binding.mjs`, `./measured.mjs`, `../../network/custody-vaults.mjs` and `viem*` from `repo/node_modules`.
  - The copy therefore runs exactly the pinned commit's host-side modules. All other resolution is untouched.
  - The register step refuses when:
    - the entry point is not exactly `CANARY_HOST_COPY_URL`;
    - the original is not an existing, non-symlinked `…/custody/v2/host.mjs`;
    - the original is the copy itself;
    - either URL is missing.

## Process and state ownership

- **Fresh run dir.** `runs/<UTC stamp>` is created by `mkdir` without exist_ok, so it refuses an existing path. It is
  forced to 0700 and proven to be: real, non-symlinked, owned by this user, and mode 0700. `private/` and
  `private/state/` are created the same way.
- **No production blob.** `private/state` must be empty at the `fresh` launch. No path outside the run dir is ever used
  as state.
- **Launcher process group.** Each phase's launcher is `Popen(start_new_session=True)`, so its pgid equals its pid. Its
  identity is recorded as (pid, starttime). Its descendants (QEMU included) are sampled as (pid, starttime) while the
  phase runs.
- **Stopping a phase.** Stop calls `killpg(pgid, TERM)` and then `KILL`, each only while a recorded owned identity is
  alive, not a zombie, in that pgid. It then requires the group to be empty.
- **Phase boundaries.** At every boundary these are required:
  - the scope cgroup contains only the child and its in-scope ancestors (`timeout`, `memory-guard`);
  - 18970 and 18971 are not listening;
  - the QEMU pid→starttime map equals the snapshot taken before `fresh`, so pre-existing production QEMUs are unchanged.
- **No broad process or port changes.** There is no `kill`/`pkill` by name, no global port or process change, no
  listener of the harness's own, and no SSH.
- **Parent cleanup, in this order:**
  1. Read the child's cgroup from `scope.json`. It is accepted only if it ends in this run's unit name.
  2. Stop only `enclave-custody-snp-recovery-canary-<stamp>.scope`.
  3. Prove that cgroup is empty and that no process's cmdline references the run dir.
  4. Only then `rmtree(private/)`: the disposable sealed identity, fw_cfg, configs and the copy.

  If anything is unproven, nothing is deleted and the exit is non-zero.

## Evidence (run dir; all of `runs/` is git-ignored)

| file | contents |
|---|---|
| `attempt.json` | pins, allocation, base config, sha256 of every pinned input, plus the copy hash |
| `preflight.log` | reviewed `headroom-check.sh` output |
| `scope.json` | the child's cgroup path and pid |
| `protected-before.json`, `protected-after.json` | QEMU pid→starttime maps |
| `serial-<phase>.log` | host + guest console |
| `events-<phase>.jsonl` | method, path and status only |
| `verify-<phase>.log`, `verdict-<phase>.json` | reviewed verifier output: verdict, selected observed fields, nonce; no raw report or auxblob |
| `saved-after-fresh.json` | sealed-file names, sizes and sha256, plus the public machine record (identity, encKey, endpoint, chipId, registryId, measurement) and the fresh nonce |
| `result.json` | `required{}` (every check named above, plus `*.stop.*`, `*.launch.*`, `end.*`), `diagnostic{}` per phase (`readyAfterS`, `first503AfterS`, `daemonRestartsSeen`, `qemuIdentities`, `launcherReturncode`, event summary), and public phase metadata: launcher identity, mgmt probes and responses, state metadata, identity, selected verdict fields |
| `memory.log`, `execution.log`, `terminal.json` | guard summary, child output, cleanup proof (`cgroupEmpty`, `survivors`, `privateScrubbed`, exit code) |

- **What is never written to evidence:** raw quotes, collateral, sealed bytes, configs, or the copy. Configs and the copy
  live in `private/` and are scrubbed with it.
- **Diagnostics.** These are computed but are NOT acceptance: `daemonRestartsSeen` (gsup's 2 s, 4 s, … restarts during
  the fault window), QEMU identities, ready latency, PUT counts in `reopen` (checkpoint writes are allowed there), and
  `otherRequests`.

## Limitations (not solved by this test)

- **Rollback is NOT addressed.** A malicious or broken host can still:
  - answer **404**, which is by design the only "no state" signal: the guest seals a NEW identity and the old share is
    orphaned;
  - serve an **older valid sealed blob**, which unseals and silently rolls back state.

  This canary only shows that a non-404 storage failure (503) does not replace the identity, and that the same identity
  reopens afterwards. Rollback and freshness protection is separate work.
- **Only HTTP 503 is exercised on hardware.** Other statuses (500, 403, redirect) and timeouts, truncation and oversize
  are covered only by the source repo's unit tests of `readStartupState`/`loadStartupState`. They are not re-run here.
- **The fault is in a canary copy, not production `host.mjs`.** The copy differs from the pinned `host.mjs` only by the
  5 inject lines. Real storage errors in production `host.mjs` (for example an EIO surfacing as 500 from its catch) are
  not exercised.
- **The fault-phase refusal is host-observed, not attested.** The evidence is the host's own event log (no write
  arrived), the mgmt port (never HTTP-ready), the state hashes, and the guest console text, which is unauthenticated. The
  attested part is the `reopen` quote: a fresh-nonce AMD-verified report whose report_data binds the same identity and
  encKey as `fresh`.
- **The external dependencies of the reviewed single-boot canary remain unchanged:**
  - the verifier fetches AMD KDS collateral live;
  - the guest's platform host-policy refresh reads public Base RPCs;
  - the host's bind loop starts 20 s after each launch and dies at once on its missing `registryKeyFile`, by design.
- **Pinned commit coverage.** `repo/node_modules` (viem) is hashed only through its `package.json`. The remaining
  untracked dependency files are not pinned.
- **Root decides** the final image path and hash. The table above pins what root reported at 20:04.

## Tests (queued `work/claude-test-queue.py --mib 256` only; no QEMU, ports or hardware)

`./q.sh <label>` runs `tests/run-tests.sh` as one 256 MiB job. Every step is bounded by `timeout`.

- **Syntax:** `python3` AST, `node --check`, `bash -n`.
- **Transformed copy hash:** printed for the fixture and for `repo-r2`.
- **`tests/test_recovery_canary.py`:**
  - the transform: the exact source passes; the wrong hash, a missing, duplicated or restructured anchor, existing
    canary lines, malformed inject lines and non-UTF-8 all refuse; the copy hash is pinned;
  - the path guards: symlink, mode, foreign, existing and run-name checks;
  - `/proc` stat parsing;
  - `descendants` against pid reuse;
  - `stop_group`: no signal without an owned live member; never a foreign group; TERM then KILL;
  - cgroup extras, `/proc/net/tcp` LISTEN parsing, event parsing (partial and malformed lines);
  - every phase verdict on a pass case and on one mutation per required check;
  - phase configs: the fault is only in `fault`; no key, committee or VCEK fields;
  - public-metadata stripping;
  - every static pin.
- **`tests/canary-node.test.mjs`:**
  - the inject lines on mocked req/res (no sockets): 503 only for `GET /state` with `get-503`; method, path and status
    only, with bounded lengths; a missing log throws;
  - `node --check` of the transformed fixture, which round-trips to the original;
  - the resolve hook resolves relative, parent-relative and bare imports from the original's location, with a no-hook
    control that fails;
  - all the hook's refusals.
- **Secret scans:** `gitleaks dir`, and the source repo's `.githooks/scan-crypto-keys.py --staged`.

**Result.** Queue job `t2`, 256 MiB lane, EXIT 0, peak 123 MiB.
- Python: 27/27 ok. Node: 6/6 ok.
- Copy hash: `93c40305…893d1` for both the fixture and `repo-r2`. Inserted 702 bytes.
- gitleaks: no leaks. Crypto-key scan: clean.

The earlier job `t1` failed only on the then-unpinned `COPY_SHA` placeholder.

## Root hardware execution, October 23 at 20:14–20:16 UTC

Root ran the pinned harness on production SNP hardware using corrected image `70aadff5…` from source `ab589bf8`. All required checks passed. Fresh startup sealed a new canary identity; seven storage reads answered HTTP 503 over 45.9 seconds caused no state writes and no HTTP readiness; reopening the same sealed state retained the identity and encryption key and passed a new-nonce AMD quote. The two protected production QEMU identities remained unchanged. Cleanup found no surviving canary processes and removed private canary state. Selected public metadata is in `evidence/20261023T201449Z`; raw serial/quotes and sealed bytes are excluded. This verifies startup recovery only, not secret lifecycle or rollback resistance.
