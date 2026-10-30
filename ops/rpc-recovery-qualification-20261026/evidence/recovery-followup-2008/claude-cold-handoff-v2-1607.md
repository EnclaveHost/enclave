# Cold-scan handoff v2 (1607): review of 1595's `run-read-only-cold-scan.sh` and a minimal corrected v2. Prepared 2026-10-26 19:40–19:58Z; NOT run

**Outputs dir:** `O=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025` (= `$P/../../outputs/…`).

| file | sha256 | state |
|---|---|---|
| `$O/run-read-only-cold-scan.sh` (v1, 1595) | `41825996575957cac51782ef0eb06f2e6ad869d6309debf34d592c17f0f78ff7` | **unchanged, kept as evidence** |
| `$O/run-read-only-cold-scan-v2.sh` | **`1dcb57ae82d2016ab898c43bfc223b888d19a83d649baabfb4d3e1d00bcd28dc`** | new, 0444 |
| `$O/cold-scan-v2/SHA256SUMS` | **`3bcae5559eb865b524b1f49fcbc4e8e9f91414fd6ea43aab467b613a1863c24b`** | pinned in v2 |
| `cold-scan-v2/root_scan_supervisor.py` | **`d57de0b0c6098342c0ff4fbbc5de4b81fd342c1110a10a740186df04825c7774`** | pinned in v2 and in its root body |
| `cold-scan-v2/test_root_scan_supervisor.py` | `b29c8893754d3265515eac04b5a339b5e5194dab8269238bb04cbda772b5a91f` | 8 tests |
| `cold-scan-v2/run-supervisor-tests.sh` | `31af85eebaed74176a1a6697a8ea0044638a3b516b8874bdbf514be7c198bef9` | root's unprivileged test job |

**r10 pins are unchanged:** stage SUMS `2342e677…` (re-verified), subtree `90cd8968…`, relocate `2a037dae…`, job `7bcd4fbf…`, config `bae6021b…`.

**What I did not do:** no tests, builds, sudo, live actions or network. I edited no stage. **The user is not asked to run anything until root has reviewed this and the supervisor tests pass.**

## v1 findings (concrete)
| # | v1 location | defect | v2 |
|---|---|---|---|
| **V1** | `:105` `sudo … 2> "$O/scan.stderr"` | The password prompt shares the redirected command line (root: the prompt is hidden). | `sudo -v` first, in the foreground on the terminal with **no** redirect; then `sudo -n` runs the exact body (it never prompts). Only the command's stdout/stderr are redirected, and stdin is `</dev/null`. The password is read by sudo itself and never touches a file. |
| **V2** | `:145-146` gate | `manualGateClean` ignores `SRC` (root rc) and `LANE`, so a clean report is possible after a failed scope or a lost lane. | Clean requires `rootRc == 0` **and** `lane == held-throughout`, plus every v1 condition and `hits == []`. Supervisor stop codes 70-73 are named in `problems`. |
| **V3** | `:131`, `:141` validator | **Every valid r10 result would be refused.** r10's `nsCopies` is an **int** (`subtree.py:731` `"nsCopies": 0`, `:954` `+=`), but v1 requires a list and takes `len()`, so `"malformed fields"` gives exit 4. | `nsCopies` must be an int (reported as is). |
| V4 | `:124-136` | Uncaught shapes (a non-dict `targets` element, string `t`/`tEnd`) raise a traceback, giving exit 1, which matches neither 3 nor 4 and still moves the file to `scan.json`. | Any exception gives "no valid r10 result" (exit 4). It also checks: `t`/`tEnd` numeric, list elements are dicts, `hitsTotal ≥ len(hits)`, and `prefixes` cover every configured source subtree. |
| **V5** | `:89-111` floor | The 1024 MiB lane is held by an unprivileged queue placeholder, but **nothing ties the root scan to it**. If the queue guard kills the placeholder below the floor, or it ends at `HOLD_MAX_SEC`, the root scan continues. `LANE` is only computed afterwards. | **A root supervisor inside the root scope** (below). |
| V6 | `:92` cleanup | `pkill -TERM -P $QPID` signals by parentage. | No pkill. Only this script's own heartbeat watcher (`$WPID`) is ever killed. Removing the hold file ends the placeholder by itself. |
| V7 | `:109` lane check | `kill -0 $QPID` checks only the queue *wrapper*, not the admitted placeholder. | The watcher requires both the wrapper and the admitted placeholder pid (from `lane.admitted`) alive, plus the hold file. Any loss writes `lane.lost`. |

