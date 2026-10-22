# Admin CLI `status`: the body-less GET no longer throws (RESULT, 2026-10-22)

**Status: committed locally and tested offline.**
- NOT pushed, NOT rebuilt, no image change: the admin CLI is not a guest bundle input, and root's image worker pins
  `493ee9ee0`.
- No SSH, live RPC, keys, wallet or secrets.

## The defect (confirmed)

`postJson(url, body)` in `scripts/platform-api-admin.mjs` computed `Buffer.from(JSON.stringify(body))` first.
- `status` calls it with no body. `JSON.stringify(undefined)` is `undefined`, so `Buffer.from(undefined)` threw
  `TypeError [ERR_INVALID_ARG_TYPE]` before any request.
- `status` therefore never worked.

## Fix

One line: the body is encoded only when there is one (`data = body === undefined ? null : …`).

Semantics are unchanged. `status` stays an advisory, unauthenticated GET:
- unpinned, `rejectUnauthorized: false`;
- nothing verified, signed or sent;
- its answer is printed, never used to decide anything.

`postJson` has no other caller: packages go through `pinnedPostJson`.

| item | value |
|---|---|
| commit | `dfe020abf1794bedc42943e43fe85eb02593dd8d`, tree `d50df24970539a086a97c7a0291343bd5705de19`, parent `0eac0d60`, author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `status-fix.patch` = `git diff 0eac0d60 dfe020ab`, sha256 `d40f253b6eb1ff2c90afa85d60eb463fe6a09fc36bd13925500ef797d14761e7` (2 files, +40/−1) |
| `scripts/platform-api-admin.mjs` | `3b41b2668afeb0daf3da7bab04ef23ea899e4823904e55e9bda396a89027833e` (+1/−1) |
| `test/platform-api-admin-status.test.mjs` | `bd4535ded740161845a89939f4c17fcdb0b8ee91d3d2564bbce8c9a5589a275e` (NEW) |

No docs change: `hosted-platform-api.md` already states that `status` is an unauthenticated read.

## Test (`claude-test-queue.py --mib 512`, private network + pid namespace via `run-test.sh`)

`test/platform-api-admin-status.test.mjs` uses a local HTTP fixture that records each request: method, path, body
bytes, content-type, content-length and chunking. The CLI runs `status` against it twice:
- in process, through `main()` with its injected `io`;
- as a child process, through the real entry (`node scripts/platform-api-admin.mjs status --target …`).

It asserts:
- exit 0;
- stdout is exactly the fixture's status JSON (`JSON.stringify(…, null, 1)` + newline);
- stderr is empty;
- exactly one request per run, each `GET /platform-api/status` with 0 body bytes and no content-type, content-length or
  chunked encoding.

| run | tree | result |
|---|---|---|
| status-base-1 | `0eac0d60` + the new test | **0/1**: `TypeError [ERR_INVALID_ARG_TYPE] … Received undefined`, thrown before any request |
| **status-fix-…-status-1** | fix (= commit bytes) | **1/1, EXIT 0** |
| status-fix-…-cli-1 (regression) | fix | `platform-api-admin-cli` **9/9**, peak 294 MiB |

Guard peak for the status test: below the sampling interval (reported as 0). Logs: `logs/status-*`. Hashes:
`EVIDENCE-status.sha256`. The large guest suites were not rerun: no guest source changed.
