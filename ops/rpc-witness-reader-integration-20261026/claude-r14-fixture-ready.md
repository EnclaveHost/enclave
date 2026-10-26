# r14 fixture canary + r14 canary inputs: READY for root (offline PASS only; no SSH/live run by Claude; NO sandbox or node PASS is claimed)

## 1. witness-rpc-live-canary-stage/r2: fixture qualification (the prepared parent `1b239cba` is unchanged)
- **Stage:** `SHA256SUMS` **`4e2396dbf61d746fe613a4b6bd195451b9dd096fc83fdf38713e8bc6ef143465`**.
- **Offline:** shared queue 512, `unshare -Urn`. `logs/claude-wbc-offline-1.out` (sha `b3337b24…`, rc 0): `PASS wbc-offline Ran 10`, no skips.

**Root runs (shared queue 512; physical host floor):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
python3 -u ../claude-test-queue.py --mib 512 --log witness-rpc-live-canary-stage/r2/logs/root-witness-fixture-canary.guard -- bash witness-rpc-live-canary-stage/r2/jobs/root-witness-fixture-canary.sh
```

**Host job** (`jobs/root-witness-fixture-canary.sh`):
- **Pre-checks:** verifies its own sums and r14-witness `1ba2d51a`, and pins bridge **`cb976541…`** and shipped unit **`e4bdc947…`**. It refuses before any guest contact otherwise.
- **Upload:** ONLY bridge.py, unit.service, fixture_node.py, check_props.py and `UPLOAD.sha256` (each ≤ 1 MiB) to `/run/enclave-wbcanary-in-<ID>` (0700), using the existing ssh config.
- **Guest run:** the guest script runs with a 600 s hard timeout.
- **Host memory:** `/proc/meminfo` samples at start, every 5 s and at end. A breach stops ONLY `enclave-wbcanary-<ID>-*.service` and is never a pass.
- **On EVERY exit** (disconnect, partial setup, failure), independently of the guest's own trap, it stops exactly `enclave-wbcanary-<ID>-{fixture,bridge}.service`, removes exactly `/run/enclave-wbcanary-<ID>` and `/run/enclave-wbcanary-in-<ID>`, and **re-checks remotely** (no unit, no path).
- **Receipt:** `PUBLIC-RECEIPT.json` (no secrets).
- **Exit:** the run's failure is kept; 22 when the run rc is 0 but the receipt is not a pass (missing or duplicate verdict, guest cleanup not ok, host samples); 21 on cleanup failure or owned leftovers.

**Guest script** (`guest/fixture_canary.sh`, fed over ssh):
- An EXIT trap armed before setup. No `/tmp` or other files outside the owned paths; PIDs and identities are kept in shell variables.
- It verifies the uploaded bytes and pins.
- **Baselines** of production `MainPID`/`ActiveState`: `enclave-l1-el`, `enclave-l1-cl`, `enclave-rpc-base-snapshot`, `enclave-base-holder` (service+path), and `enclave-rpc-fwd-{base-rpc,l1-el,l1-cl}.socket`. Also the PUBLIC config identity: sha256 of `enclave-*` unit files and drop-ins, `/opt/enclave-rpc/manifest.json`, `/etc/enclave-rpc/chain.json`. **Never `jwt.hex`, never a node socket.**
- **Fixture:** a transient fixture unit (rpcbase) makes a 0600 socket; the script asserts `600 rpcbase`.
- **Bridge:** a transient bridge unit whose `-p` properties are **every [Service] key of the shipped unit** (except Type/ExecStart/Restart).
- **Checks:**
  - exactly one listener, on 127.0.0.1;
  - the exact relay of an allowlisted call;
  - `debug_clearTxpool` → -32601;
  - a group-accessible socket → 502, then recovery at 0600.
- **Property assertion** (`check_props.py`): User, Group, CapabilityBoundingSet (empty), NoNewPrivileges, ProtectSystem, ProtectHome, PrivateTmp, PrivateDevices, RestrictAddressFamilies, IPAddressDeny/Allow, MemoryMax, **MemorySwapMax=0**, TasksMax, UMask. Each is canonicalised against the shipped file.
- **After:** production PIDs/states and config identity are compared with the baselines; then owned cleanup and an independent re-check.
- **Output:** ONE `WBC-VERDICT {json}` line on every path; the exit status is 0 only if it passes.

**Offline tests (10):**
1. `check_props`: the realistic show spellings pass, including `any`/reordered families.
2. `check_props`: 12 deliberate deviations each fail on exactly their property.
3. Guest script: an invalid ID gives a structured failing verdict.
4. Runner success: a pass, independent cleanup + re-check once each, only owned names in every ssh command, start/end host samples.
5. Runner: an unreviewed bridge refuses before guest contact.
6. Runner: an upload failure cleans and re-checks without running the guest.
7. Runner: a guest fail gives 1; no or duplicate verdict, or guest cleanup not ok, gives 22.
8. Runner: a cleanup failure or owned leftover gives 21.
9. Runner: a host floor breach stops own units and gives 20.
10. Runner: a guest timeout fails with cleanup.

**Not exercised offline:** the guest script's systemd/ss/curl paths. Only root's live run shows them.

## 2. Minimal r14 input copies for the other canaries (frozen originals untouched and verifying)
| Copy | SHA256SUMS | Differs from its frozen source only in |
|---|---|---|
| `guest-original-game-canary-stage-r14/` (from `guest-original-game-canary-stage`) | `4b68adf71481e37aef0d0d03f9afcbb75f48ea15de7224673c04d8e75b6ca774` | `COMPOSED-STAGE-PINS.json` (stage r14-witness, sums 1ba2d51a, manifest 46913190, **finalityState 60856512**; capture/core/readers/bundleOrigin unchanged), `CONSUMER-CONTRACT.json` consumer stage path (same sha 2f7656b8), the job's `S=` line and usage paths, `R14-INPUT.md`. No code changed; no tests exist for this stage |
| `bootstrap-systemd-canary-stage/r6/` (from r5 `7c9dad4f`) | `98bc8ee7cd602d1d275efde89b6d27af57191ad5695b23949988827ce3b3ae31` | `FINAL-PINS.json` (stage r14-witness, sums 1ba2d51a, **wrapper 9607b831**, **finality_state 60856512**; others and canaryUnits unchanged), the offline job's input stage (r14-witness), usage comments, `R14-INPUT.md` |

- **The r6 offline tests were re-run,** because their inputs (wrapper/drop-in/reproof from r14) changed: `logs/claude-sdcanary-r6-offline-1.out` (sha `3be811de…`, rc 0), `PASS sdcanary-offline Ran 21`, no skips.
- **Root's run commands:**
  - original-game r14: `python3 -u ../claude-test-queue.py --mib 512 --log guest-original-game-canary-stage-r14/logs/root-original-game-canary.guard -- bash guest-original-game-canary-stage-r14/jobs/root-original-game-canary.sh`
  - systemd r6: `python3 -u ../claude-test-queue.py --mib 512 --log bootstrap-systemd-canary-stage/r6/logs/root-systemd-canary.guard -- bash bootstrap-systemd-canary-stage/r6/jobs/root-systemd-canary.sh`

## State at CLI exit
- No Claude background job is running: the queue/q-exit processes were checked empty.
- No SSH, live action, production change, commit, or administrator/contract/source edit.
- **No real sandbox, fixture or node PASS is claimed:** all three canaries above await root's execution.
