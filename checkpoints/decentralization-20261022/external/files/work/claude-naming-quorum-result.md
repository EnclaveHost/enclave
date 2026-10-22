# Round 2: exact RPC identity, header format and superseded rounds

Written 2026-10-19 in response to the coordinator's review. Only `isolation/m2/bootstrap/chain.go`,
`isolation/m2/bootstrap/quorum_test.go` and `docs/network/independent-names.md` changed. No front files were
touched.

- Nothing is committed.
- No production, SSH, Wine, GUI or chain writes.
- The mutation check ran in an isolated copy (`/tmp/cmut`, since removed).

## Fixes in `chain.go`

- **One host, one vote.** `NewReader` now identifies an RPC by a canonical host, computed by the new `rpcHost()`:
  - DNS names are lowercased and one trailing root dot is removed, then must be a well-formed name: LDH labels, at
    least two labels, a top label with a letter. Otherwise the configuration is refused.
  - IP literals are canonicalized by address (`netip`, IPv4-mapped IPv6 unmapped).

  So `https://RPC.example`, `https://rpc.example.` and `https://rpc.example:443/b` are one host, as are
  `1.2.3.4`, `[::ffff:1.2.3.4]` and differently spelled IPv6 forms; any such pair is refused as not distinct. Peer
  names in diagnostics are the canonical host. The request origin is unchanged.
- **Strict header hash.** A returned block hash must be exactly `0x` plus 64 hex characters, non-zero. Bare, `0X`,
  short and long forms are refused. The strict number and timestamp quantities and the before/after header recheck
  are kept.
- **Explicit peer set per snapshot.** Agreement is now `agree[full snapshot key] = set of distinct peer names`, and
  a pair means two different peers. Before, this held only indirectly through the per-peer-and-block read
  deduplication.
- **Superseded rounds cannot return.**
  - Every result carries the target block its read was started for, and an answer for any block other than the
    current target is refused ("answer for superseded block N"), even if it agrees.
  - Each target block is a round with its own context. Choosing a newer target cancels the old round, and
    `readAt` checks the context before every request, so a superseded or expired read sends no further request.
- **Preserved:**
  - concurrent `highWater` CAS floor and freshness at acceptance (before and after the CAS);
  - agreement on the whole raw row at one block;
  - late heads joining the read, upward-only target moves, early return on a pair, no single-answer fallback;
  - the 20-second deadline and goroutine cleanup;
  - agreed-inactive revocation versus outage (`leaseCurrent` after agreement).

## New deterministic tests (`quorum_test.go`)

The simulator gains a per-request hook (it ignores cancellation, like a slow server) and a hash override.

| Test | What it proves |
| --- | --- |
| `TestOneRPCHostCountsOnceHoweverItIsSpelled` | Case, trailing-dot, port-443, IPv4-mapped and IPv6 spellings of one host are refused as duplicates; malformed hosts (`rpc..example`, `-rpc.example`, `rpc_1.example`, single-label, numeric TLD, double trailing dot) are refused; names are canonical. |
| `TestBlockHashMustBe0xAnd32Bytes` | Bare, `0X`, short and long hashes are refused as "invalid block hash". |
| `TestSupersededRoundNeverReturnsAndStopsItsRequests` | See below; 4 variants. |
| `TestDeadlineStopsFurtherRequestsOfAnInFlightRead` | A slow server answers after the caller's 100 ms deadline: the read reports the deadline, and no further request is sent. |

`TestSupersededRoundNeverReturnsAndStopsItsRequests`: two colluding fast liars name block 3 and would agree there.
Honest heads move the target to 98, and the liars' reads are held until the new round begins.

- **Held in an early request:** cancellation stops every later request of the old reads; no request was counted
  after release.
- **Held in the last request:** the old reads complete with an agreeing pair, which is refused.
- **Honest pair disagreeing:** nothing is accepted, and the error names "superseded block 3".
- **Honest pair agreeing:** only block 98 is accepted.

**Mutation check.** The previous `chain.go`, in an isolated copy:

