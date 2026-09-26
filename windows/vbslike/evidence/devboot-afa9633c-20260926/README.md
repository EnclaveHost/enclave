# v44 NucBox candidate afa9633c (guest 4cd26e58): DEV-BOOT canary, 2026-09-26 (during the v42 soak)

**Verdict: PASS on the dev-boot path.**
- v44's positive seccomp evidence is present at all three places: domexec's line, the monitor's line, and
  `seccomp=<hash>` in the attested `runtimeSelfTest`, all for the filter `d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66` (71 rules).
- Every v43 fact still holds.
- ProbeDomain **PASS**. ProbeNeighbor INCONCLUSIVE (the unchanged ENOENT reason).
- Run by enclave-d1 under enclave-87's narrow GO (test 1 untouched; the boots coexist with production). Tier T0-hv, host_excluded=no: not an isolation claim.

| | |
|---|---|
| IGVM | sha256 `afa9633c973dd7283613de99df97d3f7b7f3c41ff6eeaa65bac6a52fa95957dd`, 78128764 B, VBS `D9B4E0A6…` (enclave-53: from isolation/seccomp-evidence `4cd26e58`, initrd `e8715775…`) |
| script | windows/uefi-dev-boot-pin-afa9633c-e53 `cf0286da` (uefi-dev-boot.ps1 `b13b6f7d…` = 5d's two-layer judge `446777b3` + one pin line with `layers = $true`) |
| on the box | a LAB copy `C:\Users\claude\d1-canary-afa9633c\`; the VM-worker read grant was added, then removed and reset (icacls-*.txt) |

## The relay-restart overlap (enclave-87's ruling) and what was re-run
enclave-e3's rs-11 and this run's start crossed: e3's "STARTING" at 07:05:35Z, d1's claim at 07:05:38.952Z.
- The api relay restarted at **07:05:45Z** and nucbox-k11 re-attached at **07:05:55.403Z** (e3, nan's journal).
- **V1** (07:05:39–07:08:03Z) overlapped that span in time. The dev boot never uses the api relay (it serves through its
  box-local lab relay 127.0.0.1:19500), but by the ruling it was RE-RUN as **V1b** (07:08:3x–07:11:25Z). The superseded V1 is kept in `superseded-V1/`; it shows the same lines.
- V2, V3 and both R4 checks were entirely outside the span.

## V1b: hello-world, -G4WatchSeconds 100, console-read after ready, one attested-document fetch
- Pre-ready (the dev-boot script's CONSOLE lines): `MON boundary …`, `MON yama ptrace_scope=1 -> 2`,
  `MON user.max_user_namespaces=7211 -> 0`, `MON kernel.io_uring_disabled=0 -> 2`, then `MON ready`.
- After ready (V1b-console.txt):
  - `MON domain 1 loaded … uid=5001 front_uid=1053577 …` (the front on its own uid);
  - **`DOM1 seccomp: runtime filter installed (sha256 d4d17c9f53832439…, 71 rules)`** (domexec);
  - **`MON dom1 seccomp: runtime filter installed (sha256 d4d17c9f53832439…)`** (the monitor);
  - NO `MON dom<n> ERROR the runtime's seccomp statement: …` and NO `DOM<n> ERROR the runtime's seccomp …`;
  - `DOM front: not dumpable; none of its 3 threads traced`; `DOM runtime selftest exec_pages=allowed wx=at-each-attestation`;
    `DOM serving … ready_ms=2898`;
  - every line is MON/DOM.
- The attested document (V1b-attestation.json, a fresh nonce, HTTP 200): `abi enclave-domain-abi/2`,
  **`runtimeSelfTest: "exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 seccomp=d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66 scope=cgroup:/dom1"`**.
- The app served exactly the pinned 13 B.

## V2: -ProbeDomain (07:11:43–07:12:37Z): PROBE DOMAIN RESULT PASS
- `report` and `filtered_report` are Permission denied: the runtime is refused a report.
- `seccomp=2`, and all four `filtered_vsock_*` are `Operation not permitted`. The distinguishing line is
  `filtered_vsock_host_control` EPERM against the unfiltered `timed out (no answer)`.

## V3: hello-world + -ProbeNeighbor (07:12:37–07:13:33Z): NEIGHBOUR ACCEPTANCE INCONCLUSIVE (expected)
- The same report and seccomp proofs.
- The probe domain has its own front uid (1053578).
- The neighbour served its pinned bytes before and after.

## Test 1 (production) untouched
- Before, 07:05:29Z: record `hv88b31102…` running, key `4d80b956…`, uptime 12641 s; R4 `x=open ca=200 k=200 spki=4d80b9566a3ab6c4`.
- After, 07:13:46Z: the same record and key, uptime 13138 s (no restart); R4 `x=open ca=200 k=200 spki=4d80b9566a3ab6c4`.
- No lab VM is left.
