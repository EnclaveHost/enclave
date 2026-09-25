# U4: recovery after a HOST reboot, on v40 (ALL PASS, functional only)

**What was checked.** The whole host went down while the manager served two lab domains, and the manager then recovered
on a fresh boot. This is not a manager restart (restart-accept A3-A7 kills only the manager).

**Scope.** Functional recovery evidence only. It is NOT host-exclusion or isolation proof: `host_excluded=no`.
- Workload: the package's pinned hello-world under lab names only. No probe, no customer app, no production app data.
- Nothing left behind: no permanent autostart, no firmware opt-in, and Secure Boot and test signing untouched.
- Parked items B1, B2, B3 and P1 were not touched.

## What ran

- **Box:** nucbox-k11. Reached over ZeroTier (`minipc-zt`); its LAN address stopped answering before the test.
- **Box clock:** ARM 15:36:29Z-15:37:22Z; boot 15:38:44Z; VERIFY 15:41:41Z-15:47:01Z; the fresh launch
  15:47:27Z-15:49:00Z. 2026-09-25.
- **Package:** v40 (`15f39ae4…`) from the lab copy `C:\Users\claude\d1-v40-lab\pkg`, with its own sweeps (liveness
  15000, answer check 30000).
  - IGVM `b7ba7731`, the eligible reference image (prospective only).
  - Launcher `435717de`.
- **Harness** (windows/isolation-manager `874169c5` plus `5b14c067`, reviewed by enclave-63, whose review fixes are in
  `5b14c067`):
  - `reboot-accept.ps1` `c1dd78f1…` and `reboot-accept.mjs` `d324c87b…`, in `C:\Users\claude\d1-u4\`, outside the tree;
  - its helpers `restart-accept.mjs` `c91ec4ae…` and `multi-accept.mjs` `8be8bd2f…`, byte-equal to the tree's copies.
- **Prior state:**
  - recorded read-only first (`inspect-before.txt`), then by ARM (`prior-state.verified.json`);
  - the firmware setting Absent, the 9001 key absent, Secure Boot ON, BCD "hypervisorlaunchtype Auto" (no test-signing
    lines), no boot-time unlock prompt, no pending update;
  - sshd and ZeroTier automatic;
  - no VMs, no node process;
  - the production boot task `\EnclaveWindowsNode` enabled, with its last run at boot 68 (exit 0x1), not running.
- **The legacy node task** (enclave-5d's call, option b): DISABLED for this one boot only.
  - The one-shot re-enabled it at 15:44:01Z, after its 1-minute boot trigger had passed, WITHOUT running it.
  - Its definition is byte-identical afterwards (sha256 `b8ea54d3…`). Its last run is still 05:33:55Z.
  - Whether that task should stay enabled for an UNPLANNED boot (it would re-run the retired legacy node) is a
    Codex/Steven decision, flagged by enclave-5d. It is not taken here.
- **Restore across the reboot:**
  - A ONE-SHOT SYSTEM startup task. Its script held the prior values as LITERALS and lived in
    `C:\ProgramData\d1-u4-restore`, owned by Administrators with an ACL of SYSTEM and Administrators only.
  - At boot it found the setting and the 9001 key already at their prior state (ARM restored them before the
    reboot), re-enabled the node task, and removed itself. Its log is `restore-at-boot.log.txt`.
  - The directory was removed at the end.
- **Integrity:** ARM's INTEGRITY line was copied off the box before the reboot (`integrity-offbox.txt`):
  prior-state.json `95468785…`, restore-at-boot.ps1 `ae15c871…`. VERIFY's B0 found both unchanged.

## Results

| Phase | Check | Result |
|---|---|---|
| ARM | R0-R2 | Two lab domains (0xb0…, 0xb1…) running on two VMs with distinct keys; each answered the pinned bytes (`03ba204e…`) through the data plane on its verified key |
| ARM | RC | After the setting and the 9001 key were RESTORED (pre-reboot), both still answered: a running partition needs neither |
| ARM | reboot | Issued at 15:37:22Z with the manager serving; the new boot was at 15:38:44Z |
| VERIFY | B0 | Integrity since ARM, matching the off-box copy |
| VERIFY | B1, B2 | A new boot; Secure Boot and BCD unchanged |
| VERIFY | B3 | The one-shot ran as SYSTEM, restored nothing (nothing needed it), re-enabled the node task, and unregistered itself |
| VERIFY | B4 | The setting and the 9001 key at their prior state |
| VERIFY | B5, B6 | The node task byte-identical and enabled; not run (last run 05:33:55Z), and no legacy node process |
| VERIFY | B7 | Both armed VMs present and **Off**. AutomaticStopAction TurnOff took them down at shutdown, and AutomaticStartAction Nothing kept them down at boot |
| VERIFY | B8 | The tree unchanged across the reboot (`819bed7d…`) |
| VERIFY | V0 | The manager's env carries no respawn, attach or engine switch |
| VERIFY | V1 | The manager recovered EXACTLY the two armed ids: recovered:true, status starting, relay null, appReady false. **HELD**, never served |
| VERIFY | V2 | Nothing came back by itself: the VMs stayed Off before and after the manager started, and no launcher ran |
| VERIFY | V3 | The liveness sweep failed both as "the partition is Off" and LEFT the VMs (for the node to retire) |
| VERIFY | V4 | Stale routes refused: each old data-plane route got "NO the instance is failed", and both old relay ports refuse |
| VERIFY | V5 | Cleanup: DELETE both returned 200; no manager-owned VM left |
| VERIFY | B9 | End state: 0 manager-owned VMs, the setting Absent, the 9001 key absent, the tree unchanged, the one-shot gone |
| FRESH | M0-M7 | A new explicit lab launch after the reboot (the copy's own manager-accept plus multi-accept at 15000/30000): MULTI-ACCEPT ALL PASS. Setting restored and 9001 removed, both verified; TREE UNCHANGED (`fresh-mgraccept-20260925-154727/`) |

**Final state (15:49:36Z, `final-state.txt`):**
- 0 VMs, 0 node, 0 vbslike-host;
- the setting Absent, 9001 absent, Secure Boot true;
- the one-shot and its directory gone;
- the node task enabled, last run 05:33:55Z;
- staged v40 `15f39ae4…` and the v39 rollback `61028ec3…` intact.

## Limits

- One reboot, and a graceful one (`shutdown /r`). A power loss or crash is not covered.
- The node did not run, so the node's own retirement of a recovered, failed instance is not exercised here; the lab
  cleanup used DELETE. The node's HELD mapping for `recovered:true` is covered by its unit tests (`fb1db848`).
- Respawn and attach being OFF is shown for the manager's environment and behaviour (V0, V2). The node's respawn
  default (agent.mjs:111) and the relay switch were not exercised.
- Functional recovery only; host_excluded=no. The isolation-proof blocker, B1 (report capture), is unchanged and
  separate.

## Files

- ARM: `arm.log.txt`, `driver-arm.out.txt`, `driver-recheck.out.txt`, `manager-arm.log.txt`.
- VERIFY: `verify.log.txt`, `driver-verify.out.txt`, `manager-verify.log.txt`.
- State: `prior-state.verified.json`, `state.json`, `cfg.json`, `nodetask-before.xml`, `restore-at-boot.log.txt`,
  `integrity-offbox.txt`.
- Before and after: `inspect-before.txt`, `final-state.txt`.
- The fresh launch: `fresh-mgraccept-20260925-154727/`.
