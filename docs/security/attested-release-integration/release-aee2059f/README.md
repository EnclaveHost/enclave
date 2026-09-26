# rs-11: the combined SNP relay window (R + N1-a + N2-a)

This follows enclave-87's orders of 2026-09-26 and enclave-63's N2 plan abb87c12. It is ONE api-relay restart, allowed during the
NucBox soak by 87's ruling. The ruling requires:
- ≥10 min after the previous restart;
- the box off the relay for under 10 min;
- "nucbox-k11 attach ACCEPTED" in the checks;
- rollback armed.

## What changes

Four env lines in /etc/nan-relay/api-relay.env, each replaced line-wise, with every other line byte-identical:

| line | before | after |
|---|---|---|
| SECRETS_RELEASE_PREDICT_RELEASES | KAT 5c3561f9, 6f14ce75 + 5db18199 | + R aee2059f |
| SECRETS_RELEASE_DOMAIN_RELEASES | 5db18199 | 5db18199, R |
| SECRETS_RELEASE_CERT_RELEASES | 5db18199 | 5db18199, R |
| METAL_ALLOWED_MEASUREMENTS | 04e953a4, 10622d98, 8ab7a159, 02f6e313 (f6cbd75a) | the same 4, in order, + N1 b2dba54a + N2 fab9c6c7 |

- **R** = aee2059f: image 4cd26e58, isolation/seccomp-evidence. bf gave the release GO, with an independent cold rebuild that was
  diff -r identical. 53's publication artifact is a DRAFT.
- **N1** = b2dba54a: node image 2492e683. 5d gave GO, with a third-path reproduction.
- **N2** = fab9c6c7: node image 6845565a. d1 gave GO, reproduced from a third path.
- **02f6e313** is the live node image (f6cbd75a). It is KEPT, because it is N2-b's rollback target.

## Staged on nan (nothing live touched)

- 06:57:01–06:57:39Z, `stage-release-keep3.sh` (be43f810) from 53's reviewed copy (tar 4615add4):
  - the release is verified (15 files) at /opt/enclave-predict/rel-aee2059ffcc7;
  - BEFORE = the live three lines (03e0ccf1, which is rs-10's after); NEW = 6877d7de;
  - the sandboxed check with nan's module (5ba49756) PASSED: KAT; a69dcbba's version admitted = {5db18199 c8ac2d72, R 5be51185};
    cert set {5db18199, R}.
- 07:00:26Z, the four-line files in the same directory:
  - lines4.before.env d2598b43 = the staged before + the live allowlist line. It was checked to be the 4 expected entries, with
    N1 and N2 not yet present.
  - lines4.env 414810a3 = R's three lines + that allowlist line with N1 and N2 appended.

## Pins under R (rs-11-accept → health.sh)

63 and bf computed these independently with 4cd26e58's expected-measurement.sh --pin, over the live bundles, and they equal the
relay predictor's:

| canary | R measurement |
|---|---|
| 0ddbd824 | 3facefd8… |
| 395bed3e and 4e62e60d | 8a291bbf… |
| a69dcbba | 5be51185… (bf and mine) |

## Scripts

- **`rs-11.sh apply|rollback`** is rs-9.sh with only these changes:
  - the pins, in rs11-lib.sh;
  - the remote becomes `../three-line/rs4-remote.sh` (rs3 plus the allowlist line, with `allow_ok`; sandbox-rs4 28/28), with
    ADD = N1,N2;
  - the S8 guard is replaced by `rollback_guard`: a rollback refuses while metal-iso0 attests N1 or N2 (roll the node back first),
    while 63's S9 epoch file exists (guests on R), or when the node's measurement can't be read. OVERRIDE=<reason> gets past it.
    The apply-time auto-rollback on a predictor PROBLEM passes it: nothing can depend on the additions seconds after the apply.
  - nucbox-k11's row and the restart time are recorded before.
- **`rs-11-accept.sh apply|rollback`** is rs-9-accept plus:
  - the live allowlist line = the staged one;
  - nucbox-k11's attach line in the NEW invocation within 180 s, and the time it was off the relay (restart → attach) under 10 min;
  - its row = the recorded row;
  - metal-iso0 back on 02f6e313;
  - health with ADMIT="5db18199 aee2059f" (rollback: 5db18199).
- **`rs11-selftest.sh`** (read-only, live, before the window) passed 15/15. It checks that each added check passes on the live
  state and refuses where it must:
  - the guard: N1, N2, an unreadable node, the S9 epoch;
  - rs-11.sh rollback refuses at its guard with rc 4 before touching nan;
  - the allowlist is live = before and ≠ after;
  - health with 5db18199 passes now, and with 5db18199 + R FAILS now on the expected guest.

## Rollback

- `rs-11.sh rollback`, then `rs-11-accept.sh rollback`. This is one more restart.
- Before N2-b and S9 it is harmless: it removes only additions nothing uses yet.
- After either of them, roll that back FIRST. The guard enforces this.
