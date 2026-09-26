Step 4 (4e) of isolation/restore/ENABLEMENT.md: the 3 canaries relaunched as attested RELEASE guests on release 79c5ecf2,
one at a time. The owner restarts were made by enclave-d1 (on Steven's instruction to d1). Each was verified
INDEPENDENTLY and read-only by enclave-63 with e4-verify.sh -> e4-proofs.sh (the five proofs + a 10-min observe), then
ACCEPTED (state/accepted-<id8>):
  0ddbd824 (hookbin)  restart 23:47:16Z  guest gde1277bac  measurement 2317370d...21262ea  key c0894ac9...  ACCEPTED 00:04:47Z
  395bed3e            restart 00:05:04Z  guest gd65f964b3  measurement 6de87365...bd92c9b25 key 9f78d94c...  ACCEPTED 00:16:54Z
  4e62e60d            restart 00:17:21Z  guest gde31e154c  measurement 6de87365...bd92c9b25 key bf7ec81d...  ACCEPTED 00:33:45Z
Each measurement = the relay's /v1/expected-guest answer FOR THAT ID under 79c5ecf2 (admitted). 395bed3e and 4e62e60d
share app 9c3d10f1, hence one value; hookbin is app d2c4dfc0. All three guests are vcpus 1 / 1024 MiB.
Proof 3's first expectation (config null) was WRONG: the canaries' on-chain envelope {"isolation":{"require":...}} (45 B,
sha256 42c6f115f763f544... = the serial's envelope tag) names no config, so the relay releases the catalog VERSION's
inline config: its public "_media" tile art, 177 B (hookbin) / 194 B, 1 allowed origin (the relay's, always present).
Verified by enclave-d1 and enclave-e3 from two RPCs; parity with the standard runner. The first hookbin check HELD on
that (0ddbd824-*.run1-held) and passed after the correction. The legacy-serial controls (the app's own stdout present):
4e62e60d-old.serial is a copy; for 0ddbd824 and 395bed3e the legacy guest was reclaimed before a copy, and the read is
recorded in *-old-control.txt.
