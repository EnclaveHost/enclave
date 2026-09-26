# Three-line release edits (since cs-3 the certificate set is EXPLICIT)

This follows enclave-87's hard order of 2026-09-26. Since cs-3 (2026-09-26 04:58Z), `SECRETS_RELEASE_CERT_RELEASES` names
the certifiable releases. So an admission or a retire has to move THREE lines together, or new guests get no certificate:
- `SECRETS_RELEASE_PREDICT_RELEASES`
- `SECRETS_RELEASE_DOMAIN_RELEASES`
- `SECRETS_RELEASE_CERT_RELEASES`

**`../../measurement-prediction/stage/stage-release-keep3.sh`, for rs-9 (admit beside the current release):**
- BEFORE_LINES must be exactly the three live lines, in key order, with CERT equal to DOMAIN.
- The new release joins all three.
- The sandboxed check requires:
  - both admitted images, at CROSSCHECK and CROSSCHECK_KEEP;
  - the cert-set images equal to {keep, new}.

**`../../measurement-prediction/stage/stage-retire3.sh`, for rs-10 (retire):**
- The dropped release leaves PREDICT, and DOMAIN = CERT = KEEP.
- The check requires, per canary version, ONE release image and ONE cert image, both on KEEP, at the pin.

**`rs3-remote.sh`:** rs-8-remote.sh for three lines.
- It replaces exactly 3 lines, wherever they sit in the file (cs-3 appended CERT at the end).
- The diff must show 6 changed lines, and the added lines must equal the TO file (order-independent).
- `consistent()` (enclave-5d's M1) refuses, before any write, any result where NOT (admit ⊆ installed AND cert ⊆ installed
  AND admit ⊆ cert).
- Sandbox (warden-host):
  - a good apply is written, and the other lines are kept;
  - a TO with an unchanged CERT line is refused (not 3 lines replaced);
  - a TO whose cert set drops an admitted release is refused by `consistent()`, nothing written and no temp file left.

**The BEFORE_LINES file** is built on nan from the live env: the three lines in key order. It is never typed.
