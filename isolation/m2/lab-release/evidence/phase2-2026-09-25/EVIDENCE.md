# Release lab, phase 2: admission INDEPENDENT of the host, on real SEV-SNP (2026-09-25, PASS)

Run: `~/enclave-bench/lab-release/phase2-run-20260925b` (18:34:11Z–18:34:35Z) by
`isolation/m2/lab-release/run-lab-phase2.sh` at 4f17b681. The image-affecting tree was frozen at 5ce7ced6. The pass
condition was committed first (PASS-CONDITION.md, 3bd74ea0). Relay: enclave-99's `lab-relay.mjs`
(security/attested-release), serving from 18:33:04Z. The files here are copied from the run; the synthetic keys, the
seed, the pairing key and the synthetic release file are NOT included (checked: none of them appears in any file here).

## The path, all production code but the ledger row and the synthetic keys and config
1. **Supervisor** (supervisor.js, RELEASE_SELFTEST spawnReal = the real spawnContainer over guestd-control/1).
   isolationSpawnRelease read the relay's list (listed); isolationDerivation gave record bc1ac3be…; POST /vms created
   release guest `lbbbb8202b` with app 94c04c0e… (supervisor-isolation-lines.txt). The real ticket pump waited for
   awaitingTicket, fetched a ticket with fetchReleaseTicket (operator-signed, endpoint https://lab-iso.enclave.test)
   and handed it to guestd ("release ticket handed to guest lbbbb8202b").
2. **guestd** (lab: this tree, -release, prefix lb, lab ports, paired) built the guest from the CATALOG derivation
   (ipfs:// + derive) and handed the ticket on vsock 19444 to that guest's CID only.
3. **The guest** (the frozen front, lab pins) reported with the release binding and reached the relay over TLS pinned to
   the lab name and CA through the lab router ("guest 146244 egress open (lab relay)").
4. **The relay** (enclave-99's real handleRelease), relay-side log:
   - 18:34:25Z POST /v1/secrets/release-ticket 200 (113 ms), loopback 19481, operator-signed;
   - 18:34:26Z POST /v1/secrets/release 200 (878 ms), TLS 19480: "released to a verified guest on
     https://lab-iso.enclave.test (runtime ccadb38a6779…)".
   A 200 there means, by construction:
   - the lease holder was confirmed (lab row);
   - the REAL predictor answered, with the runtime admitted only paired with 6d18f7ad's measurement;
   - verifyEvidence returned verified with KDS collateral: VCEK→ASK→pinned Turin ARK, the TCB floor, VMPL 0,
     report_data = the release binding ‖ AppID, HOST_DATA = the deployment;
   - the relay's own re-read agreed: VCEK-signed, DEBUG off, VMPL 0, the measurement = the one predicted, and
     CHIP_ID ∈ the ticket's chips (fa11afcf…).
5. **The guest** verified the relay's response signature under its pinned lab key, opened the seal, derived 4 allowed
   origins (0 refused), and handed init 1119 bytes of ENCLAVE_CONFIG. The app started.

## Checked by the harness (run.txt, spawn.json)
- guestd's view: status running, verdict attested (guestd's own judge), release true, hostData = the lab deployment
  id, recordSha256 bc1ac3be…, runtimeId ccadb38a….
- AppID **94c04c0edb6b4ca11b9bd0b6e4adfa98afdfa04692e6c10af79755e6db0ba0f2** = the prediction recorded before the run.
- Measurement **701946112b68fabcf5fc41982eacf17bac91c8f204c0b7178af84fa301ebe550d13444be421cb7b672544d335441f709** = the
  prediction recorded before the run. `expected-measurement.sh --pin 6d18f7ad…` reproduces it from the release and
  the derived bundle.
- api-mcp-adapter on the RELEASED synthetic config: tools/list **200** with the released key, **401** with none, and
  **401** with a wrong one.
- No synthetic secret value in any host-side file: guestd root and logs, serial, the units' journal, the supervisor's
  log, the router log.
- Production m2-gd* units were unchanged (prod-units-before/after.txt).

## What is LAB (stated)
- The ledger row (lease holder = the lab endpoint) is the relay's lab JSON; the deployment has no real lease on chain.
- The operator key, the release signing key and the TLS cert/CA are synthetic, generated for the session. The front's
  pins are LAB pins (a lab image, admitted by no production relay).
- The config and secrets are synthetic, in api-mcp-adapter's real shape.

## Earlier attempt
18:33Z: the supervisor's spawn created guest lbbff9a318 with the predicted AppID, then the seam process exited
mid-pump (the pump's timers are unref'd; fixed in 4f17b681). The relay saw only status calls; production was
unchanged.
