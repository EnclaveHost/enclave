# Milestone 4 on the Pixel 10: a first-party wasi:http app served inside the pVM, unchanged (2026-09-23 21:11)

Build rt4 (sha256 `586d32ee…`). `cpu/app-http-run.sh`: enclave-apps' **ggml-probe** (`runtime/conformance/bundles/ggml-probe.wasm`,
sha256 `1ad17b45…`, the bytes built from enclave-apps, not rebuilt) with `APP ... graph=gemma-4-e2b-it-q4_0 serve=http`:
verified, compiled to Pulley once (181 ms) and pre-instantiated; the payload accepted each connection on vsock 7786 and
pvm-rt served HTTP/1.1 on it, a fresh instance per request. The app's `--es app_http` hook sent five GETs, each on its own
connection, then STOP. `check-app-http.py results/app-m4` -> **PASS** (check.txt):

| # | request | answer |
|---|---|---|
| 1 | `/ping` | 200 `{"ok":true}` |
| 2 | `/?graph=gemma-4-e2b-it-q4_0&steps=16` | 200, n_vocab 262144, 16 greedy tokens through wasi:nn |
| 3 | the same | 200, the identical 16 tokens (a fresh instance and a cleared sequence per request) |
| 4 | `/nope` | the app's own 404 |
| 5 | `/?graph=other-model&steps=2` | the app's 500: `load_by_name("other-model"): NotFound` |

Then `APP http: stopped by the owner`, `APP served 1ad17b45… requests=5`. App-path decode 11.99 tok/s (16 steps; prefill
148 ms for 9 tokens), wall 1.4-1.6 s per request including the connection.
