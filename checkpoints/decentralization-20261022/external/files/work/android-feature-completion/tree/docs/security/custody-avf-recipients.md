# Custody v2: Android protected VMs as release recipients

Status: source complete and tested off the device (2026-10-21). It is NOT active anywhere:

- no custodian image carries the opt-in;
- no owner has committed AVF rules;
- the measured Android build that carries the client is unsigned.

Activation is governance work, listed at the end.

## What this is, and what it is not

It is the existing, frozen custody v2 ([secret-custody-v2.md](secret-custody-v2.md)) with one more recipient platform, on
the Enclave Shield precedent ([custodian-shield-recipients.md](custodian-shield-recipients.md)).

Unchanged:

- the committee key and the TDH2 bundle with its label proof;
- `releaseBinding`, the DLEQ partials and their HPKE sealing;
- the operator's release signature;
- every agreed-chain check, the platform host policy and the Enclave seat rule;
- the owner startup package: the guest's own ledger quorum verifies the `guestBootstrap` commitment.

New, and only this:

- an owner-committed rules format, `enclave-custody-avf-rules/1` (`custody/v2/avf-rules.mjs`);
- the custodian's step-9 verifier for the AVF evidence (`custody/v2/avf-evidence.mjs`), with Google's revocation list
  (`custody/v2/avf-status.mjs`);
- a measured operator opt-in, `enclave-custody-avf-operator/1` (`custody/v2/avf-operator.mjs`; `--avf-recipients` on
  `scripts/build-custodian-v2.mjs`);
- the guest half (`isolation/m2/pvmcustody`, built as `libpvmcustody.so` into the APK). It composes the unchanged
  `bootstrap` (owner startup) and `custody.Client.ObtainV2` (the release).

`custody/rules.mjs` refused `avf-pvm` for two stated reasons. Both are now addressed:

1. "the AVF verifier checks no attestation revocation list": the custodian now reads Google's attestation status list
   itself on every release and fails closed.
2. "the pVM release client is not in this repository": it is `isolation/m2/pvmcustody`.

`custody/rules.mjs` itself is unchanged, byte for byte, and still refuses `avf-pvm` inside SNP rules. Its refusal message
still gives the two old reasons. It is left as is because it is re-exported into the committed site bundle
(`custody/browser.mjs`, site/vendor/custody.js). AVF rules are a distinct format, like Shield's.

## The flow

| step | where | what |
|---|---|---|
| 1 | pVM | `APPSTARTUP` carries the owner's startup package (public bytes). `bootstrap.Reader.AuthorizeWhenConfirmed` accepts it only if its sha256 is the deployment's `guestBootstrap` commitment, as read by an agreeing RPC quorum (the measured RPCs and roots, TLS in the VM) |
| 2 | pVM | mode `custody-v2`: the owner-committed pointer becomes the v2 state (`release.Custody.V2`, the seat layout) |
| 3 | pVM to custodians | `ObtainV2`: a challenge from every machine; the recipient key is made in the VM process |
| 4 | pVM | the AVF certificate over `SHA-256("enclave-custody-avf-v1\n" ‖ binding ‖ InstanceID) ‖ AppID`, and the instance key's signature over that challenge |
| 5 | pVM to host to pVM | `EGRESS <token> CUSTODYAUTH <vault> <id> <binding>`: the lease holder's operator signs this release. The host agent signs only for its launch's own deployment, only for a reviewed vault, and only for a deployment with a startup package |
| 6 | custodians | steps 1-8 unchanged; then step 9, the AVF verifier (below); one DLEQ-proved partial per held index, HPKE-sealed to the recipient key |
| 7 | pVM | every partial is verified; at most one Enclave machine is used, then independent seats; exactly t are combined; the bundle is opened under its label |
| 8 | pVM | the bundle must commit `sha256(configText)`; the names are checked; `$NAME` is resolved by the platform runner's own rule (`isolation/m2/appconfig.Resolve`); `Revalidate` runs; the payload hands pvm-rt (unchanged) an environment block of the host's variables, ENCLAVE_CONFIG = the resolved owner config, and the values |

The phone carries only ciphertext and public bytes: TLS streams the VM terminated itself, the public package, the public
evidence and the opaque binding. No relay is involved, and no value, key or share reaches the host.

## The custodian's step 9 for an AVF document

1. **Shape.** The document has exactly the fields `abi, appSha256, chain, format, identity, instanceKey, instanceSig,
   runtime, selftest, spki, transportKey`. It states abi/2 and carries no nonce.
