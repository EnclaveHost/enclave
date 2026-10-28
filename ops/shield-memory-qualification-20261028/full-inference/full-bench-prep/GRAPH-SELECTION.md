# Full-bench graph selection (source only)

Status: source change to `fullbench.py`, `test_fullbench.py` and `workload.json` only. Nothing was run, built,
booted or tested by the author; root runs the tests. The measured probe (`probe-bench`), the installed release,
dominit, runtime, client and every resource/security/attestation gate are unchanged.

## Problem

`full-smoke-fw-r2` attested (fresh VERDICT, runtime=1, seccomp, TCB, replay), then every request got app 500
`load_by_name ... NotFound`. The harness never sent `graph=`, so the probe asked for its default `"model"`, and the
old `run_arm` labelled any `load_by_name` error `model_declined` (a capacity outcome that lets `execute` continue).

## Source evidence

| What | Where |
|---|---|
| Installed profile accepts only `qwen3.8-27b-mtp-q4-vl-gguf` (large) or `qwen2.5-0.5b-q8-gguf`, read with `%63s` from `/app.shield` | `/home/steven/enclave-prod/iso-sdshield-1c3cdbb8/isolation/m2/dominit.c:275-285` |
| Preload arg `nn-graph=ggml::/models/%s` with that model | same file `:288` (and `ENCLAVE_NN_PRELOADS=%s` `:290`) |
| App argv gets `-S <shield_graph>` and `--dir /models::/models` | same file `:720-721` |
| Patched runtime preloads each `(kind, path)` via `registry.load(backend, Path::new(path))`; a failed preload is **skipped**, so `load_by_name` of it errors | `../source/wasm/wasmtime-nn-ggml.patch:4394-4411` |
| Registry name = preload dir basename | `../source/wasm/Dockerfile.wasmtime:223` ("preloads a model under the dir basename"), `../source/wasm/wasm_manager.py:1447-1451` |
| Old canary preloaded `nn-graph=ggml::/models/model`, the origin of the probe default `"model"` | `../source/isolation/m4/build-shielded-inference-canary.py:70` |
| Probe: `?graph=<name>`, else env `PROBE_GRAPH`, else `"model"` | `probe-bench/src/lib.rs:5`, `:207-209` |
| Probe query parsing does **no** percent-decoding (`strip_prefix("key=")`, first match wins) | `probe-bench/src/lib.rs:198-202` |
| Probe 500 body is `{"error": <Debug of "load_by_name: {code:?}: {data}">}` | `probe-bench/src/lib.rs:96-97`, `:227-231` |

Hence the registry graph is the basename of `/models/qwen3.8-27b-mtp-q4-vl-gguf`: **`qwen3.8-27b-mtp-q4-vl-gguf`**.

## Changes

`fullbench.py`
- `SHIELD_GRAPH = "qwen3.8-27b-mtp-q4-vl-gguf"`. `GRAPH_NAME = [a-z0-9][a-z0-9._-]{0,62}` (fullmatch: ≤63, the `%63s` bound).
- `probe_path`: the `graph` key only must be a `str` matching `GRAPH_NAME`, and `quote_plus(v) == v`, so the probe
  receives exactly the bytes we validated. Every other key keeps the old behaviour (int, or `<n>+i` expanded per request);
  `urlencode(sorted(...))` is unchanged.
- `graph_problems(w)`: every step must carry `graph == SHIELD_GRAPH`. Enforced in `check_workload` (`load_workload`
  and now also the copy `make_plan` embeds in the plan) and in `preflight`, so plan, dry run and every live arm refuse
  a workload (or an old approved plan) without it.
- `classify_failure` replaces the old one-liner in `run_arm`. Only `load_by_name:` errors in bodies of
  **attested, pinned** responses count. Outcomes:
  - `model_declined`: such an error **and** a whole serial line `^DOM Shield model declined\b`;
  - `graph_not_found`: every such error is NotFound (`NotFound` or `"not-found"`) and no decline line. Configuration failure, and `execute` stops;
  - `model_load_failed`: another `load_by_name` error without a decline line;
  - `request_failed`: everything else (rejects, compute errors, a decline line with no load error).
  The receipt records `failure_evidence` (`graph`, up to 4 truncated errors, `serial_declined`). `h["serial_declined"]`
  uses the same whole-line match instead of a substring anywhere in the log.
- No retry was added; client argv and its checks are untouched.

`workload.json`: every step's query now has `"graph": "qwen3.8-27b-mtp-q4-vl-gguf"`. The numeric values are unchanged.

`test_fullbench.py`: the fixture workload names the graph. New tests: graph format/injection refusals, numeric
`+i` refusals, the explicit graph that the production workload requires (missing, `"model"`, small model), the
whole-line decline match, client argv end to end through `run_arm` (`--path /?graph=…&steps=8`, argv equal to
`client_argv`), NotFound → `graph_not_found` (both Debug forms, one client, clean), and `model_declined` only with
the decline line plus an attested load error.

## Limitations

- I read the registry naming in comments (`Dockerfile.wasmtime`, `wasm_manager.py`) and in the m4 canary's
  `/models/model` ↔ `"model"` pairing. I did not read the body of upstream `in_memory.rs::load`, because the patch
  does not modify it. These sources are in `../source`, not the installed iso tree. Root should confirm them against
  the installed runtime's source before running.
- The exact `ErrorCode` Debug text is not verified. Both the `NotFound` and the wit-bindgen `name: "not-found"` forms are accepted.
- I did not find the emitter of `DOM Shield model declined` in `iso-sdshield-1c3cdbb8`. The pattern comes from FULL.md.
  If the guest never prints it, a real decline is labelled `graph_not_found` or `model_load_failed`. That fails closed: `execute` stops instead of continuing.
- NotFound without the decline line is either a wrong name or a preload the runtime skipped (patch `:4403-4410`
  logs that to stderr). Once the name is pinned, it points at the preload. The serial is untrusted and is used for labelling only.
- The serial is untrusted and only labels a failure. It never makes an arm succeed.