**v1 checks that hold:**
- uid 1000 and an interactive terminal;
- the r10 SUMS, the tool pins and the config bytes/mode;
- root's 1582 log, last attempt (22 + 39, rc 0);
- owner-opened redirects;
- a private 0700 run dir;
- `sudo -k` afterwards;
- unprivileged `losetup`/`swaps` records.

## v2 design (minimal)
**Root body.** This is the r10 README literal's staging and sha check, plus **one** more staged and pinned file:
```bash
W=$(mktemp -d /run/nvme-cold-wc10.XXXXXXXX); trap "rm -rf -- $W" EXIT; mkdir -m 0700 "$W/jobs"
for f in subtree.py relocate.py jobs/root-writer-check.sh; do timeout 20 dd if="$S/$f" of="$W/$f" … iflag=nofollow,nonblock,fullblock …; done
timeout 20 dd if="$V/root_scan_supervisor.py" of="$W/root_scan_supervisor.py" … iflag=nofollow,nonblock,fullblock …
printf … 7bcd4fbf… job  90cd8968… subtree  2a037dae… relocate  d57de0b0… supervisor | sha256sum -c --quiet -
/usr/bin/python3 -I -B "$W/root_scan_supervisor.py" "$W" "$1" "$2"      # $1 = the fixed config, $2 = the owner's heartbeat file
```
- It runs as `sudo -n systemd-run --scope --quiet -p MemoryMax=1G -p MemorySwapMax=0 -- bash -c "$BODY" nvme-cold-wc10 "$CONFIG" "$HB"`.
- **v2 checks the shared lines:** the README block's `mktemp` line and the `dd` staging line must be present verbatim in both the frozen README and the v2 body.
- **No user code is imported by root:** the supervisor imports only the standard library, and root executes only staged, sha-verified copies.

**Root supervisor** (`root_scan_supervisor.py`, 141 lines, standard library only).
- **The child it starts:** **exactly** `/bin/bash $W/jobs/root-writer-check.sh $W CONFIG`, i.e. the frozen r10 job, which execs the r10 scanner.
  - The child runs in a **new session / process group** with `PR_SET_PDEATHSIG=SIGKILL`.
  - `prctl` is resolved before the fork, and the child exits if its parent already died before the `prctl`.
  - stdin is `/dev/null`; stdout and stderr pass through.
- **Stop conditions, checked from inside the root scope every 0.25 s:**

  | condition | exit |
  |---|---|
  | MemAvailable < **16384 MiB**, or `/proc/meminfo` unreadable | 70 |
  | running > **3600 s** | 71 |
  | owner heartbeat missing, not a regular file, or > **15 s** old (`lstat` only: never opened, never followed) | 72 |
  | SIGTERM, SIGINT or SIGHUP | 73 |

- **Nothing starts** unless MemAvailable ≥ 17408 MiB and the heartbeat is fresh.
- **"Stop" signals only its own group:** SIGTERM to the **child's own pgid**, SIGKILL after 5 s.
- **Positively owned:** the leader is kept as an unreaped zombie (`waitid … WNOWAIT`) until a final group SIGKILL, so the pgid cannot be reused while it is signalled. Nothing else is ever signalled. After a normal exit the same group gets a best-effort SIGKILL, so no member outlives the scan.

