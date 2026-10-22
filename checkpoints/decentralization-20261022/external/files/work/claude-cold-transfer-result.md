# Cold-host collateral: KDS fetch release, Retry-After, bounded reads, verified scope

Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (uncommitted).
- **Not done:** no SSH, Wine, GUI, production, hardware commands, commits or pushes.
- **`isolation/m2/sev-inventory.c` unchanged:** still sha256 `e8913b98234a93d56ab0d24c36d3654ebb54ff9289e6c67a967860e3b917607e`, the source that
  passed on hardware.
- **Mutations:** run only in an isolated scratch copy (`/tmp/hc-mutation-scratch`, removed afterwards); the repository
  file was compared before and after and was never modified.

## Fixes (`isolation/m2/host-collateral.mjs`, sha256 `7af01c46…bed13`)

1. **Failed answers are released.** `fetchKds` now releases every answer that is not read to completion. It aborts
   the request and cancels the body (through the reader when one is active), and does so **before** clearing the
   attempt's timer and before any retry sleep. This covers:
   - 429/5xx bodies that are then retried;
   - a final 404 or other non-retried status;
   - an oversize declared `content-length` (now parsed only when it is a digit string);
   - an oversize streamed body;
   - network errors mid-body.

   The cancel is awaited for at most 1 s, so a misbehaving stream cannot stall the release. The bounded retry policy
   is unchanged: 4 attempts, 10 s per attempt, waits capped at 30 s, 404 final, oversize final.
2. **The deadline covers the body.** The per-attempt timer aborts the request **and** cancels a body still being
   read, so a body that is not tied to the fetch signal cannot hang the loop. A read ended by the deadline counts as a
   timeout and is retried, never returned as a short answer.
3. **Retry-After.** `retryAfterMs(value, now)` accepts only a present, valid delta-seconds value (`^\d{1,9}$`) or a
   strict IMF-fixdate HTTP-date. Absent (`Headers.get` → `null`), empty, negative, fractional, exponent or invalid-date
   values return `null`, which selects the exponential backoff (base 2 s, ×2 per attempt). Previously `Number(null)`
   gave 0 and retried at once.
4. **`readBounded`** (now exported for tests) reads through one opened descriptor:
   - flags `O_RDONLY|O_NOCTTY|O_NONBLOCK`, so a FIFO cannot block the open;
   - `fstat` on that descriptor; strict regular files only;
   - size check, then at most **max + 1** bytes read, with `max + 1` meaning "too large";
   - the descriptor is always closed.

   All operator inputs use it: VCEK, chain, CRL, floor, statement and helper output.

## Tests (`test/host-collateral.test.mjs`)

The KDS stub now returns **real WHATWG `Response`/`Headers`/`ReadableStream`** objects, so a missing header is
`null`, as with undici.

- **Backoff:**
  - 429 with `Retry-After: 7`, then 503 with no header, then success: sleeps `[7000, 2000]`.
  - 503 then 500, both without headers: sleeps `[1000, 2000]` (missing header → exponential, never 0).
  - Seven invalid values (`soon`, `-5`, `1.5`, empty, blank, `1e3`, an impossible date) each fall back to the backoff.
  - An HTTP-date 12 s ahead of the injected `now` sleeps 12000; 3600 s is capped to 30000.
- **Release before retry**, with hanging bodies that record abort and cancel:
  - 429 then 500, then success: event order
    `fetch 1, abort 1, cancel 1, sleep 1000, fetch 2, abort 2, cancel 2, sleep 2000, fetch 3`.
  - A final 404, an oversize declared length and an oversize streamed body each give exactly
    `fetch 1, abort 1, cancel 1`, then the expected refusal.
  - A 200 body that stalls past a 40 ms deadline is cancelled by the deadline, before the next fetch, on both
    attempts; it ends as "no answer within 40 ms".
- **Bounded reads:**
  - a file at exactly the limit is accepted;
  - a file over the limit, a directory, a FIFO (refused without blocking) and a missing file are refused;
  - a file that grows after the size check (stale `fstat` simulated in-process) is refused after exactly **101**
    bytes are read through the **one** checked descriptor, which is then closed.
- **Unchanged:** the earlier byte-cap, timeout, 404 and attempt-bound cases.

Run: `node --test test/host-collateral.test.mjs test/host-collateral-inventory.test.mjs`. Result: **12 tests, 12 pass,
0 fail, 0 skipped** (7 in the collateral file, including 2 new; 5 in the inventory file).

**Mutation checks** (isolated scratch copy):

| Mutation | Result |
| --- | --- |
| No release of failed answers | test 4 fails |
| Release without abort | test 4 fails |
| `Number(header)` Retry-After restored | tests 3 and 4 fail |
| Deadline-cancelled read accepted as an answer | test 4 fails |
| Unbounded read buffer | test 5 fails |
| Regular-file check removed | test 5 fails |
| Old wait guard (`Number.isFinite`) | no test fails: an equivalent mutation once `retryAfterMs` returns `null` |

## Documentation

- **`docs/network/cold-host-collateral.md`** (sha256 `93b155b0…dbdab`):
  - the Turin `prepare` example now uses a valid 16-hex hardware ID (`fa11afcf54ae9c53`) instead of a 128-hex CHIP_ID;
  - KDS fetch behaviour (whole-answer deadline, release-before-retry, Retry-After validity) and bounded local reads
    are documented;
  - the limits section now states the verified scope from the evidence, and what it did not verify.
- **`docs/network/cold-host.md`:** only my existing narrow passage changed, now stating the same scope.

**Verified scope, from `work/cold-hardware-review/`:**
- `run-fixed.json`: the corrected helper ran unprivileged and exited 0.
- `statement.json`: Turin, hardware ID `fa11afcf54ae9c53`, API 1.58, 4 guests, ID length 8.
- `fresh-collateral/`: VCEK, chain and CRL fetched live from AMD KDS; CRL policy `required`; TCB `0103020500000075`.
- `live-report-verification.json`: the collateral matched an existing guest's report.

It was not a new cold boot: the host was an existing running one with four guests; the floor is the prior operator
policy; no application measurement or TLS binding was judged.

## Activation gates

1. **Cold boot still pending:** on a host that has never run a guest:
   1. run the helper;
   2. `prepare --statement`;
   3. start guestd with the new collateral;
   4. boot one guest;
   5. confirm its verdict names the same hardware ID and TCB.
2. **Floor:** a new TCB floor needs an advisory review; the current one is the prior operator policy.
3. **Unchanged gates:** multi-socket and other ID formats are refused; CRL freshness and ASK rotation remain operator
   gates.
