# Benchmark-only client timeout and client/forwarder stderr capture

**Status: source only.** Nothing was run, built, booted or derived. **The tests have not been run.** The derived client
**has not been generated**; root runs the derivation after review. The original `client.mjs`, production, images,
probe and firmware are unchanged.

## Why

- `PGI/isolation/m2/client.mjs:131-147` `request()` sets `r.setTimeout(60000, ...)` on **every** request.
  - That includes the application GET (`app` defaults to `true`).
  - It is a socket **idle** timeout. For a GET whose response only starts after preload, prefill and decode, idle time equals the whole wait.
- When it fires, the request is destroyed with `Error('timeout')`. That error is not a `PinMismatch`, so `:279` rethrows it.
  - Node then exits 1 with the stack on stderr. No `app_status` or `app_body` line is printed.
- fullbench's `per_request_timeout_s` 900 is the harness's own kill deadline. It cannot lengthen a timer inside the client.
- **full-smoke-fw-r3 arm A is consistent with this, but it is not proven.** That arm saw:
  - `VERDICT attested`;
  - the correct graph query;
  - client exit 1 at 60.35 s, with no HTTP response.

  That run sent client stderr to `/dev/null`, so the cause cannot be read from it. No retrospective claim is made. The stderr capture below exists so that the next first failure records its own reason.

## Change 1: derived benchmark client (`derive_client.py`)

**Input.** The derivation reads the input from:

`/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init/isolation/m2/client.mjs`

The input must have sha256 `1c6b2df07bff0fb22985e2fda55d8616f77710109ee29f835cc03d8640fa03df`. Any other bytes are refused.

**Allowlisted edits.** Each old line must occur exactly once, or the derivation fails:

| line | original | generated |
|---|---|---|
| 53 | `import { judge } from './judge.mjs';` | `import { judge } from '<file:///…/isolation/m2/judge.mjs>';` |
| 54 | `import { startConnector, parseBindings } from './port-connector.mjs';` | same import from `file:///…/isolation/m2/port-connector.mjs` |
| 55 | `import { seedCertChain } from '../../relay/snp-verify.mjs';` | same import from `file:///…/relay/snp-verify.mjs` |
| 144 | `r.setTimeout(60000, () => r.destroy(new Error('timeout')));` | `r.setTimeout(app ? 840000 : 60000, () => r.destroy(new Error('timeout')));` |

**Allowlist check.** `check_allowlist` checks the line diff:

- the line count is the same;
- exactly these four lines differ;
- each differs exactly as shown.

**Refusals.** Derivation is also refused in each of these cases:

- `function request(..., { app = true } = {})`, the attestation call's `{ app: false }`, or the application call `request(agent, 'GET', appPath)` is not present exactly once. These three are what make `app` mean "application request".
- A dynamic `import(` is present.
- Any specifier other than `node:` or `file:///` remains.
- `840000` appears anywhere other than that one place.

**URL safety.** Each import URL is built as `file://` plus a percent-encoded realpath of the original's directory.

- Every byte outside `[A-Za-z0-9._~/-]` is percent-encoded.
- The URL must then match `^file:///[A-Za-z0-9._~/%-]+$`.

So quotes, backslashes, newlines or `${` in a path cannot reach the JS literal.

**Module identity.** The import specifier resolves to the same files the original's relative imports do, and Node caches modules by realpath'd URL. `judge.mjs` therefore shares the `snp-verify.mjs` instance that `seedCertChain` (`--amd-chain`) seeds, as it does in the original.

**Behaviour after the change:**

| request | idle timeout |
|---|---|
| application GET (`--path`) | 840 s |
| both attestation GETs (`{ app: false }`) | 60 s, unchanged |

These are also unchanged:

- `--answer-within`: fullbench passes 600000;
- the 60 s window for retrying a 502;
- the 10 s tunnel-upgrade timeout;
- exit codes;
- every judge, verdict-gate, TLS-pin, second-nonce, replay, runtime-pin and min-TCB line.

`--perf` requests would also get 840 s. fullbench does not pass `--perf`.

**Nesting with the existing limits.** The new 840 s timeout is shorter than every existing limit, and none of those limits changed:

| limit | value |
|---|---|
| client application idle timeout (new) | 840 s |
| harness `per_request_timeout_s` | 900 s |
| per-arm wall | 1260 s |
| full watchdog | unchanged |

The client's own timeout therefore fires first and leaves its reason on stderr.

**Outputs.** The derivation never copies the repository. It writes two new files, created exclusively, into a new directory:

- `client-bench-timeout.mjs`
- `derivation-manifest.json`

It refuses to write into the original's own directory. The manifest records:

- the original path, realpath and sha256;
- the generated file's sha256;
- the four edits and their line numbers;
- the two timeouts;
- the sha256 of `judge.mjs`, `port-connector.mjs` and `relay/snp-verify.mjs`, and of every module they import relatively. Specifiers are found by pattern, so this may over-pin, but it never under-pins;
- bare specifiers;
- the deriver's own sha256.

**Limits:**