**Owner heartbeat.** After lane admission, a background watcher touches `$O/lane.heartbeat` every 1 s **only while** the hold file exists, the queue wrapper lives and the admitted placeholder pid lives.
- If the queue guard kills the placeholder (floor), the hold times out, or the owner's terminal or shell dies (SIGHUP to the watcher), the heartbeat stops. **The root scan is then stopped within ≤ 15 s.**
- The supervisor's own MemAvailable check is the primary floor guarantee, at 0.25 s granularity.

**Order of operations:**
1. preflights (all v1's, plus the cold-scan-v2 SUMS/pin and root's supervisor test PASS against those exact SUMS);
2. lane admission;
3. watcher;
4. `sudo -v` (foreground);
5. re-check MemAvailable ≥ 17408 and the lane;
6. `sudo -n` scan;
7. `sudo -k`;
8. owner validation.

**Exit codes:** as v1: 0 clean-at-this-moment (never a cut-over approval), 3 valid but not clean, 4 no valid result, 9 refused before the scan.

## Rationale: why a supervisor and not just the queue
The queue's memory guard can only kill **its own** (unprivileged) job tree. The root scan runs in a separate root scope that the guard can neither see nor kill. Only a process **inside** that scope, as its parent, can terminate exactly the scan, without broad kills or root access to the queue.

## Tests (unprivileged, fixtures only; root runs them)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh root-cold-scan-v2-tests 512 unshare -Urn bash /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/cold-scan-v2/run-supervisor-tests.sh
```
- **PASS** = `## verified SHA256SUMS 3bcae555…`, `Ran 8 tests`, `OK`, no skips, `## cold-scan-v2-tests rc=0`.
- **v2 refuses** unless `logs/root-cold-scan-v2-tests.{rc,out}` (last queue attempt) show exactly that.
- **Fixtures:** a fake meminfo file, a heartbeat file, and `/bin/sh` + `sleep` children in a temporary directory. No sudo, network or scan.
- **Every stop test** asserts that the child **and** a grandchild in its group are gone, and that an **unrelated** same-uid `sleep` is still alive (exact termination).

1. A normal exit returns the child's rc, and the grandchild left in the group is killed (no leaked process).
2. MemAvailable drops to 16383 MiB → 70 within 5 s; the group is gone.
3. Unreadable meminfo → 70; a start below 17408 MiB starts nothing.
4. Timeout 1 s → 71.
5. A stale heartbeat → 72.
6. A missing heartbeat, or a heartbeat symlinked to a FIFO (`lstat`: no block, no follow) → 72, and the child never starts.
7. SIGTERM to the supervisor → 73 and the child is gone. SIGKILL to the supervisor → the child dies by `PR_SET_PDEATHSIG`.
8. The root entry accepts only `/run/nvme-cold-wc10.XXXXXXXX` + absolute paths; the constants are 16384/17408/3600/15.

## Remaining traps and limits (stated)
- **sudo:**
  - with `timestamp_timeout=0` (not the default), `sudo -n` fails after `-v`; the result is exit 4 with nothing scanned;
  - sudo 1.9.17 uses a pty by default; v2 passes `</dev/null`, and only stdout/stderr are redirected (both owner-opened).
- **Supervisor reach:**
  - `PR_SET_PDEATHSIG` covers the direct child only; the r10 job `exec`s python, so there are no further descendants;
  - an OOM kill inside the 1 GiB scope would hit the scan, not the small supervisor (not forced: `OOMPolicy` not set, to keep the literal minimal);
  - a malicious uid-1000 process could keep touching the heartbeat. That is within the trusted-operator baseline, and the supervisor's own floor and timeout still apply.
- **The scan itself is unchanged and unmeasured live** (runtime, counters). A clean exit 0 is **not** a recorded scan and **not** cut-over approval.
- **Root also writes** only its private `/run/nvme-cold-wc10.*` staging dir (removed by its trap) and a transient systemd scope. Nothing on USB; no app stops, install, cut-over or reclaim.
