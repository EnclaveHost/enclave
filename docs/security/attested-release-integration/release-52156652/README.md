# rs-5: release 52156652 (image 4cdd5169) installed and admitted beside 79c5ecf2

The relay's predictor must predict AND admit a release before guestd builds guests from its tree: 63's S5 tree switch
checks that /v1/expected-guest lists 52156652 as admitted for each canary. enclave-87 approved admitting BOTH releases
for the transition, because the canaries run 79c5ecf2 until 63 relaunches them.

LIVE since 2026-09-26 01:05:44Z; ACCEPTED 01:07:47Z (`apply-accept.log`, `accept-sh-outputs.txt`).

## The release
- 52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1, image commit 4cdd5169.
- 63 built it twice, byte-identical (~/enclave-bench/pub-0181bce3/cut-4cdd5169/CUT.txt).
- Its only difference from 79c5ecf2 is template/front (76f345bc). 5d's own build of front matches.
- It verifies against its id with the toolchain's release-manifest.py (15 files), both on warden-host and on nan.

## Cross-check: four derivations agree
| app | 79c5ecf2 (unchanged, live) | 52156652 | independent source |
|---|---|---|---|
| api-mcp-adapter (0x5bca36b5…/0) | 20319b02… | 20b366485fe7a877… | 5d (own 4cdd5169 tree, expected-measurement.sh --pin) |
| 0ddbd824 (0xf7e65a8f…/4) | 2317370df656… | f4fb208aedddf04b… | 63 (installed tree's expected-measurement.sh --pin) |
| 395bed3e, 4e62e60d (0x5356e8bd…/4) | 6de873656f88… | 5f2f238c88e1ae55… | 63 |

- **Mine:** the relay's predictor module (4aab8ff1, byte-identical to nan's), run on warden-host
  (`local-crosscheck.mjs` / `.json`).
- **nan's:** the sandboxed staging check. It ran with the DEPLOYED module in the api-relay's sandbox (`nan-stage.txt`).

## Staging: `../../measurement-prediction/stage/stage-release-keep.sh`
This is stage-release.sh's copy with two changes:
1. **The "before" lines come from BEFORE_LINES.** Here that is /opt/enclave-predict/rel-79c5ecf24eb4/predict-lines.env,
   which equals the live lines (6f816b31). They no longer come from the base staging's predict.env: that file predates
   79c5ecf2, so the new lines built from it would have UNINSTALLED 79c5ecf2, the release the canaries run.
2. **DOMAIN_RELEASES = <kept>,<new>.** The check requires both images: the new one at CROSSCHECK and the kept one at
   CROSSCHECK_KEEP.

The staging lives at /opt/enclave-predict/rel-52156652d67a:
- predict-lines.env daec659e;
- predict-lines.before.env 6f816b31 (= the live lines = rs-4's after).

## The change: two lines of /etc/nan-relay/api-relay.env, then one api-relay restart
| line | before (6f816b31) | after (daec659e) |
|---|---|---|
| `SECRETS_RELEASE_PREDICT_RELEASES` | 5c3561f9, 6f14ce75, a4f22748, 79c5ecf2 | the same four + `52156652…=/opt/enclave-predict/rel-52156652d67a/release` |
| `SECRETS_RELEASE_DOMAIN_RELEASES` | 79c5ecf2 | 79c5ecf2,52156652 |

`rs-5-remote.sh` is rs-4-remote.sh with ONE change. The release has been ON since 4b, so rs-4's "refuse if any release
setting is on" became a digest check instead: every release setting line must be byte-identical after the edit. The
digest was fff018662cc9, the same before and after.

## Scripts
- `rs-5.sh apply|rollback`: run from warden-host with 63's relay-slice lib.sh.
- `rs-5-accept.sh apply|rollback` checks:
  - a new invocation and the KAT;
  - accept.sh for BOTH admitted releases, where the only FAIL is the 403 (release ON);
  - the per-canary installed and admitted sets, plus the measurements above;
  - listed ×3, a69dcbba not listed;
  - MemoryPeak;
  - the canaries on the keys their guests printed at boot;
  - us-west listed;
  - metal-iso0 serving and eligible.
- Rollback: `rs-5.sh rollback`. It is only valid before any guest runs 52156652.

## Next: the retire edit (enclave-87's ruling), before step 6
The retire edit runs after 63's tree switch and after the canaries relaunch on 52156652 with 4e MATCH:
- **DOMAIN_RELEASES = 52156652 only, and 79c5ecf2 dropped from PREDICT_RELEASES.** A 79c5ecf2 guest then gets neither
  secrets nor a certificate.
- **Check the KAT first.** Confirm that no KAT vector sits on 79c5ecf2; if one does, move it before retiring.
- **Acceptance:** expected-guest lists only 52156652, and ADMIT=79c5ecf2 is refused.
- **Step 6** (listing Steven's apps) happens only after that is accepted.
