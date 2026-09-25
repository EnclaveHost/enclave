# v40 lab validation: the package's own sweeps, and a bounded stability series (6/6 PASS)

**What was checked.** enclave-63's package v40 (windows/vbslike-pkg `f4a0bf27`, id `15f39ae4d1fab954…`, staged at
`pkg\15f39ae4d1fab954\`), run from a lab COPY with the package's OWN tools and its OWN manager sweeps (liveness
15000 ms, answer check 30000 ms, as its managerEnv states). This closes READINESS.md U2 (the package's own env) and
gives the bounded stability run for U3.

**Scope: functional serving and stability only.** hello-world only, with no probe and no customer app.
`host_excluded=no`. Not eligibility, not isolation, not production attach. Respawn OFF; recovered VMs HELD. The
firmware opt-in and the 9001 service were set only per run by manager-accept, and restored and verified each time.

- Box: nucbox-k11, Secure Boot ON.
- Box clock: series 13:09:43Z to 13:26:47Z, 2026-09-25. The log is `series.log.txt`.
- Lab copy: `C:\Users\claude\d1-v40-lab\pkg` (robocopy of the staged package).
- **The staged original was untouched:** before and after the series its listing sha256 is
  `75d02be5e217a600d8d672029e4e67c0e71cea03cb554d1e8468d21995380312` (12544 files), and the copy's equals it.
- **Tools, from the copy's own `control\windows\vbslike\manager\ops\`:**
  - `manager-accept.ps1` `010d3e9b…`;
  - `restart-accept.mjs` `c91ec4ae…`;
  - `multi-accept.mjs` `8be8bd2f…`;
  - `hvlab-accept.mjs` `5830dedc…`.
  Plus `-LivenessMs 15000 -AnswerCheckMs 30000`; each driver prints "sweeps: … (as configured)".
- **Inputs:** IGVM `b7ba7731` (the eligible reference image; prospective only), launcher `435717de`, master
  `type1.vmgs` `4f051697` (blank), fetcher with `PYTHONDONTWRITEBYTECODE` (`fetchcid.mjs` `5f3443c4…`, i.e. `3919c18b`).

## Results

| Run | Driver | Result | Details |
|---|---|---|---|
| 1 (130943) | A: hvlab + restart A0-A9 | PASS | A9 failed after 70086 ms (3×30 s answer checks); A8 within 2023 ms |
| 2 (131345) | B: multi-accept M0-M7 | PASS | memory 99816 → 93476 (3 running) → 99918 MiB free |
| 3 (131519) | A | PASS | A9 70127 ms; A8 2025 ms |
| 4 (131920) | B | PASS | 99953 → 93506 → 99923 MiB |
| 5 (132055) | A | PASS | A9 70161 ms; A8 1008 ms |
| 6 (132455) | B | PASS | 99946 → 93509 → 99947 MiB |

Every run:
- the tree hashed at use was 12493 files, list sha256 `819bed7da53e4c27…` (the same in all six);
- after cleanup, **"TREE UNCHANGED by the run … (no __pycache__)"**, so the M6 fix holds on the box;
- "SETTING RESTORED to Absent (verified)" and "hv_sock service … removed (verified)";
- driver exit 0, harness exit 0.
After the series: 0 VMs, setting Absent.

**Observations:**
- About 2.1 GiB per type-1 VM. Free memory returns to within about 100 MiB of its starting point after every
  three-VM run: no growth across the series.
- With the package's own sweeps, a monitor stopped inside a Running VM is failed in about 70 s (three answer
  checks). A VM turned Off is failed within one liveness poll (≤ 15 s; 1-2 s measured).

## Files

`series.log.txt`, and for each run `run-<stamp>/driver.out`, `harness.log.txt` and `config.json`. The tree hash lists
stay on the box under `C:\Users\claude\vbs-evidence\mgraccept-20260925-<stamp>\` (identical digests, above).

## Unchanged boundaries

See `../../READINESS.md` §5. B1 (report capture), B2 (E3) and B3 (the probe extensions) stay PARKED. P1 (the domain
socket filter) is PAUSED. Nothing here is host-exclusion evidence.
