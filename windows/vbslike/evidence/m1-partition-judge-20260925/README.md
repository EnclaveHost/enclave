# M1 on hardware: the manager judges the report's PARTITION (run 115938)

**What was checked.** enclave-63's M1 change (windows/isolation-manager `62965126`, from READINESS.md §3). The manager
now passes `expectedVmId` to judge-hv, and a report naming another partition never reaches `running`. The launcher's
own `vm` is carried as `launcherVmId`, and a handle without it is refused before judging. This run checks that the
change serves and survives the lifecycle on hardware.

**Scope: functional only.** It is not an isolation, attestation or host-exclusion result, and `host_excluded=no`.
It adds defence in depth to a host statement: the launcher key and the VM id are both host statements.

- Box: nucbox-k11, Secure Boot ON.
- Box clock: harness start 11:59:38Z, result 12:04:49Z, 2026-09-25.
- Evidence directory on the box: `C:\Users\claude\vbs-evidence\mgraccept-20260925-115938`.
- **Result:**
  - phase 1: hvlab-accept (`5830dedc`) ALL PASS, 28 checks;
  - phase 2: restart-accept (`8d3bdf82`) A0-A9 ALL PASS (A9 30645 ms, A8 1015 ms);
  - driver exit 0, harness exit 0;
  - the setting was restored to Absent and the 9001 service removed, both verified.

## What ran

- **Tree:** `C:\Users\claude\d1-m1-62965126\control`, a robocopy of v39's staged `pkg\61028ec33770f4d7\control`
  (12490 files) with ONLY these six files overlaid from `62965126`:

  | File | sha256 |
  |---|---|
  | `backend-hcs.mjs` | `083bae7e…` |
  | `derive.mjs` | `a5f9c04a…` |
  | `ready.mjs` | `9b2fe8bc…` |
  | `server.mjs` | `a7fd3017…` |
  | `wmi-launcher.mjs` | `87b6f672…` |
  | `wmiserve-run.mjs` | `3a870a64…` |

  - v39's manager, verify and datapath equal `37c4f5a3`'s: `2c3a2873` differs only in `ops/manager-accept.ps1`. So
    this tree's manager is exactly `62965126`'s.
- **Hashes at use:** the tree list `tree-hashes-115938.txt`, sha256 `3d2a96f41f26fad0…`.
  - Against 094631's list (v36's control), it differs in exactly 7 files: the six above, and
    `windows\vbslike\ops\uefi-dev-boot.ps1` `a8abf10d…`, which is v37's re-pin to `ad61cb02`. The manager path does not
    use it.
- **Guest and launcher:**
  - IGVM `b7ba7731` (v39's profile firmware; the one eligible reference image, prospective only);
  - launcher `control\vbslike-host.exe` `435717de`;
  - runtime.json `ccadb38a`; hello-world `9c3d10f1`; master `type1.vmgs` `4f051697` (blank); `hyperv.psm1` `17ca4352`.
- **Harness:** `manager-accept.ps1` `73885218`, driver `restart-accept.mjs` `8d3bdf82`; the harness's manager env
  (5 s sweeps).

## Before the box run

- The manager, ops, verify and test/windows-* suites pass 407/407 locally at `62965126`.
- A MUTATION check: removing `expectedVmId` from server.mjs's judge call makes "a report ... naming ANOTHER partition
  never reaches running" FAIL.
- `launcherVmId` is tied to the manager's own VM: `wmiserve-run.mjs` already refuses a launcher whose `vm` differs from
  `vmId`, case-insensitively.

## Unchanged

Production attach OFF, respawn OFF, recovered VMs HELD. The unresolved boundaries are in `../../READINESS.md` §5 (B1,
B2, B3, P1).
