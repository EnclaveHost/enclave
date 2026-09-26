# rs-6, the RETIRE edit: 79c5ecf2 and a4f22748 neither admitted nor installed

This is enclave-87's ruling from 2026-09-26. It runs BEFORE step 6, when Steven's apps are listed.

**When:** after 63's S5 tree switch, once all 3 canaries have been relaunched on 52156652 with 4e MATCH. bf reviews it
first.

**Why:**
- The release (secrets) uses the ADMITTED set, and certificates use every INSTALLED release.
- So a guest on 79c5ecf2 or a4f22748 gets neither secrets nor a certificate afterwards.
- guestd building only the 4cdd5169 tree remains the primary lock on launches.
- 5c3561f9 and 6f14ce75 stay installed, because they carry the KAT vectors (checked in source: KNOWN_ANSWERS). They
  remain certifiable, which is on the backlog: a cert set separate from the KAT set.

**The lines:**

| line | before (= rs-5's after, daec659e) | after |
|---|---|---|
| `SECRETS_RELEASE_PREDICT_RELEASES` | 5c3561f9, 6f14ce75, a4f22748, 79c5ecf2, 52156652 | 5c3561f9, 6f14ce75, 52156652 |
| `SECRETS_RELEASE_DOMAIN_RELEASES` | 79c5ecf2,52156652 | 52156652 |

**Staging:** `../../measurement-prediction/stage/stage-retire.sh` builds DEST=/opt/enclave-predict/retire-79c5ecf2 from
BEFORE_LINES, KEEP and DROP. It then runs the sandboxed check with the DEPLOYED predictor module, which checks that:
- the KAT passes;
- each canary's catalog version predicts exactly ONE release image, on 52156652, at 63's independent value;
- the cert set is exactly the remaining three releases.

A local dry run with the same predictor module (the root sandbox replaced by a direct run) PASSED. The staging command
on nan:

    BEFORE_LINES=/opt/enclave-predict/rel-52156652d67a/predict-lines.env KEEP=52156652… DROP="a4f22748… 79c5ecf2…" \
    CROSSCHECK="catalog://0xf7e65a8f…/4=f4fb208a…;catalog://0x5356e8bd…/4=5f2f238c…" \
    sh stage-retire.sh /opt/enclave-predict/retire-79c5ecf2 /opt/enclave-predict/829c09adb176

**Once staged:**
1. Set NEW_SHA in `rs-6.sh` to the staged predict-lines.env digest.
2. Run `rs-6.sh apply`, which changes the two lines and does one restart. `rs-6-remote.sh` is rs-5-remote.sh with only
   its names changed.
3. Run `rs-6-accept.sh apply`. It checks:
   - a new invocation, and the KAT;
   - ADMIT=52156652 gives the release-ON shape;
   - ADMIT=79c5ecf2 and ADMIT=a4f22748 are REFUSED for every canary;
   - installed is {5c3561f9, 6f14ce75, 52156652} and admitted is {52156652}, at 63's values;
   - listed ×3; MemoryPeak; the canaries on their boot keys; us-west; metal-iso0.

**Rollback:** `rs-6.sh rollback` restores rs-5's lines. Putting a4f22748 back matters only for a tree switch to 17e182a8,
which has been superseded.

**Note:** each canary's first release after rs-6 warms cold, just as after rs-5: one "no prediction (ticket kept)" line,
then "released".
