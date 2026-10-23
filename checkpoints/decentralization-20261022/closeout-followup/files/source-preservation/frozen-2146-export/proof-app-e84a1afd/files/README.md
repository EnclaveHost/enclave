# custody-canary-proof: the hash-only canary app (source + offline build; NOT published, admitted or deployed)

Root task ROOT-CANARY-APP (2026-10-23): implement and build the app from
`work/custody-v2-production-canary-20261023/CANARY-APP-PLAN.md`. It targets the actual production per-app wasi:http 0.2
runtime (release-16c2999d), not current main's p3. Nothing live was done: no hardware, production, chain, key, upload,
catalog publish or signature. The original hello-world and all catalog deployments are untouched; enclave-apps is not
modified.

## 1. First: do custody values reach the component's environment on release-16c2999d? YES, as their own variables

- **Release:** `~/enclave-prod/release-16c2999d`. The release id is sha256(release.json) = `16c2999d7715a38f8a29adcff03d9c3c0e071eb1c0afc207c1f335b654dca0aa`.
  - front `082313e0…`, init `a8bd7e1a…`, wasmtime `9caac5e6…` (49.0.0, `"cache":"none"`).
- **Source lineage:** `/home/steven/Projects/enclave` branch `custody/front-prod`, commit 837c0061d ("each staged secret
  reaches the app as its own environment variable"). No later commit on that branch touches `isolation/m2/dominit.c`,
  `front/` or `appconfig/`.
  - The release init carries that commit's literals: `secret_args`, `wipe_secrets`, `sent a secret name twice`, `sent
    more than 64 secrets`, `sent secrets over the 20 KiB ceiling`, `DOM app secrets: %d as environment variables`, and
    `ENCLAVE_EGRESS`.
  - The release front carries `secretEnv`'s literals (`at most 64 reach the app`, `at most 20480 reach the app`, `a
    secret's value holds a newline or NUL: refused`) and the custody path's (`the release names a custody state AND
    carries relay-held secrets: refused`).
  - This is string-level correspondence. Neither binary is VCS-stamped, and I did not rebuild them.
- **The path:**
  1. `front/provision.go` takes the custody secrets (`custodySecrets`) as the release's secrets.
  2. It sends init `"\0S"` followed by `NAME=VALUE\0`, sorted.
  3. init gives the runtime each secret as ONE argument, `--env NAME=VALUE`, after `--env ENCLAVE_CONFIG`.
  4. The component sees exactly those names, plus `HOME=/tmp`, `PATH=/rt` and (when there is a config) `ENCLAVE_CONFIG`.
- **Rules both ends enforce:** names match `[A-Za-z_][A-Za-z0-9_]{0,63}` and may not start with `ENCLAVE_`; values contain
  no CR, LF or NUL; at most 64 secrets and 20 KiB. Any violation refuses the whole hand-over, so the app does not start.
- **Correction to my own first pass:** I read `work/enclave` (e762a9c5) first. That tree predates the change: its init
  passes only `--env ENCLAVE_CONFIG`, and its front only substitutes `$NAME` in config strings. A design built on that
  tree would have been wrong for the release. The release binaries decided it.
- **Remaining blockers:** none on the app side for this question. Value delivery to the app still depends on the custody
  release reaching the front; see §5.

## 2. The app (src/proof.rs, src/lib.rs, about 130 lines of logic)

- **Request:** exactly `GET /canary/proof?c=<64 lowercase hex>`.
- **200 response:** `{"v":1,"names":[sorted],"proofs":{"NAME":"<64 hex>"}}`, `content-type: application/json`, `cache-control:
  no-store`.
  - `proof = HMAC-SHA256(key = UTF-8 marker, msg = "enclave-custody-canary-proof-v1\n" ‖ NAME ‖ "\n" ‖ c)`, where `c` is
    the 64 ASCII hex characters.
- **Errors (all with empty bodies):** 400 for a malformed `c`; 404 for any other path or method (a query must be exactly
  `c=`); 409 when there is no usable marker.
- **Environment reads:**
  - It keeps only names matching `^CANARY_[A-Z0-9_]{1,40}$`. Every other entry is dropped by name and its value never
    inspected; wasi:cli `get-environment` returns the list in one call.
  - ENCLAVE_CONFIG is never a source.
- **Markers:** a value is hashed only if it has the canary driver's dedicated marker form
  `CANARY_<YYYYMMDDTHHMMSSZ>_<[a-z0-9-]{1,32}>_<64 lowercase hex>` (32 random bytes; driver/markers.mjs
  `createMarkerSet`). Any other value under a CANARY_ name is skipped and not listed, so the app is never a guessing
  oracle for a low-entropy value.
  - More than 8 CANARY_ names, or a duplicate name, refuses everything with 409.
- **What it never does:** log, echo, return a value, length or prefix, read a request body, open an outbound network
  connection, or keep state.
- **Component interface** (`wasm-tools component wit`):
  - exports `wasi:http/incoming-handler@0.2.4`;
  - imports only `wasi:http/types`, `wasi:cli/{environment,exit,stdin,stdout,stderr,terminal-*}`, `wasi:io/*` and
    `wasi:clocks/monotonic-clock` (@0.2.12);
  - no `outgoing-handler`, sockets, filesystem or random.
  - stdout and stderr are imported by std's runtime; the app never writes them.

## 3. Build (pinned, offline, reproducible)

- **Toolchain:** the cached one, rustc 1.99.0-nightly `84b36a78a28a63f134171c670be1932ffa2485f8` (2026-08-06), target
  `wasm32-wasip2`. Nothing was installed.
- **Dependencies:** pinned with `=` in Cargo.toml, `--locked --offline`.
  - The wasi chain is identical to hello-world's p2 lock (enclave-apps fd15327): wasi `0.14.7+wasi-0.2.4`, wasip2
    `1.0.1+wasi-0.2.4`, wit-bindgen `0.46.0`, bitflags `2.13.0`, with the same checksums.
  - Plus hmac `0.12.1` and sha2 `0.10.9`.
  - Cargo.lock sha256 `aac60857…`.
- **Paths:** `.cargo/config.toml` remaps the registry, rust-src and checkout paths. The component contains no `/home/`
  path. To build from a different checkout path, change the last remap to match.

```
cargo build --offline --locked --release --target wasm32-wasip2      # via the queue at 1024
```

| | |
|---|---|
| component sha256 | `7ce32918490b91b87c7ffa4cf69769c676b5b835ca11d55904b1511ef93ee883` |
| size | 101222 bytes |
| CIDv1 (raw, sha2-256) | `bafkreid44murqsilsg4hy772jt3jo2ogo223qnokchkvsbfrkeppspxiqm` |

- **Reproduced 3×:** separate target directories `wasm-a`, `wasm-b` and `wasm-c` (the last after a Cargo.toml
  description-only edit) gave the same sha.
- **CID:**
  - `ipfs add --only-hash -Q --cid-version=1` (kubo 0.42.0, offline) gives that CID, and an independent computation
    (0x01 0x55 0x12 0x20 ‖ sha256, base32) agrees.
  - The publish gateway runs `kubo /api/v0/add?cid-version=1` with defaults (P/scripts/ipfs-add-gateway.py:419).
  - The component is under 256 KiB, so it is one raw block and its CID digest is its sha256.
  - Whether the gateway node's `Import.*` config overrides the defaults was not checked. Compare after upload.
- **Artifact:** the binary is kept UNTRACKED at `out/custody_canary_proof.wasm` (gitignored); ARTIFACT.json records it.

## 4. Tests (all through the unchanged work/claude-test-queue.py)

| check | lane | result |
|---|---|---|
| host unit tests (`cargo test`) | 512 | 6/6 pass |
| mutants (`test/mutants.sh`, scratch copy) | 512 | 9/9 killed |
| release runtime HTTP smoke (`test/smoke.py`) | 512 | 23/23 pass, peak 69 MiB |
| 3 wasm builds | 1024 | peak ≤ 347 MiB |

- **Unit tests:**
  - known-answer vectors computed independently by `test/kat.py` (python hmac);
  - names and proofs only, with an exact-shape check;
  - route and challenge refusals;
  - the marker-format and name-pattern negatives (including bare 64-hex, an unresolved `${…}` and a config-only
    marker);
  - the 8-name ceiling, duplicates, and binding of name, challenge and marker.
- **Mutants**, each of which must fail the tests:
  - any value hashed;
  - bare hex accepted;
  - nine names;
  - duplicates;
  - name not bound;
  - no domain tag;
  - lowercase names;
  - POST answered;
  - uppercase challenge.
- **Smoke:** the actual release wasmtime (sha checked) with init's argv and environment form: `serve -S cli -W
  threads,shared-everything-threads,component-model-threading,shared-memory,memory64,component-model-memory64 -C cache=n
  --addr 127.0.0.1:<port> [--env ENCLAVE_CONFIG] --env NAME=VALUE… app.wasm`, `HOME=/tmp PATH=/rt`.
  - It uses SYNTHETIC markers only: the KAT fixtures plus fresh random ones.
  - Checked:
    - exact independent proofs for the KAT challenge and a fresh one;
    - headers;
    - no secret or config value in any body or in the runtime's output;
    - 400×4 and 404×6;
    - 409 for no secrets, for non-canary or low-entropy secrets only, for a marker only in ENCLAVE_CONFIG, and for nine
      CANARY_ names.
- **Not tested here:**
  - the front→init hand-over itself; 837c0061d carries its own tests (TestSecretEnvRules, TestHandToInitAppendsSecrets,
    test-dominit-handoff.sh), and I did not re-run them;
  - a real guest, an attested client fetch, or a custody release. No hardware evidence is claimed.

## 5. Publish / admission / signing prerequisites (for root; NONE done)

1. **Review:** root reviews this source and the value-proof contract (§2).
2. **Upload:** `enclave publish out/custody_canary_proof.wasm --slug custody-canary-proof --name "Custody canary proof"
   --version 0.1.0 --desc "Custody canary use ONLY: answers HMAC proofs for high-entropy CANARY_ test markers. Never
   stage real secrets." --mem <MB> --cpu-gflops <N>` (P/cli/enclave.mjs:2215).
   - Signing: the publisher wallet signs `enclave-upload:<sha256>:<expiry>` for the upload token, then sends
     `EnclaveAppCatalog.publishVersion`.
   - The appId is `keccak256(publisher ‖ slug)`.
   - No `--config` (the app reads none).
   - The CLI stamps `wasi:"0.2"`.
   - After upload, check the CID equals `bafkreid44murq…` and the sha256 equals `7ce32918…`.
3. **Approval:** if the publisher is not the catalog owner, the admin calls `setApproval(appId, idx, 1)` (Sol:557).
   Runners refuse unapproved versions.
4. **Measurement:**
   - Build the bundle with `bundle build -label <label> -world wasi:http -kind wasm-component -cpu <C> -mem <M> -vcpus <V>
     out/custody_canary_proof.wasm app.bundle`, then `bundle id app.bundle` (P/isolation/contract/cmd/bundle).
   - Then run `P/isolation/m4/expected-measurement.sh --pin 16c2999d7715a38f8a29adcff03d9c3c0e071eb1c0afc207c1f335b654dca0aa
     ~/enclave-prod/release-16c2999d app.bundle <V>`.
   - This gives a NEW app_id and measurement, because app.wasm is in the measured initrd. The resource values must be
     the ones the runner will use.
5. **Canary rules:** pin this app's catalog ref, app_id and measurement instead of hello-world's, then root re-reviews.
   The driver change (fetch with a fresh challenge via `isolation/m2/client.mjs` TRUSTED, recompute from the private
   marker file, record names and booleans only) is the separately reviewed step in CANARY-APP-PLAN.md.
6. **Deployment:**
   - A canary owner deploys the approved version with NO real secrets. Staged secrets are the driver's markers only,
     under the canary's CANARY_ names, at most 8.
   - On the per-app tier the relay must list the deployment or app ref for attested release (`SECRETS_ATTESTED_RELEASE`,
     `SECRETS_RELEASE_DEPLOYMENTS`/`SECRETS_RELEASE_APP_REFS`, work/enclave relay/secrets-release.mjs:174-198). This
     is relay config, set by root.
   - The custody-v2 recipient blocker still applies (metal0's running gsup has no measured CUSTODY_VAULT_V2; see
     work/custody-recipient-restore-20261023).

## Files

`src/proof.rs` (logic + unit tests), `src/lib.rs` (wasi:http glue), `Cargo.toml`/`Cargo.lock`/`.cargo/config.toml` (pins),
`test/kat.py`, `test/smoke.py`, `test/mutants.sh`, `qrun.sh` (one queue job, retried only on 98), `ARTIFACT.json`,
`PROGRESS.txt`. Untracked: `out/` (the binary), `logs/`, `target/`.
