# Legacy path of a -release guestd, on real SEV-SNP (2026-09-25 19:21-19:22Z, PASS)

This is the pre-4d check in `isolation/m4/evidence/production-release-d1a38994/INSTALL.md`. At 4d, production guestd
runs with `-release -legacy-isolation <the 0181bce3 tree>`. Every deployment the supervisor does not mark release is
then built from the PREVIOUS tree and booted by the NEW tree's `run-domain.sh`, with a CID that guestd chose. That had
never run on hardware.

Run: `~/enclave-bench/lab-release/legacy-run-20260925a`, by `isolation/m2/lab-release/run-legacy-check.sh` at 63ff0284.
- The lab guestd, run-domain.sh, fwd and judge come from this tree; its code is identical to d1a38994.
- The legacy tree is `git archive 0181bce3` extracted into the run dir. The lab never builds in `~/enclave-prod`.
- The app is the hookbin canary's catalog app (0xf7e65a8f…/4, CID bafkreidocb…), with the derivation record that the
  relay's known-answer test pins. The deployment id is synthetic.

## Result
- guestd `/health`: `supports.release` and `supports.legacyImage` are true; `config` and `secrets` are false (so the
  live supervisor's claim gate would be unchanged).
- Guest `lb0cbc9c2d` (release unset, so a legacy guest): `legacyImage: true`, running, verdict **attested** (guestd's
  judge).
- **AppID d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24** and **measurement
  be6b8644384eee12396881e3e4cbca4259ae1a16a1e198d2c48d577ff7b3c6d355971eccebe8353749439adca718da4d**. These equal the
  LIVE hookbin canary's (gdb677d751, from its VCEK-signed report of 2026-09-24, as in the relay's KNOWN_ANSWERS[0]).
- `expected-measurement.sh --pin 5c3561f9…` against `~/enclave-prod/release-0181bce3` (read only) reproduces it.
- The app answered through the front: HTTP 200 (hookbin's page).
- The serial log (`serial-dom.txt`) shows the 0181bce3 front: runtime ccadb38a…, the certificate name from HOST_DATA,
  and serving on vsock 443.
- Production m2-gd* units were identical before and after. No process from the run dir and no m2-lb* unit remained
  (cleanup, re-checked by hand).

So the new tree's boot path (the CID choice is its only change to run-domain.sh) leaves a legacy guest's launch
measurement exactly as production's. A canary relaunched by a 4d guestd before rows 7-8 keeps its current measurement.

## Independently confirmed (enclave-d1, 2026-09-25)
- The legacy tree matches `git archive 0181bce3 isolation` exactly: 0 files differ, 0 are extra.
- The boot path tested is the production candidate's: between 63ff0284 and d1a38994 there is no diff in m2/run-domain.sh,
  m2/fwd, m2/client.mjs, m4/guestd or m1/.
- d1 reconstructed the result without this harness:
  - the component, CAR-verified from trustless-gateway.link (201013 B);
  - `derive_reference.py` at 0181bce3, giving AppID d2c4dfc0… and record 1fb9360d…;
  - `expected-measurement --pin 5c3561f9…`, giving be6b8644…da4d.
- Production guestd's own record for the live canary gdb677d751 (read only) carries the same AppID and measurement, with
  verdict attested.
- Afterwards production still had the same 3 m2-gd* units, and no process was running from the lab dir.
