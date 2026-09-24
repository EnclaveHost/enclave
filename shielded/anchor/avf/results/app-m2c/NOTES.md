# Milestone 2 again, after the attestation-ordering fix (Pixel 10, 2026-09-23 21:32, build rt8 `4b95f8a1…`)

Why: the audit of the identity binding (PVM-CPU.md, "Audit") found that the payload requested the ABI/2 certificate --
whose challenge names AppID = the APP line's digest -- BEFORE anything checked that the received bytes hash to it; only
pvm-rt checked, at compile. results/app-m2 (rt4) shows it: the bad-digest launch got a genuine 5-certificate chain naming
AppID 000…0 for an app the VM then refused to run. rt8 hashes the received component in the payload and refuses before any
certificate names it.

`cpu/app-run.sh` (now with unique device capture labels: an earlier re-check, q17, silently re-read the rt4 captures
because the labels were taken; its output was discarded) -> `check-app.py` **PASS** (check.txt):
- every case byte-identical to the reference, exit codes equal, the contract's runtime identity;
- the wrong digest: `APP refused: bundle sha256 faaf2071… is not the expected 0000…: refusing to compile (and to attest
  it)`, nothing ran or printed, and **no ABI/2 certificate was requested** (no `ABI2` line in the capture);
- ap-case1's ABI/2 evidence still verifies (abi2-ap-case1.json, nonce `1a200bba…`: the owner's challenge).
Logs normalized after capture (trailing spaces only).
