e7 (2026-09-26): the 3 canaries relaunched one at a time onto release 5db18199 (image 0c087de8: per-release W^X, the
runtime self-test stated AT ATTEST; the app under dominit's seccomp filter; the e6 hardening kept) by the owner's restart,
after S8 (guestd.0c087de8 on iso-0c087de8). bf GO on e7 v1; enclave-87 pre-authorized the three relaunches.
  0ddbd824 gdecc7a0a0 6716ef14 key 1868e492  ACCEPTED 05:49:51Z
  395bed3e gdded47deb be2bb73c key afedf53d  ACCEPTED 06:07:46Z
  4e62e60d gd2ae6d157 be2bb73c key 39223442  ACCEPTED 06:25:47Z
Proofs 1-9 + a 10-min observe each. Proof 8 (W^X at attest; fields from enclave-b4): verify.txt VERDICT attested, gate
open, wx_coverage=runtime-covered, runtime_selftest "exec_pages=allowed wx=clean maps=3 runtime=1 root=2
scope=all-processes" on all three. Proof 9 (seccomp): NOT REFUSED, NOT POSITIVELY ATTESTED (implied by the measured
dominit's exit-125 path and serving; enclave-87's wording; a positive attested field is the next chain rev). Front uid:
n/a on SNP. Each new instance.json records Releases=[5db18199]. The measurements are e7-pins.sh's independent derivation
from the installed tree (= enclave-bf's own values = the relay's admitted prediction). Certificates took 1, 2, 2 retry
lines (the live node image's 300 s back-off; fixed on isolation/guestcert-retry-e63 2492e683, 5d GO, next node image).
