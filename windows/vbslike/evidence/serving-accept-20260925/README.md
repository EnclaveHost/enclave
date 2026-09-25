# The measured type-1 guest SERVES through the manager and the node on real Hyper-V (2026-09-25, run 082325)

enclave-d1, nucbox-k11, boot 68, Secure Boot ON. Times are box-clock log lines. No legacy backend is involved: this is
the custom type-1 path only.

**Scope of the result.** This is app serving, lifecycle and recovery at the T0-hv tier. Every report here is signed by
the HOST's launcher key, which is a host statement and never a root. It is NOT evidence of host exclusion
(host_excluded=no throughout), and no hardware VM report exists. The report, signer and key-binding dependency is
unchanged (PROOF-CHECKLIST "Outstanding dependency").

## Inputs, pinned

| what | pin |
|---|---|
| IGVM | `a44bb55a…` (launch digest `58DFEBFE…`), from enclave-63's v33 `pkg\69262a44e7e13901\` |
| runtime identity, app | v33 `guest\runtime.json` (RuntimeID `ccadb38a…`); hello-world `spawn.json` (AppID `9c3d10f1…`, policy memMiB 128) |
| launcher (wmiserve, one per domain, `--hold stdin`) | `vbslike-host.exe` **`435717def62bb5c9a632f80210b5c3fbcbeb7cb8c1047f9beef4ca578ebe99e7`**, built on the box from `1a6f1556` (the `50010709` tree plus the format fix, lock `5c0ee1b7`). It is not yet packaged |
| node, manager, data plane | `windows/hv-acceptance` `0b7652c8` (5d's wiring plus d1's manager), `npm ci --omit=dev`; harness `manager-accept.ps1` from `9d070a61` |
| acceptance checker | enclave-5d's `hvlab-accept.mjs` from `isolation/portable-runtime-jit` `c192380c` (sha256 `5830dedc…`) |

Bounded by `manager-accept.ps1`:
- AllowFirmwareLoadFromFile was applied, then restored to Absent (verified);
- the 9001 hv_sock GUID was registered because it was absent, then removed (verified);
- the watchdog was armed and did not fire.
After the run: no VMs, no wmiserve processes, Secure Boot on.

## Phase 1: `HVLAB-ACCEPT ALL PASS` ([pass-082325/driver.out](pass-082325/driver.out))

Through the node's own `ensureApp`, app zone, tunnel hub and data plane, against the real manager and real partitions:
- **Running.** The domain reaches `running` in 21 s. Its labels are T0-hv with the host NOT excluded. The guest states
  `hv_isolation=vbs` (a stated configuration, not a proof).
- **The browser session.** A browser session goes tunnel, app zone, data plane, domain, and the TLS key it sees is
  the one the manager verified (`54070cb8…`). The app answers `200 "Hello World!\n"`.
- **Refusals.** The verifier refuses another key, another nonce and another app. The data plane admits the exact record
  and refuses another key, image, app or runtime, and an instance it does not hold.
- **A forced relaunch.** It gives a NEW instance and a NEW key. Exactly one instance remains. The old session ends. The
  old route, and the new instance under the old key, are refused. The browser reconnects on the new verified key.
- **A node restart.** It adopts the SAME instance and key, and the app answers. Cleanup retires the instance and confirms
  it gone.

## Phase 2: `RESTART-ACCEPT ALL PASS`, serving

- A0-A2: one partition carries this id.
- **A2s:** `running`, with a relay that accepts TCP. The record names the launcher key, image `a44bb55a…` and the
  statement `{wmi-openhcl-gen2-igvm-linux, igvm-linux-direct}`.
- **A3:** the manager is killed, and the VM stays Running.
- **A7:** the relay port then REFUSES, because wmiserve's stdin reached EOF.
- **A4:** a new manager recovers the VM as `recovered:true`, `starting`, with no relay. It never serves.
- **A5:** a second spawn gets 409 naming the same id, and there is no second VM.
- **A6:** DELETE removes it by VM Id, and GET answers 404.

## The first run failed, and why ([fail-081904/driver.out](fail-081904/driver.out))

Run 081904 used the packaged candidate launcher `15338081…`.
- **What held:** load, relay, the record's statement and A7 held, and recovery passed.
- **What failed:** the manager's judge refused EVERY report as `report format/tier`. wmiserve.rs signed with a stray
  local format name (`hyperv-vbs-partition-v1`), where the contract, judge-hv, the verifier registry and the Go contract
  say `hyperv-partition-domain/v1`.
- **The fix:** `1a6f1556` makes wmiserve use the shared constants, and a drift test reads the Rust source. The
  launcher was rebuilt as `435717de…`.
- **So `15338081` must NOT be promoted.** It fails the judge. The launcher that passed is `435717de`.

## Repeated on the PACKAGE, with the liveness sweep: run 084443 on v34 (`pkg\6c82ff93fd3e3718\`)

Changes from 082325:
- enclave-63's v34, whose ONLY launcher is `control\vbslike-host.exe` `435717de…`, re-roled on 082325;
- the tree `windows/hv-acceptance` `4a51c13f`, adding the manager's liveness sweep (`d7d4fd1c`, the consequence of G4)
  and enclave-5d's node boundary review (`9b79022c`);
- A8 added to phase 2.

[pass-084443-v34/driver.out](pass-084443-v34/driver.out):
- phase 1: `HVLAB-ACCEPT ALL PASS`;
- phase 2: A0-A7 as before, plus:

      A8: turned 8e5f4c71-95f9-4ca9-ae35-f1100fc4a337 off from the host -> {"state":"Off"}
      PASS A8: after turning 8e5f4c71-… Off: status failed within 4022 ms, reason "the partition is Off: it stopped by itself (on type 1 a guest reset turns the VM Off, measured in G4 run 082856); its VM is left for the node to retire", relay 58425 refuses
      RESTART-ACCEPT ALL PASS

A8 makes the Off state G4 measured by turning the VM off from the host, so no probe serves anything. The manager's
sweep (every 5 s for this run) failed the domain and closed its relay within 4 s. DELETE then removed the Off VM.
AllowFirmwareLoadFromFile and the 9001 service were restored and removed (verified).
