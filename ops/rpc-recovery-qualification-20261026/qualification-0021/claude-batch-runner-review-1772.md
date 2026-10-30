# 1772: source-only review of jobs/root-multipart-batches-1764.py (driver NOT activated; nothing run)

**Scope:** reading only.
- **What I executed:** `sha256sum`; copies into my private `/tmp/claude-batch-review-1772/`; reading the runner, the 1762 wrapper, the tests job script, `q-exit-status.sh`, and `grep` of `root-preservation.sh` and `claude-test-queue.py`.
- **Not done:** edits, tests, live data, process reads, or anything touching the live r3 batch 1..8 or its session paths.
- **The author is still finishing the tests and report;** this review is of the hash below only.

| file | sha256 |
|---|---|
| `jobs/root-multipart-batches-1764.py` (473 lines, 17:15:04) | **`773d18dd8838806e1be4dd0a27f45247511bc9d315628e32b67cf8f86808d700`** |
| `jobs/root-multipart-batches-1764-tests.sh` | `eeef09ada3c69823d1ea03c2f65b656c081ab5b46d7f553d96bacf72ebea774b` |
| `jobs/root-bulk-copy-1762.py` (the current, reviewed path) | `904155b8ec7b1a03a12c430198b1094949a0c00accbd7f592eb967160312608d` |
| `jobs/q-exit-status.sh` | `734498b49103540fcccd2ef7a0babd57694a22e9cba066f446ea6a8e65b3a573` |
| `recovery-multipart-stage/r3/jobs/root-preservation.sh` (frozen wrapper) | `6d3c9f18b73a7d39ab7afd7c2b2fe1370ed19e254f551ad61999b93566d41cb0` |

**Tests: names and coverage only.** `jobs/test_root_multipart_batches_1764.py` is sha256 `c19ca98a7af2c37f3c17aef3073111a184223fff0c39b55a58e71526e25f32be` (17:17:04). The runner hash was re-checked unchanged at the same time. I read only its 9 test names and the foreign/partial cases, not the full bodies.
- **No test covers B1:** none stops the driver while the batch job is queued, and `test_signal_target_is_only_our_own_pidfd_pinned_orchestrate` covers only target selection.
- **No test covers B2:** the "later part" case puts `part-0005.json` in the vm dir, and in this fixture part 5 is a vm part (root 0–2, vm 3–5 per the reservation test). No test puts a wrong-target or out-of-manifest index in a dir.

## Verdict
**Do not activate the driver as frozen.**
- **B1 is a real stop-safety defect.** It confirms root's finding: a stop can be silently lost and a full 8-part copy can start afterwards.
- **B2 is a real gap between the docstring and the code.** The strict-admission claim is broader than what admission enforces.
- **Both fixes are small.**
- **Safe as written:** data preservation (nothing deleted, renamed or resumed), capacity accounting, and the own-child pidfd signalling once both processes exist. The other items are P3 or documented limitations.

## B1 (critical; confirmed in code): a stop requested while the batch is queued is lost, and the queued job later runs a full copy
**The path:**
- `cmd_drive.on_signal` (411–426) sets `state["stop"]`. If `active.json` does not exist yet, it **returns** (419): the comment says "simply not followed".
- The wait loop `while c.poll() is None: time.sleep(1)` (439–440) **never retries the forward**, and `state["stop"]` is only consulted **between** jobs (432).
- **The window is long:**
  - `q-exit-status.sh` retries `claude-test-queue.py` on rc 98 up to 240 × 30 s (about 2 h). During that time no batch process exists;
  - between `new_json(active)` (348) and the handler install (352) there is also a short window. A SIGTERM there kills the batch by default action. That is safe, but it leaves a stale `active.json`, so later runs refuse.
- **The same loss happens if:**
  - the signal lands between `Popen` and `state["child"] = c` (435–438);
  - `active.json` exists but `find_descendant` misses it, or the pid/start time do not match yet.

**Consequence:** the queued batch later passes admission, sees no stop, and runs `root-preservation.sh copy L-H`. That is up to 32 GiB of copy and a 24-h session after the operator asked to stop.
- **Data is still preserved;** it is a control failure, not data loss.
- But it violates "SIGTERM/SIGINT: no new job" in the docstring (12).

**Minimal fix (persistent intent; no new framework):**
1. In `on_signal`, **first** create `OUT/stop.requested` with `O_CREAT|O_EXCL`, ignoring `EEXIST`. Make that file durable and do it before any forward attempt.
2. In `cmd_batch`, check `stop.requested`:
   - immediately after the run-lock check and before writing `active.json`, exiting 5 with nothing started;
   - again right before `Popen` (replacing or alongside the check at 367);
   - **on every iteration of the wait loop** (`stop["req"] |= exists(stop.requested)`).

   This makes the existing forward-to-orchestrate retry loop (373–379) carry the stop, so the driver-to-batch signal becomes optional.
3. In `cmd_drive`, check `stop.requested`/`state["stop"]` before each `Popen` (already done via `state["stop"]`). Optionally retry the forward each second in the `c.poll()` loop while `state["stop"] and not state["forwarded"]`.

**Tests:**
- **delayed queue:** the queue child is held (e.g. a fake queue wrapper sleeping before exec), SIGTERM goes to the driver, then the batch is released. Expect rc 5, no wrapper started, and no `admission-*` file (or only a "stopped before wrapper" record).
- a stop between `active.json` and the handler install;
- a stop during the wrapper, before orchestrate exists (the forward must happen once orchestrate appears).

