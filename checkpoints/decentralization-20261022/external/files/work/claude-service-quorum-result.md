# Service-index quorum: slow honest heads, end-of-read freshness, one bounded deadline

Repository: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (uncommitted).
- **Files:** only `network/service-index.mjs` and the new `test/service-index-quorum.test.mjs` were changed;
  `test/service-index.test.mjs` is unchanged.
- **Untouched:** the contract, scripts, docs and other quorum modules (service-index contract commit `61c16967`
  included).
- **Not done:** no SSH, Wine, GUI, production, chain writes or commits.
- **Mutations:** run only in an isolated scratch copy (`/tmp/sq-mutation-scratch`, removed); the repository module
  was compared afterwards and was untouched.
- **Resources:** each test process was small (Node plus anvil for the existing suite), within the 250 MiB budget.

## Defects (from `participation-quorum-next.txt`)

1. **Late heads excluded.** The head phase chose the block after "first two heads + 250 ms", and only those peers
   read. A fast liar beside one fast honest RPC fixed the reader set, and a slower honest RPC (head at 500 ms, well
   inside the request deadline) was excluded permanently. The liar's disagreement became a veto.
2. **Freshness checked only at the start.** The block timestamp was checked once, before a possibly long read, so a
   snapshot could be accepted after it had aged past `maxBlockAgeMs`.
3. **Detached work.** The overall deadline only raced the work; reads could keep starting new RPC requests after the
   outcome was decided.

## Fix (`agreedRead`, `network/service-index.mjs`, sha256 `1b5b6327…f7fa`)

The public API, defaults, the pin, `readServiceIndex`, known-operator lookups, cursor/`atBlock` resumption and error
messages are unchanged.

- **Block choice excludes nobody.**
  - The head grace and the block rule are unchanged: the second-highest head minus confirmations, never below
    `floorBlock`, so a far-future head still cannot choose.
  - Every peer whose valid-chain head arrives **later**, at any time before the deadline, joins the read at the
    chosen block.
  - A wrong chain or a failed head never reads.
- **Two genuinely distinct identical snapshots, or nothing.**
  - A snapshot is accepted only when a **second, distinct** RPC returns it byte for byte (block hash, timestamp,
    value).
  - Each RPC reads at most once per round, and acceptance never falls back to a lone answer.
- **Newer-block retry, never older.** If every reader finished without a matching pair, and later heads now give a
  strictly **newer** second-highest block, the read is repeated there with every RPC that reported a head, under the
  same rule.
  - Example: a fast liar's low head made the first block stale.
  - Adding heads can only raise the second-highest, and the `>` guard forbids an older block.
  - `evidence.rounds` lists the blocks tried.
- **Freshness at the end.** The timestamp is checked at the start (as before), again **after** the read and hash
  recheck, and once more synchronously at the moment of acceptance.
- **One deadline for all work.**
  - Each request is capped at `min(requestTimeoutMs, time left)`.
  - Once the outcome is decided, or a round is superseded by a newer block, the `call` wrapper refuses to start any
    request.
  - Timers are cleared on every exit.
- **Evidence.** `rounds` was added. A head-only peer is reported as `late` only when a block was chosen; otherwise it
  is reported as `head`. Nothing in the repository consumed `late`.

## Tests

`test/service-index-quorum.test.mjs` is new and standalone: in-memory RPCs, real timers of at most a few seconds, no
chain. It has 7 tests:

1. **Slow honest head plus fast liar.**
   - Fast honest, fast liar, and a slow honest RPC whose head arrives at 600 ms (past the 250 ms grace): decided
     `truth@98` only after the slow RPC answered.
   - Evidence: agreed / disagreed / agreed.
   - A fast liar plus the slow honest RPC alone: refused, both disagreed.
2. **Stale low head from a fast liar.** The first block (48) is stale, the late honest head gives block 98, and the
   honest pair agrees there. `rounds` is `[48, 98]`, and the liar is shown as disagreed. Without a later honest head
   the read is refused at 48 with "older than 90000 ms" evidence.
3. **Stale after a long read.** The block is 400 ms inside a 1 s bound and the read takes 600 ms: refused with "became
   older than 1000 ms during the read". The same reads finishing inside the bound are accepted.
4. **Invalid chain.** Wrong-chain RPCs, both early and late (600 ms), are refused with "reports chain 1, not 31337";
   they never read and never count. One honest RPC beside wrong chains is refused with "fewer than two RPCs…", and
   the evidence shows `head` (not `late`) and block `null`.
5. **No-quorum evidence.**
   - A two-way split: both peers disagreed.
   - A three-way split: no pair.
   - One honest RPC plus a liar plus an honest RPC too slow for the deadline: refused within the bound, with the slow
     RPC marked "timed out after 1000 ms". A lone answer is never accepted.
6. **Deadline bounds paged reads.** Readers paging 40 × 100 ms requests under a 700 ms deadline are refused within the
   bound, with timeout or deadline reasons, and start at most in-flight requests afterwards. A 5 s request under a
   5 s deadline also ends within the bound.
7. **Early quorum and the time-left cap.**
   - After two fast honest RPCs decide, a slow third reader paging 40 requests starts no new request.
   - A read in flight when the 1 s deadline passes settles at the deadline (under 1150 ms), not after its own longer
     timeout.

**Runs:** `node --test --test-concurrency=1 test/service-index-quorum.test.mjs test/service-index.test.mjs`
→ **22 tests, 22 pass, 0 fail, 0 skipped**. The 15 existing anvil tests cover the honest pair beside a liar, wrong
chain, hang, future head or reorg; 1 honest + 1 liar or hang failing closed; pagination and cursors; lookups; the pin;
bootstrap; and the CLI. The new file passed on 5 separate runs.

**Mutation checks** (isolated copy):

| Mutation | Failing tests |
| --- | --- |
| Late heads excluded (the reviewed defect) | 1 |
| No retry at a newer block | 2 |
| End-of-read freshness removed | 3 |
| First answer accepted alone | 1, 2, 5 |
| Wrong chain accepted at the head | 4 |
| Requests keep starting after the decision | 7 |
| Requests not capped by the time left | 7 |
| Retry may move to any other block | none: equivalent, since adding heads cannot lower the second-highest; the guard is defense in depth |

## Residual notes

- **RPC-majority trust.** With exactly two head-reporting RPCs, one of them a liar, the liar can still make the chosen
  block stale or disagree. The read then fails closed with evidence; it never accepts. Recovery needs at least two
  honest RPCs within the deadline.
- **Same backend, two labels.** Distinctness is per configured peer. Two labels that point at the same backend are the
  caller's choice (`peerList` already requires distinct labels; the scripts require distinct origins).
