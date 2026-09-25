# Relay integration of the measurement predictor (nan): for review

Status 2026-09-25: STAGED and tested on nan; NOT wired. The release stays OFF through every step here. Live activation waits
for the coordinated U7 / us-west gate and the canary gate (GUEST-POOL-ROLLOUT §9 rows 2-3); this is the exact change set for
review.

## What is staged on nan (done)

`/opt/enclave-predict/829c09adb176/` (708 MB, root-owned, read-only to the relay), by `stage-remote.sh` at 829c09ad
(`../measurement-prediction/stage/`): the public repo at 829c09ad with the toolchain commit 0181bce3's blobs materialised
(promisor off); Go 1.24.7 (go.dev sha256); a venv with sev-snp-measure 0.0.13 and pinned dependencies, hash-locked against
PyPI, binary-only; three domain releases each verified against its id: 5c3561f9 (0181bce3) and 6f14ce75 (6757d139), the
live canaries' images and the known answers, and a4f22748 (image 17e182a8), the production candidate; the known answers'
components (CID-verified on read). `2cce09274d4a/` (the earlier staging) is kept for rollback.

Check on nan (`nan-restage-2026-09-25.txt`), run through the relay's own construction (`predictorEnv`, two agreeing RPCs) in
a TRANSIENT unit with the api-relay's sandbox (DynamicUser, ProtectSystem=strict, ProtectHome, PrivateTmp, NoNewPrivileges,
MemoryMax=768M, TasksMax=512): known answers 2/2 (20.8 s); api-mcp-adapter under a4f22748 = `38b90458…2a93`, equal to
enclave-5d's `expected-measurement.sh --pin` value (13.4 s). The relay was not touched (PID, start time, restarts unchanged).

Acceptance dry run (`accept-dryrun.txt`): through the real `expectedGuest` handler over these three releases, each of the
three live canaries' chip-attested (measurement, AppID) is one predicted image.

## The change set

1. **Relay code**, `origin/main` (= nan's deployed relay/, byte-compared file by file) to `security/attested-release` at
   **fc90d6b5** or later (enclave-d1 approved 0aa2c36f + fc90d6b5; `git diff --stat origin/main fc90d6b5 -- relay/
   verifier/consumer.mjs` is exactly the entries below; every file of api-relay.js's import closure is on deploy.sh's list):
   - the U7 part (ba565c57..18772bf7): api-relay.js, certs.js, dns-relay.js, fleet.mjs, relay.js, secrets.js,
     tcp6-relay.js, udp-relay.js. This IS the U7 rollout and carries its own preflight and gate.
   - the attested-release part (18772bf7..HEAD): api-relay.js, secrets.js, secrets-release.mjs (new),
     measurement-predict.mjs (new), snp-verify.mjs, tunnel.js, vendor/enclave-verifier-node.mjs (+ MANIFEST), deploy.sh
     (copies the two new modules), verifier/consumer.mjs (the vendored bundle's source).
   With the release OFF this adds: `GET /v1/expected-guest` (public, leased public deployments only), the predictor's
   known-answer test at start, the release endpoints answering `503 release_unconfigured`, and `provenSnpChip` on SNP
   tunnel attaches (the hub records a VCEK-proven CHIP_ID; nothing reads it while the release is off).
2. **Environment**: `predict.env` here, appended to `/etc/nan-relay/api-relay.env` (public values; the file stays 0600).
3. **Unit**: `predict.conf` here as `/etc/systemd/system/enclave-api-relay.service.d/predict.conf` (`MemoryMax=1536M`):
   a cold prediction peaks ~504 MiB (`memory.txt`) on top of the relay's ~194 MB, against today's 768M.

## Activation, in order (each step's check; any failure = the rollback below)

1. U7 rolled out per its own preflight (its gate). 2. Deploy the relay code (`relay/deploy.sh` from the reviewed commit);
check the api relay is active with 0 restarts and `/v1/enclaves` 200. 3. Append `predict.env` (backup first, 0600, the
same one-line-guard pattern as S2a), install `predict.conf`, `daemon-reload`, restart the api-relay. 4. Checks: the journal
shows `[measurement-predict] known-answer test at start: PASS: 2 known answer(s) reproduced exactly`; `accept.sh` passes
(each canary's measurement predicted, release-ticket 503, 404/422 answers); `MemoryPeak` stays under 1536M; the relay
serves as before.

## Order against the supervisor side

The supervisor's per-app certificate gate with enclave-d1's consumer (`d1/guestcert-expected`, which asks
`/v1/expected-guest` before relaying a guest's CSR) ships AFTER this relay step: until the relay answers with a
prediction, that gate refuses (503 there is "unknown", never a pass). So: U7, then this relay code + predictor env, then
the supervisor release carrying the 4c pool accounting and the consumer. The release itself (S5 / 4b) comes after both.

**Option (Codex decides): the relay step WITHOUT U7.** `relay/expected-guest-slice` @ aeb345e6 (pushed, not merged) is
this branch's own part (18772bf7..fc90d6b5) on `origin/main` with no U7 file. It serves the predictor and
`/v1/expected-guest`; its attested release cannot be switched on (no U7 eligibility provider: `503 release_unconfigured`
whatever the env). Tests 77/77 targeted, 218/218 across the 21 test files touching api-relay.js / secrets.js / tunnel.js;
enclave-5d confirmed its answers match the 4c consumer's contract. With it: slice + `predict.env` + `predict.conf`, then the
4c supervisor, with U7 later on its own gate; the env, drop-in, acceptance and rollback here are unchanged.

A brand-new claim may see `409 not_leased` from `/v1/expected-guest` for the moment between the claim transaction and the
agreeing RPCs seeing it; the consumer treats it as one failure (its 5 min backoff), nothing wedges (enclave-5d).

## Rollback

Remove the appended lines (restore the backup line-wise, never the whole file), remove `predict.conf`, `daemon-reload`,
restart: the relay runs without the predictor (the release endpoints answer 503 as now; `/v1/expected-guest` answers 503).
Code rollback is U7's (redeploy main's relay/). The staged directories are inert and stay; `/var/lib/enclave-relay/predict`
(the work dir: toolchain extract, Go cache, components) can be deleted.

## Not in this step (the release-ON step, S5 / 4b, its own review)

`SECRETS_ATTESTED_RELEASE=1`, `SECRETS_RELEASE_DEPLOYMENTS` (canaries only), `SECRETS_RELEASE_SIGNING_KEY_FILE=
/etc/nan-relay/secrets-release-signing.seed` (S3b, owned by enclave-api-relay), `SECRETS_RELEASE_MIN_TCB`,
`SECRETS_RELEASE_VMPL=0`; `METAL_REQUIRE_VCEK` on the lease holder; the production image a4f22748 (pending enclave-d1's
review) installed and guestd switched (4d).