## B2 (real; docstring vs code): the inventory accepts any `part-NNNN.*` as ours, whatever its target or index
**The code:**
- `PART_RE` (78) matches any 4-digit index and any `verify-(.+)`/`resume-(.+)` suffix.
- `inventory` files every match under its index.
- `admit` (175–191) and `post_check` (212–220) then look only at `inv[target].get(i)` for the manifest's parts **of that target**.

**So these are silently accepted:**
- a `part-0130.bin`/`.json` (a vm index) inside the root dir;
- `part-0265…` through `part-9999.*` (outside the manifest);
- `part-0005.verify-garbage.json` on a part whose state is not looked at.

**Effect:** the docstring's "every existing file in both target dirs is one of ours … anything else refuses" (21) is not what the code enforces.
- **What still protects us:** the core's marker/manifest binding and the wrapper's checks. Root notes the core and wrapper defences exist.
- **Not affected:** capacity, which is statvfs-based and therefore counts stray bytes anyway.

**Minimal fix (about 6 lines):**
- In `admit` and `post_check`, compute `allowed[name] = {p["index"] for p in d["parts"] if p["target"] == name}` and treat as foreign any `inv[name]` key not in `allowed[name]`.
- Tighten `PART_RE` so the `verify-`/`resume-` group must be `RUNID` (`\d{8}T\d{6}Z-\d{1,10}`).
- Post-check: every non-batch index on the **other** target must also be untouched, which this already covers once out-of-target keys count as foreign.

**Test:** a wrong-target `part-0130.bin` in the root dir, a `part-0265.json`, and a `part-0003.verify-x.json`; each must be refused at admission, and at post-check if one appears during the wrapper.

## P3 findings (non-blocking, minimal fixes)
- **P3-1: misleading exit code after work.**
  - `post_check` can raise `MP.Fail` (`load_record` at 229), or `die(3)` inside `Targets` on a UUID/majmin change after the wrapper ran.
  - `main` maps Fail to **rc 3 "admission refused (nothing started)"**, though a copy happened. Also no "stopped" line is logged for `MP.Fail`, because only `SystemExit` is logged.
  - **Fix:** wrap `post_check` as `try/except (MP.Refuse, MP.Fail) → die(4, …)`. The driver stops on any nonzero rc anyway.
- **P3-2: forward dependency on the wrapper's argv.**
  - `is_orchestrate` (300) needs `cmd[3] == STAGE/orchestrate.py`. The wrapper runs `env -i … timeout -k 300 90000 python3 -I -B "$M/orchestrate.py" run …` with `M=$(… pwd -P)` (`root-preservation.sh` 13, 33).
  - The forward works only if the literal `W` path has no symlink component.
  - Root's tests should include a real forward through the frozen wrapper. Otherwise also accept `os.path.realpath(cmd[3])`.
- **P3-3: stopping is not pausing (documented).**
  - A forwarded stop leaves a confirmed partial batch (some parts committed, one `.partial` plus `.ckpt`).
  - The driver can then neither resume it nor continue: copy admission requires no files at or above L, and `--start` beyond requires L..k verified. Resuming needs the frozen wrapper directly ("explicit resume = future").
  - Say this in the operator note. `drive --start 9` likewise refuses until parts 1..8 are verified (by watcher 1769); that is correct and fail-closed.

## Checked and found sound (by reading)
- **Capacity:** the fresh admission inside the queued job, right before the wrapper, checks per target that free ≥ (the exact manifest length of **every** not-committed part) + the 40 GiB floor + **8 GiB extra on root**.
  - The core then re-checks its floor at each checkpoint against the remaining parts. The native build's 8 GiB stays outside the copy's accounting during a batch.
  - If the build consumes it, the **next** admission refuses (fail-closed).
  - **Both targets are checked on every batch:** /vm must hold its full 145-part reservation even for root batches. That is conservative and consistent with 1762.
- **Order and preservation:**
  - parts below L must be committed **and** verified (a PASS in a confirmed session, measured after the commit, identity-matching), with no partial or checkpoint leftovers;
  - verify needs exactly `{.bin, .json}`, committed and unverified;
  - post-checks require one **new** confirmed copy session, and one new verify session distinct from the copy session;
  - r3 `status` must be clean;
  - nothing is ever deleted, renamed or resumed. `active.json` is removed only by its owner, and a stale one refuses.
- **Own-child signalling, once the processes exist:**
  - the driver signals only the batch that registered itself (pid plus start time, via pidfd);
  - the batch signals only the single `orchestrate.py` that is its own descendant, via pidfd, and retries until it appears;
  - process groups are never signalled, and the queue's SIGKILL `stop()` is never triggered;
  - the queue child is started by `claude-test-queue.py` via `Popen(start_new_session=True)`, so it stays a descendant.
- **Busy guard:** a live r9 session or orchestrate (by cmdline) or a stage-path mount refuses. Session mounts are under the wrapper's run dir `$O`; I assumed that dir is under the stage path and did not verify it.

## Limits
- **Reading only:** nothing was run.
- **Tests only partly reviewed:** I read test names and coverage only, not the full bodies.
- **The final frozen hash must be re-reviewed**, with B1 and B2 fixed and the delayed-queue test passing, before the driver is activated. The current 1762 copy and watcher 1769 are unaffected.
