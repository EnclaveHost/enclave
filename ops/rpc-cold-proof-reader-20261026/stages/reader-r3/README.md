# cold-proof-timeout-stage/r3 (PROPOSED fix; FROZEN; offline tests run by Claude under root's authorization; see logs/). Supersedes r1, r2
(both frozen, untouched). r3 = r2 + root review fixes: (1) the test runs the REAL reader CLIs (initial AND recheck) as ASYNC children
(r2's spawnSync blocked the in-process mock server); (2) the per-request deadline is floored to whole ms (fractional performance.now
budget; AbortSignal.timeout needs an integer) and < 1 ms left refuses before fetch; new fractional-budget test. r2 (kept) = the 200 s read budget is MONOTONIC (performance.now; separate from the wall clock used for the
finalized-header age) and is enforced AGAIN after the last request, parsing, proof crypto and A1/recheck evaluation, immediately before
evidence is emitted, in BOTH readers (finishRead: read_budget_exceeded, then finalized_stale_after_read / finalized_future /
no_l1_timestamp). Unchanged from r1: 60 s per proof-bearing request (eth_getProof, eth_call), 20 s for every other request, one attempt per
request (no retry, no fallback, no `latest`, loopback only, same envelope/byte-cap rules); a1-anchor.mjs / a1-recheck.mjs / a1gate untouched;
capture()'s 240 s remains the hard kill.
  src/l1-anchor-a1/a1-read.mjs = src/a1-original-game-prepared/a1-read.mjs  a501a3ec... -> da9a9e9c...
  src/a1-original-game-prepared/a1-recheck-read.mjs                        41b83975... -> 78df2211...
Tests (jobs/root-cold-proof-tests.sh, queue 256, offline): 13 transport/budget/freshness tests + the EXISTING pinned A1 suite
(a1-anchor.test.mjs: runA1 malformed/forged-proof/stale/future refusals, rpc()/loopback/byte-cap/timeout) on the pinned original AND with
the new reader (same pass count, 0 fail) + the EXISTING original-game recheck policy suite (a1-recheck.test.mjs) on its pinned tree.
INTEGRATION.md = exact 19-file pin cascade over r12-final (tools/cascade_plan.py, read-only). canary/ = cold-recovery canary against the
reviewed COMPOSED bytes (pins pending); coldProof.exercised only reports that a > 20 s proof succeeded, never OS-cache coldness.