2. **App and runtime.** The app is the rules' `appId`. The runtime identity is admissible and canonical, and its W^X
   self-test passes (relay/pvm-evidence-core.mjs).
3. **Transport key.** `transportKey` is the attested Ed25519 key's exact bytes, which the binding commits.
4. **Instance.** The instance key is not the transport key. When the owner set `instances`, the InstanceID is in that
   list.
5. **Chain.** relay/avf-verify.mjs (unchanged) checks:
   - a pinned Google attestation root, every signature, the CA bits, and validity against the custodian's clock;
   - isVmSecure and the challenge above;
   - every APK component is signed by an admitted authority, and one carries an admitted code hash.

   Then that component's (codeHash, authorityHash) must be an admitted PAIR.
6. **Instance signature.** The instance key signed the challenge.
7. **Revocation.** No certificate of the chain may appear on `https://android.googleapis.com/attestation/status`, with
   any status.
   - The list is not signed, so the custodian fetches it over TLS in its own guest and never accepts a carried copy.
   - It refreshes every 6 h. A copy older than the measured maximum (24 h at most) refuses with "revocation unknown".

AVF has no HOST_DATA. The deployment id is inside the binding, stated by the measured payload. That payload serves one
deployment per VM, under the host's PROOFPINS, and the custodian independently requires the endpoint to hold that
deployment's live lease.

## Trust, stated

| trusted | why |
|---|---|
| the device's firmware, pKVM, AVF and Google's remote key provisioning | they make and certify the VM's key. The owner says so in `acceptTier` |
| Google's attestation status list | revocation |
| the APK's signing key | a different key is a different authorityHash: the owner admits pairs, not just hashes |

Excluded: the phone's Android host (pKVM keeps it out of the VM's memory), the host agent, the relay and every network
path.

## Tests (no claim beyond them)

| suite | fixtures | what it shows |
|---|---|---|
| test/custody-v2-avf.test.mjs | REAL Pixel 10 Pro XL chain (test/fixtures/pvm-v4/host-live-20261016.json, the installed build ff559327...) and REAL Google status list fetched 2026-10-21 (test/fixtures/google/attestation-status-20261021.json) | the real chain verifies under Google's pins for its own challenge. Replayed as custody evidence, it passes root, signatures and dates, then is refused at the challenge. Revocation (good, revoked, suspended, unavailable, stale). The rules, CLI and owner-read formats |
| same | SYNTHETIC AVF chain (openssl CA, test root pins; every verdict says synthetic) | full release through REAL custodians (4 machines, the Enclave seat, t=3). Every refusal: format, rules, app, pair, runtime, instance, signature, challenge, nonce, isVmSecure, self-test, canonical identity, operator, revocation, single use |
| test/custody-v2-avf-go.test.mjs + isolation/m2/pvmcustody | SYNTHETIC chain, REAL JS custodians over TLS | the Go guest end to end: honest, Enclave replicas, a lying custodian dropped, the Enclave machine offline, quorum lost, revoked, config mismatch, failed revalidation, wrong instance, a stranger operator |
| isolation/m2/pvmcustody (go test) | the JS challenge vector | byte parity with the JS reference; the VM statement checks; the evidence document |

No real-device custody release can be produced off the device: the AVF certificate is minted inside the pVM for the
challenge it asks for. The device proof is part of activation (below).

## Activation (governance; nothing here was done)

1. **Custodian operators** opt in: build a custodian image with `--transport direct --avf-recipients avf.json` (format,
   acceptTier, limits).
   - This is a new custodian measurement, so it goes through the code permit, and the committee hands over to it.
   - `--transport direct` is required: an Android pVM release reaches the custodian at its own registered endpoint, never
     through the relay tunnel of the DigitalOcean fleet.
2. **Platform** builds and signs the Android APK that carries `libpvmcustody.so`, then publishes its code hash and
   authority hash.
3. **The owner** writes the AVF rules (`enclave --independent custody set <id> --rules avf-rules.json`) and the startup
   package (secretsMode custody-v2, the pointer), and commits `guestBootstrap`. The host gets the package from either of
   two places, both checked against the committed sha256:
   - `files/agent/state/startup/<deployment>.json`;
   - content-addressed (CID) from the gateways of the owner's independent profile.
4. **Device proof** (root): one deployment with a test secret. It passes when the agent log shows CUSTODY
   attested/ready, every custodian logs OK (measurement = the signed APK's code hash, not synthetic), and the app sees
   its value.
