# v43 NucBox candidate 49500527 (guest 0c087de8): DEV-BOOT canary, 2026-09-26

**Verdict: PASS on the dev-boot path.**
- Every v43 proof is present: the front on its own uid, the runtime refused a report, seccomp denials from inside the runtime's filter, W^X at each attestation, and `runtimeSelfTest` naming runtime=1 in the served document.
- `-ProbeDomain`: **PASS**. `-ProbeNeighbor`: **INCONCLUSIVE**, the pre-existing reason: the target's existence in the root namespace is not stated.
- The manager-path canary and any v43 install come AFTER the 12 h soak and the v42 reboot acceptance (enclave-87).
- Run by enclave-d1 on nucbox-k11 during the v42 soak. The dev boot coexists with production: the lab lock only, hv_sock 9001 is bound per VmId, and it uses the lab launcher 0160d835. Test 1 was untouched.
- Host Secure Boot is ON. Tier T0-hv, host_excluded=no: this is not an isolation claim.

| | |
|---|---|
| IGVM | `vbs-linux-candidate.bin` sha256 `4950052785daf26d9c712a710f118211c853a04e03c01b8d77d8ac44a50327ab`, 78021436 B, VBS digest `61C61AD4…` (enclave-53) |
| source | isolation/wx-at-attest `0c087de8213ddd6ac7b8ed7e472b02ad23672bd5`, initrd `15833b62` |
| on the box | copied to a LAB path, `C:\Users\claude\d1-canary-49500527\`. `NT VIRTUAL MACHINE\Virtual Machines:(R)` was granted for the runs, then removed and reset (icacls-*.txt) |
| script | windows/uefi-dev-boot-judge-layers-5d `446777b3d` (uefi-dev-boot.ps1 `6b614595…`): b1eda655's probe pin (domprobe `650caede`) plus enclave-5d's TWO-LAYER probe judge. `judge-probe.tests.ps1` passes ALL OK on the box's PowerShell 5.1.26100 (judge-tests-ps51.txt) |

## V1: hello-world, -G4WatchSeconds 100, console-read after ready, one attested-document fetch (05:44Z)

Pre-ready CONSOLE lines (from the dev-boot script, which holds the whole pre-ready console):
- `MON boundary …`, then `MON yama ptrace_scope=1 -> 2`;
- **`MON user.max_user_namespaces=7211 -> 0`** and **`MON kernel.io_uring_disabled=0 -> 2`** (the new m3 holds);
- `MON boot …`, then `MON ready … transport=hv_sock`.

After-ready console (V1-console.txt):
- The front has its OWN uid:
  - `MON domain 1 loaded … uid=5001 front_uid=1053577 …`;
  - `DOM1 probe workload_uid=5001 front_uid=1053577 …`;
  - `MON refused report request from uid 0 (not a domain's front)`.
- `DOM front: not dumpable; none of its 3 threads traced`.
- **`DOM runtime selftest exec_pages=allowed wx=at-each-attestation`**, with NO `selftest FAILED`.
- `DOM serving … ready_ms=2905`.
- Every line is MON/DOM. One dated `DOM proxy: GET unreachable` line is the front's class line; the kit's regex accepts it.
- The app served exactly the pinned 13 B `03ba204e…`.

Attested document (V1-attestation.json, `GET /.well-known/enclave-attestation?nonce=<fresh 32 bytes>`, HTTP 200):
- `abi: enclave-domain-abi/2`;
- **`runtimeSelfTest: "exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1"`**: runtime ≥ 1, and the roles sum to `maps` (1+1+1 = 3).

## V2: -ProbeDomain (05:47Z): PROBE DOMAIN RESULT PASS
- The adversary probe runs as uid 5001 (front_uid 1053577).
- **The runtime is refused a report:** `report=Permission denied` and `filtered_report=Permission denied` (the channel is the front's).
- **Seccomp:**
  - `seccomp=2`;
  - all four `filtered_vsock_*=Operation not permitted`;
  - the distinguishing line is `filtered_vsock_host_control=Operation not permitted` against the unfiltered `vsock_host_control=timed out (no answer)`. Unfiltered, the connect leaves the guest; filtered, it is refused before it is made.
- Memory is CONTAINED (48 of 64 MiB, then 137).

## V3: hello-world + -ProbeNeighbor (05:48Z): NEIGHBOUR ACCEPTANCE INCONCLUSIVE (expected)
- The same report and seccomp proofs as V2, and the probe domain has its own front uid (1053578).
- The neighbour served the pinned bytes before and after.
- The verdict is INCONCLUSIVE by the judge's rule: ENOENT means absent from the view, not a denial of something shown to exist. This is unchanged from v42 and matches DEPLOYMENT.md's B3 non-claim.