- The dependencies are imported **live** from the original tree.
  - fullbench's plan pins the generated client's sha256 (`client_sha256`), but **not** these dependencies.
  - Root must run `verify` right before planning and again before each run.
  - `verify` does three things: re-derives from the pin held in the code (never the one in the manifest), compares the result to the bytes on disk, and re-hashes every dependency.
- The 60 s / 840 s split is proven from source text only.
  - Exercising the 840 s path at runtime needs a real attested domain.
  - No test mocks the judge or claims that crypto verified.

**Root commands (not run):**

```
python3 full-bench-prep/client-timeout/derive_client.py derive --out-dir <new empty dir>
python3 full-bench-prep/client-timeout/derive_client.py verify --manifest <dir>/derivation-manifest.json
# then plan with --client <dir>/client-bench-timeout.mjs (fullbench pins its sha256 at plan time)
```

## Change 2: `fullbench.py` stderr capture (diagnostic only)

- **`Host.popen(argv, out_path, err_path=None)`.**
  - When `err_path` is given, stderr goes to a second file. It is opened with `O_EXCL|O_NOFOLLOW|O_CLOEXEC`, mode 0600.
  - An existing file or symlink at that path refuses the start before any child runs.
  - Without `err_path`, stderr stays `/dev/null`, exactly as before.
- **Client.** The client's stderr goes to `client-<seq>-<tag>-<i>.out.err`.
  - After the child is reaped, `run_step` records `r["stderr"] = {"head", "truncated", "diagnostic_only": true}` and `r["killed_by_harness"]`.
  - `head` is the first 4096 bytes (`STDERR_HEAD_CAP`), decoded with replacement. Every non-printable character except newline becomes `?`.
- **Forwarder.** The forwarder's stderr goes to `fwd-<seq>-<arm>.out.err`. It is recorded as `h["fwd_stderr"]` in `run_arm`'s `finally`, after cleanup.
- **Probe.** The guestd probe's stderr is **not** captured; it stays `/dev/null`.
  - The probe holds the guestd key in-process.
  - An uncaught error could echo key-file bytes (for example a JSON parse snippet).
  - By design it reports errors as a fixed word on stdout.
- **Results are untouched.**
  - `parse_client` still reads only the stdout file, so a `VERDICT` or `RESULT` line on stderr has no effect.
  - `ok` is computed exactly as before; stderr and `killed_by_harness` never change it.
- **Gates are untouched.** Resource, owned-cleanup, watchdog and security gates are unchanged.
- **Check for root.** `p["out"]` now also holds `*.out.err` sibling files. If any review step inventories that directory, it should expect them.

## Tests (written, **not run**)

Run with `cd full-bench-prep/client-timeout && python3 -m unittest -v test_derive_client`.

`test_derive_client.py` uses the real pinned `client.mjs` bytes; it skips if they are absent or changed. They are copied into a temp tree whose path contains `' " ${x} \ newline`. The dependency modules there are hash-only stubs that are never executed. The tests cover:

- **Exact diff allowlist.** Lines 53, 54, 55 and 144 differ, with exact expected text. `check_allowlist` rejects a gate edit, a whitespace edit, an extra line, or a different attestation timeout. Derivation is reproducible. A read-only derivation from the real tree is included.
- **Changed source.** These are all rejected:
  - one byte changed (pin mismatch);
  - a duplicated or missing timeout line;
  - a missing import;
  - `{ app = false }`;
  - attestation without `{ app: false }`;
  - an added relative import;
  - a dynamic import;
  - a missing dependency.
- **60 s vs 840 s.** `request()` has exactly one `setTimeout`, equal to `app ? 840000 : 60000`. The default is `app = true`; attestation passes `{ app: false }`; the application GET passes no option. The 502 window, tunnel, `--answer-within` and default timeouts are unchanged.
- **Gate body unchanged.** The source is byte-identical from `const args` to `function request(`, and from `async function attest` to EOF. The gate, pin, judge, replay, nonce, runtime and min-TCB markers appear with the same counts.
- **Path quoting.** Specifiers contain only safe URL characters, and `'` is encoded as `%27`. Relative paths and unencoded URLs are refused.
- **Outputs.** Files are created new only and never next to the original. `verify` passes, then flags a changed dependency and a changed generated file.

Run with `cd full-bench-prep && python3 -m unittest -v test_fullbench`.

In `test_fullbench.py`, the new `StderrCapture` tests check:

- An attested client with no `app_status` and a Node `Error: timeout` on stderr gives `request_failed`, with the reason recorded.
- A full success transcript on stderr with empty stdout is **not** a success.
- Stderr noise does not fail a success.
- Capture is bounded and printable.
- A killed client keeps its stderr, with `killed_by_harness` set.
- Client and fwd stderr go to `out + ".err"`, and fwd stderr is recorded. The probe's stderr is not captured.
- The real `Host.popen` writes stdout and stderr to separate 0600 files, refuses an existing file or a symlink before spawning, and keeps DEVNULL without `err_path`. `subprocess.Popen` is patched here; no process starts.

The existing `FakeHost.popen` and one `popen` override in the tests were extended to accept `err_path`.
