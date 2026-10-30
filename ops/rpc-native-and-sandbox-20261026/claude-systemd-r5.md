# bootstrap-systemd-canary-stage/r5: three harness fixes after the live r4 failure; 21/21 offline PASS (no SSH/live/commit)

## Result
- **r5 stage:** `bootstrap-systemd-canary-stage/r5`, `SHA256SUMS` `7c9dad4f0c3bf388d114337c84e1ef87d25b3220457d613ba50bab32f4a979d3`.
- **Offline: PASS.** Shared queue 512, `unshare -Urn`: `logs/claude-sdcanary-r5-offline-1.out`, rc 0, `PASS sdcanary-offline Ran 21`, no skips.
- **Preserved:** r4 `9f1b51aa` is unchanged, with its live receipt `root-systemd-live-r4-1004` (failed safely). The candidate `r13-manifest-final` `80cea888` is unchanged and verifies.

## Live r4 evidence → fixes
1. **Host samples = 1** (the guest finished before the first 5 s period).
   - **Fix:** `host_sample start` before the guest and `host_sample end` after it, both REAL readings tagged in `host-memavail.txt`, plus the periodic monitor. A breach or an unreadable reading at any of them stops own units.
   - **Verdict:** `host_verdict.py` additionally requires the `start` AND `end` tags. The ≥ 2 readable samples ≥ 16384 MiB rule is unchanged.
   - **Tests:**
     - a fast guest (0 s, poll 30) succeeds with exactly `start`/`end` real readings;
     - a guest rc 0 with the host meminfo vanishing gives an `unreadable end` sample → non-zero and HOST false;
     - untagged or missing-END samples fail.
2. **Busy detection missed `activating`.**
   - **Fix:** the guest records the download's `ActiveState`; the verdict uses the reviewed gate's BUSY set. Busy requires all of:
     - ExecStart not run;
     - the gate's "start skipped";
     - `ConditionResult=no`;
     - systemd's "Skipped due to 'exec-condition'".
   - Those are the signals the real `journal-full-busy.txt` showed.
   - **Tests:** activating, active and deactivating pass with full evidence; each missing signal fails; inactive is NOT EXERCISED.
3. **InaccessiblePaths.** The live root probe saw `[]` for `/srv/enclave-l1-pair`, read length 0 for the JWT path, and ENOENT for `/var/lib/enclave-rpc` (absent on the guest).
   - **Investigation:** systemd implements InaccessiblePaths by bind-mounting its mode-0000 nodes `/run/systemd/inaccessible/{dir,reg}` over each path. With CAP_DAC_READ_SEARCH, root can traverse or open those EMPTY nodes, so `[]` and 0 bytes are the mask, not exposure. **No policy flaw; the guard is not weakened.**
   - **The r4 probe was wrong to read bytes:** it opened the (masked) JWT path and read 1 byte (got 0). r5 reads NO protected content anywhere.
   - **New proof, by identity and metadata only:**
     - **Host side:** before any unit, `canary_units.py mask-host` records `lstat` (exists/type/mode/dev/ino/uid) of every protected path from the reviewed drop-in, the canary sentinels, and the two mask nodes.
     - **Inside, root phase:** each host-present path must equal the mask node of its type (dev/ino == node == host's node) and differ from the host object's identity, with mode 0000. `/proc/self/mountinfo` entries are recorded.
     - **Dropped phase (rpcbase):** open only (O_NOFOLLOW, closed at once, never read) must give EACCES.
     - **Absent on the host:** must be absent inside.
   - **Positive controls:** canary-owned `sentinel-dir` and `sentinel-file` are added as a SEPARATE `InaccessiblePaths=` (no `-`); the production entry is kept verbatim. Both must be masked, and the canary's own non-secret sentinel file must read 0 bytes.
   - **Tests:**
     - the positive case;
     - rejections for an unmasked dir (host identity), an unmasked file, node identity with a non-0000 mode, the wrong node type, an rpcbase open that succeeds, host-absent but present inside, a missing sentinel, and sentinel bytes readable;
     - a behavioural metadata-only test (`open`/`os.open` patched to raise) plus exact mountinfo matching.

## Pins
- **FINAL-PINS stage/file pins are unchanged:** root's binding to r13-manifest-final `80cea888`.
- **`canaryUnits` changed** `0dae9094` → `eea29917…`, because r5 changes the canary's own probe code (`guest/canary_units.py`). **Root reviews this rebinding.**

## Changed vs r4
- **Changed:** `guest/canary_units.py`, `guest/systemd_canary.sh` (busy state, sentinels, mask-host), `jobs/root-systemd-canary.sh` (start/end samples), `tools/host_verdict.py` (start/end requirement), the tests, `jobs/root-offline-tests.sh` (r5, 21 tests), README, and the `FINAL-PINS` `canaryUnits` pin.
- **Unchanged:** `guest/cleanup.sh`, `tools/assemble_canary_bundle.py`.

## Limits
- **Mask nodes assumed present:** the mask-node paths are systemd's documented `/run/systemd/inaccessible/{dir,reg}`. If the guest's systemd uses others, the verdict FAILS (no pass by default).
- **Proof ceiling:** the live canary proves the mask on THIS guest's systemd. It is still not a real holder/node start; the rest of the scope is as in the r2–r4 README.
