# Bootstrap upload CORS repair

The regional `ipfs.enclave.host` gateway added `Access-Control-Allow-Origin: *`
to signed upload responses that already carried the upload application's
`Access-Control-Allow-Origin: https://enclave.host`. Browsers reject that pair,
including on OPTIONS preflights, and the publisher reported a network error
after wallet authorization.

`fix-bootstrap-upload-cors.py` limits the gateway wildcard to `/ipfs/*` public
reads, using a deferred replacement to ensure a single header. Upload routes
retain the application's origin allowlist and signature checks. Upstreams,
authentication, CSP, and the provider configuration are preserved.

## Applying the repair

Inspect `/etc/enclave-bootstrap-tls/Caddyfile` and record its SHA256 first.
Run the script as root with `--expected-sha256 HASH` to validate the candidate
using the running Caddy executable. Add `--apply` only after reviewing the
candidate. The tool refuses an unexpected or ambiguous header policy.

Application saves a root-only timestamped backup, atomically replaces the
Caddyfile, and reloads `enclave-bootstrap-tls`. It verifies that the process ID,
start timestamp, and restart count remain unchanged. A reported reload failure
restores and reloads the original file unless concurrent configuration drift
prevents safe restoration. A timeout or post-reload identity mismatch requires
inspection before retrying. The script does not restart providers, apps, or VMs.

For manual rollback, confirm the current file still matches the recorded
after-hash, validate the recorded backup with the running Caddy binary, then
restore the backup with the original ownership/mode and reload the same unit.
Do not overwrite subsequent unrelated configuration changes.

## Verification on 2026-10-25

Applied to eu-central, ca-east, ap-southeast, and us-west. Each service retained
its original PID and start time with zero restarts. All four endpoints returned:

- OPTIONS for `/add-wasm`, `/add-json`, and `/add-image`: HTTP 204 and exactly
  one origin header, `https://enclave.host`.
- GET of an existing public IPFS block: HTTP 200 and exactly one wildcard
  origin header.
- POST of a minimal Wasm header without authorization: HTTP 401 and the
  existing signed-upload-required error, with exactly one allowed origin.

An initial empty-body negative probe returned HTTP 411, which demonstrates
length validation rather than authorization; the nonempty probe above verifies
the authorization boundary. Neither negative probe uploaded a valid artifact.

Three local tests cover the targeted rewrite, idempotence, preservation of the
HTTP redirect and unrelated sites, and refusal of unexpected/duplicate policies:

```sh
python3 scripts/test-bootstrap-upload-cors.py
```

The browser's successful signed upload and returned artifact hash must be
verified separately. These gateway checks alone do not establish publication
or deployment of the native desktop.
