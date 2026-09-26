# rs-12: retire 5db18199 (the release before R)

This follows enclave-87's order of 2026-09-26. It is the same shape as rs-10 (retire-f7888d86, with ROLLBACK.txt bb087bae),
using the derived-scope guard from three-line/leased-attest-next.mjs (bf GO @ f63b38ea).

**When it runs:** ONLY after 63's e8 is ACCEPTED, meaning every canary has been relaunched on R = aee2059f.
- The NucBox reboot freeze excludes it.
- It needs ≥10 min since the previous api-relay restart.
- If it runs mid-soak: the NucBox mutex is taken with the peer's ACK before starting, and nucbox-k11 attach must be ACCEPTED.

## What changes

The three release lines, in one api-relay restart. METAL_ALLOWED_MEASUREMENTS is NOT touched: 02f6e313 stays as N2-b's 72 h
rollback target.

| line | before (rs-11's after, 6877d7de) | after (a2d1da9f) |
|---|---|---|
| PREDICT_RELEASES | 5c3561f9, 6f14ce75 (KAT), 5db18199, aee2059f | 5c3561f9, 6f14ce75, aee2059f |
| DOMAIN_RELEASES | 5db18199, aee2059f | aee2059f |
| CERT_RELEASES | 5db18199, aee2059f | aee2059f |

After it, a guest on 5db18199 gets neither secrets nor a certificate.

## Staged on nan (nothing live touched)

07:11:48–07:12:26Z, `stage-retire3.sh` (0fa00faa, bf GO, as for rs-10):
- BEFORE = the live three lines (6877d7de); NEW = a2d1da9f;
- sandboxed check with nan's module PASSED: KAT, and for each canary version exactly one release image and one cert image, both
  on R at the pins (0ddbd824 3facefd8; 395bed3e/4e62e60d 8a291bbf).

## The guard: leased-attest.mjs

It is leased-attest-next.mjs with ONLY LISTED's pins retargeted to R, plus the message strings (a 38-line diff). Every
release-listed deployment holding a live lease on a relay-verified SNP host must serve R, chip-verified from its own report: AMD
chain, HOST_DATA, the ABI/2 binding of our TLS handshake + a fresh nonce + the runtime, the AppID, and measurement = R's pin.

| deployment | R pin | source |
|---|---|---|
| canaries | 3facefd8 / 8a291bbf | 63 + bf, independent |
| a69dcbba | 5be51185 | bf + mine |
| d9798e4c | ee2c9690 | mine (nan's module over the ledger's ref; 5db18199 control exact); for bf to recompute |
| a77d0c57 | 2fb5058b | mine, as above |
| 7ae476a3 | 6be3838b | mine, as above |

Live negative control at 07:11:30Z (evidence/guard-negative-control.txt): it REFUSES. The 3 canaries are AMD-verified, bound,
and still at 5db18199's measurement.

## Scripts

- **`rs-12.sh apply|rollback`** is rs-10.sh (bf GO, run 06:28Z) with only these changes:
  - DEST and the hashes;
  - the release names;
  - nucbox-k11's row recorded before (rs12-lib.sh);
  - the rs12- names.

  The guard, the instant probe and the apply-time auto-rollback are kept.
- **`rs-12-accept.sh apply|rollback`** is rs-10-accept plus rs-11's NucBox block:
  - nucbox-k11's attach line in the NEW invocation within 180 s, and off the relay under 10 min;
  - its row = the recorded one;
  - health with ADMIT=aee2059f (rollback: "5db18199 aee2059f").
- **`rs12-selftest.sh`** passed 6/6. It is read-only and calls no apply path: hv_row and hv_attach_line on the box and on a missing
  name; health for the rollback target PASSES now; health for the apply target FAILS now on the expected guest.

## Rollback (ROLLBACK.txt)

A return to 5db18199 is rs-12's rollback FIRST, then 63's S9 rollback and each canary relaunched back onto 5db18199. Never S9
alone. rs-12's own rollback only re-admits, so it has no guard.

## Pairing note (b4's rule; judge.mjs)

A relay retirement pairs with the table change on EVERY consumer tree. After rs-12, the chain rev AFTER R removes 5db18199 from
judge.mjs's SECCOMP_UNSTATED_RELEASES, on both the guestd tree and the node image (N3). LEGACY_WX_RELEASES never held 5db18199:
it holds only the 2 KAT releases.

Until that rev, the node's judge still lists 5db18199. That is harmless: the node certifies only relay-predicted releases, and
after rs-12 the relay predicts R alone.