- These fail, as they should: the duplicate-host test, the bare-hash case, all four superseded-round variants, and
  the deadline-request test.
- The `0X`, short and long hash cases were already refused, so they are preservation checks.

Commands (focused, `-p 1`):

```sh
cd isolation/m2
GOPROXY=off go vet ./bootstrap                                  # ok
GOPROXY=off go test -count=1 -p 1 ./bootstrap/                  # ok (all bootstrap, incl. revocation and earlier quorum tests)
GOPROXY=off go test -race -count=2 -p 1 ./bootstrap/            # ok
GOPROXY=off go test -count=3 -p 1 ./bootstrap/ -run 'CountsOnce|BlockHashMust|Superseded|DeadlineStops'   # ok, stable
GOPROXY=off go test -count=1 -p 1 ./front/ -run 'TestDirect|AgreedCancellation'   # ok (read-only check; no front edits)
```

## Residuals (unchanged)

- The threshold is two distinct agreeing fresh RPCs.
- A read that cannot agree waits up to the 20-second deadline.
- The floor is per `Reader`, in memory.
- Measured release and hardware validation are still pending.

---

# Naming follow-up: the chain reader's quorum under slow and lying RPCs

Written 2026-10-19. Repo: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`.

- Nothing is committed.
- No VM, SSH, Wine, GUI, production or chain writes. No background jobs were scheduled.
- Mutations ran only in an isolated copy (`/tmp/qmut`, since removed).

## Bugs, confirmed in `isolation/m2/bootstrap/chain.go` `read()` before this change

1. **Slow honest peer excluded.** Head collection stopped 250 ms after the second successful head, and only those
   heads were read.

   - A fast honest RPC plus a fast liar (same block, different raw row) filled the round, while a slower honest RPC
     (for example at 500 ms) was dropped.
   - The pair disagreed, so the read failed even though an honest pair existed well within the 20-second deadline.
     That is censorship, or a needless outage.
2. **Spoofed old head pinned the block.** The block was chosen once, from the early heads. A fast bad head naming an
   old block could pin the round to a block honest peers report as stale. No later head could move it.
3. **Freshness checked only at the start of each read.** It was not re-checked when the pair was accepted, so a
   slow read could accept a block that had gone stale by then.

## Fix (narrow; `read()` rewritten as one bounded event loop, plus `fresh()` and `accept()`)

- **Heads:** every peer's head is collected within the existing 20-second deadline; nothing is cut off after
  250 ms. A head that arrives late joins the read at the chosen block.
- **Block choice:** the second-highest head minus the confirmations, as before, so one peer alone can neither raise
  the block nor, once a second honest head arrives, hold it down.
  - When later heads support a strictly newer block, every peer with a head reads that block too, immediately. It
    does not wait for the earlier round to finish, so a liar whose read of the old block hangs cannot stall the
    read.
  - The block never moves down and is never chosen below `highWater`. There is no first-answer fallback: only an
    identical pair is ever accepted.
- **Early return:** the first identical pair (`number/timestamp/hash/raw row`) that passes `accept()` returns at
  once, without waiting for a hung third peer.
- **`accept()`:** checks freshness, then moves the `highWater` rollback floor with CAS (a pair below the floor is
  refused as a rollback rather than ending the read), then checks freshness again.
  - Freshness means not future and not older than `maxAge`, judged at that moment.
  - A refused pair leaves the floor unchanged and the read goes on to other rounds or peers, until the deadline or
    until nothing more can arrive.
- **Bounds:** at most one block move per arriving head, so at most `len(peers)²` block reads. Channels are buffered
  to that size, so no send blocks, and every goroutine ends when the deadline context is cancelled.
- **Diagnostics:** de-duplicated public peer names with bounded reasons.

**Preserved:**

- The cancellation-before-judgment fix: `readAt` returns raw facts, and `leaseCurrent` judges only an agreed row.
- The quorum key on the whole raw row and same block.
- The `highWater` rollback floor and the original 20-second deadline.
- `readAt`'s own early freshness, reorg and schema checks.
- The deadline and quorum-unavailable error paths.

No module from the service-index or Windows workers was imported. Their late-head approach was read for concept
only.

## Tests

New file `isolation/m2/bootstrap/quorum_test.go`. A chain simulator models, per RPC: head delay, a hung head, honest
per-block timestamps and hashes, no blocks above the RPC's head, a liar that serves any block as fresh, a hanging
old-block read, and a hook before the second block fetch of each read.

| Test | What it proves |
| --- | --- |
| `TestLateHonestHeadIsNotExcludedByAFastLiar` | A fast honest RPC, a fast liar (other row) and an honest head at 600 ms: the honest pair's block 98 is accepted. |
| `TestTwoEarlyHonestReturnWithoutAHungThird` | Returns in under 1 second with a hung third. |
| `TestSpoofedOldHeadCannotHoldTheBlockDown` | A fast liar at head 5 serving block 3 as fresh, with its read either returning or hanging forever: the late honest pair moves the read to block 98. |
| `TestNeverBelowTheAcceptedFloorNorASingleAnswer` | After accepting 98, two peers support only 97 (below the floor) and one late peer alone names 102: refused, floor stays 98. With a second late peer at 102: block 100 accepted, floor 100. |
| `TestFreshnessIsJudgedAtAcceptance` | Each read starts fresh, but the block is 200 seconds old when the pair agrees: refused "at acceptance"; the floor does not move. |
| `TestReaderEndsEveryGoroutineAndKeepsItsDeadline` | The goroutine count returns to baseline after a read with a hung peer; a caller's 100 ms deadline ends an all-hung read promptly with a deadline error. |

**Mutation check.** The pre-change `read()` (with the revocation fix intact), in an isolated copy:

- These fail, as they should: `LateHonest` (0.25 s, the 250 ms cut-off), `Spoofed` (20 s deadline), `NeverBelow`,
  and `FreshnessIsJudged`.
- `TwoEarly` and `EndsEvery` pass on both versions; they are preservation tests.

**Existing tests** (unchanged, all pass): the bootstrap quorum, stale, future, reorg, wrong-chain and wrong-schema
cases; rollback; the confirmed-startup wait; revalidation; the revocation tests from the previous round (agreed
cancel/release revokes, single liar cannot, bounded outage grace); and the front direct-path, ACME and revocation
tests.

Commands (focused, `-p 1`):

```sh
cd isolation/m2
GOPROXY=off go vet ./bootstrap ./front                         # ok
GOPROXY=off go test -count=1 -p 1 ./bootstrap/ ./front/        # ok (4.8 s, 5.5 s)
GOPROXY=off go test -race -count=2 -p 1 ./bootstrap/           # ok
GOPROXY=off go test -race -count=1 -p 1 ./front/ -run 'AgreedCancellation|InFlightACME|DirectOwner|DirectFront'  # ok
go build -o /dev/null -tags bootstrapdirect ./front && go build -o /dev/null ./front   # ok
```

The first `-race` run flagged a race in my own test fixture, not in the reader: the floor test mutated simulated
peers while a lingering read touched them. Each phase now builds fresh simulated peers on the same `Reader`.

## Residuals

- **Threshold unchanged:** two identical fresh RPC answers. Two colluding RPCs can still agree on a false row, or
  stall the read until the deadline (fail closed).
- **Waiting is not instant:** a read that cannot agree waits for every head and reader, up to the 20-second
  deadline, before failing. That was already the deadline; slow honest peers now get to use it.
- **Floor and rounds:** the floor is per `Reader`, in memory, as before. Between rounds the block moves only upward,
  so a liar that supports a higher head can make honest peers read a block they do not have yet. They refuse it, and
  the read then needs another supporting head or fails at the deadline. The second-highest rule means a single peer
  cannot do this alone.
- **Before release:** measured release and hardware validation are still needed, as in the earlier reports.

## Files

- **Modified:** `isolation/m2/bootstrap/chain.go` (`read`, new `fresh` and `accept`; `readAt` unchanged except
  formatting) and `docs/network/independent-names.md` (one reader bullet).
- **New:** `isolation/m2/bootstrap/quorum_test.go`.
