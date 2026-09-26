# The relay window after the canaries move to f7888d86

This is enclave-87's order from 2026-09-26. It happens after 63 accepts canary 3 (4e62e60d) on f7888d86.

**Rules for every step:**
- At most one api-relay restart per 10 min, because of the NucBox soak.
- Hold if any of Steven's apps is in its first launch (63's watcher).
- Run health after every step.
- Stop at the first unhealthy step and roll back that step only.

| step | script | restart | acceptance | rollback |
|---|---|---|---|---|
| 1 | `../attested-release-integration/retire-52156652/rs-8.sh apply` (the retire of 52156652) | 1 | `rs-8-accept.sh apply` | `rs-8.sh rollback` |
| 2 | `pc-2-push.sh` (pre-warm + cert-set-separate, one push, one relay deploy) | 1 (≥10 min after 1) | `pc-2-accept.sh` | revert the 4 on main |
| 3 | `cs-3-env.sh on` (SECRETS_RELEASE_CERT_RELEASES = the admitted f7888d86) | 1 (≥10 min after 2) | `cs-3-accept.sh on`, which rolls back by itself if it fails | `cs-3-env.sh off` |

**Rollback order.** Step 3's line goes first, before any rs-8 rollback. If rs-8 were rolled back with the line still set,
52156652 would be admitted but outside the certificate set, which is a predictor problem.

## Step 1 (rs-8)
- **Guard (`leased-attest.mjs`):** every release-listed deployment that holds a live lease (read from the ledger; the 3
  canaries at least) must be chip-verified on f7888d86 at its pin, from each guest's own AMD-signed report. It is rs-6's
  guard, retargeted.
- **Lines, staged on nan at 04:03Z (sandboxed check PASS):** installed {5c3561f9, 6f14ce75, f7888d86}, admitted {f7888d86}.

## Step 2 (`pc-2-push.sh`)
**What it pushes:** the 4 reviewed commits, re-cut onto main 335b0d8e:
- 73662f6b and dc3a3ede (bf GO);
- f0759181 and 6e301b16 (5d GO).

**Pinned by PATCH:** each commit's `git patch-id --stable` must equal the reviewed one (PATCHIDS in lib.sh). On top of that:
- the file list must be exact, and the 3 relay files' contents must be pinned;
- no symlink and no node_modules path;
- the context guard: main may not have changed relay/, site/ or scripts/ since 335b0d8e;
- the api relay must not have restarted in the last 10 min;
- health must pass first.

`DRY=1` runs every check and pushes nothing. `pc-recut.sh` re-cuts onto a moved main, keeping the same patch-ids.

**Tested on the re-cut:** release-prewarm 3/3, measurement-predict 25/25, secrets-release 22/22, relay-hvnode-owner-only 9/9,
relay-deploy-closure 1/1.

**Acceptance:**
- a new invocation;
- nan runs the pushed files;
- the KAT PASSes and the pre-warm round runs for the 7 listed;
- health passes.

Until step 3, the cert-set code is inert.

## Step 3 (`cs-3-env.sh` / `cs-3-remote.sh`)
**How the value is set:** it is never typed. `cs-3-remote.sh` reads it on nan from `SECRETS_RELEASE_DOMAIN_RELEASES`, which
must be exactly one 64-hex id, equal to f7888d86, and installed. The pattern is env-line-remote.sh's (bf-reviewed):
- the 3 pushed files are pinned;
- the TRUSTED_OPERATORS digest and the release-settings digest must stay unchanged;
- one restart, then 30 s staying up, else an instant rollback.

**Probed on nan before the push:** the script REFUSED at the pin check before any write.

**Acceptance (`cs-3-accept.sh`):**
- the KAT at start PASSes in the new invocation. It only runs when there is no predictor problem, so its absence means a
  problem;
- `health.sh` with `CERT_SEPARATE=1`: every canary's expected guest lists ONLY f7888d86, admitted, at its pin. There is no
  5c3561f9/6f14ce75 image, so a KAT-only guest gets no certificate (bf's negative);
- release ON; 404 and 422.

**On failure:** it runs `cs-3-env.sh off` at once.

## health.sh (`../hvnode-owner-only-rollout/`)
- It now covers the 7 listed ids (7ae476a3 included).
- ADMIT defaults to f7888d86, which is admitted both before and after rs-8.
- `CERT_SEPARATE=1` switches it to the post-step-3 shape.
