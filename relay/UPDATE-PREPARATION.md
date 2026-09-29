# Preparing a published app update

Before activating a new catalog version, call
`GET /v1/prepare-guest-update?id=<deployment>&appRef=<encoded catalog reference>`.
The deployment must be public and leased. The reference must name the same
catalog app's current or immediately following version. Normal catalog approval
and derivation checks still apply.

The request warms both the certificate and secret-release prediction sets in
the live relay's cache. A `503 warming` response means computation continues;
retry later. Only a `200` response with `preparationOnly: true`, the intended
`catalogRef`, and the expected release, measurement, runtime and app identities
is suitable for preparing a rollout. Verify `releaseAdmitted` for the intended
release as well. The response is not an attestation or permission to serve.

Preparation does not modify the deployment. `/v1/expected-guest`, certificate
issuance, and secret delivery continue to use its confirmed ledger reference.
An `appRef` query on `/v1/expected-guest` cannot redirect that trust root.
The confirmed GPU allocation and deployment config override are preserved;
without an override, preparation uses the candidate version's stock config.

Install reviewed releases and load their admission pins before preparation.
Restarting the relay discards its prediction cache, so prepare again after any
restart. Activate only after preparation succeeds, then independently verify
the new guest and perform a real application request.

Validation: `node --test test/guest-prediction-row.test.mjs
test/secrets-release.test.mjs test/measurement-predict.test.mjs
test/api-relay.test.mjs` (84 tests).
