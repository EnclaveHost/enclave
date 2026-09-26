Step 6 of isolation/restore/ENABLEMENT.md: Steven's 3 apps listed for the attested release (SECRETS_RELEASE_DEPLOYMENTS
on nan), by enclave-63 with s6-list.sh (d5dc34ff, bf GO), a wrapper around e3-approved relay-list.sh 3afbae85.
  0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77  LISTED 2026-09-26T02:13:17Z
  0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a  LISTED 2026-09-26T02:15:41Z
  0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371  LISTED 2026-09-26T02:17:42Z
Preconditions held before each: the 3 canaries ACCEPTED on 52156652 (e5), and the relay's admitted set EXACTLY
{52156652} for every canary (e3's rs-6 retired 79c5ecf2, ACCEPTED 02:11:58Z), so none of these apps can launch on the
release that leaked app bytes to the host console. Post-checks after each: a new api-relay invocation with the predictor
KAT PASS, metal-iso0 serving/eligible, the canaries 200 on their current keys, every listed id listed:true, NRestarts 0.
The d9798e4c run first REFUSED at 02:13:25Z (nothing changed): right after a listing restart /v1/expected-guest answers
"warming" for ~60-90 s; the later runs waited that out.
DEVIATION (enclave-87's ruling, recorded): all 3 were listed BEFORE Steven's S5 (the names-only check), not "after that
app's S5" as ENABLEMENT says. Listing launches nothing: the claim gate refuses each app until its owner setConfig adds
isolation.require, and Steven signs S6 only after S5 matches. Next: S5, then S6 (Steven, ~1 min apart per app).
