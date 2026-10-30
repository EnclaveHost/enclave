# Production quote UX and first app recovery — 2026-10-29

The first real USDC-to-ETH payment succeeded: transaction 0x540b1d23cbea1e67914ed94ec3750b28a9c38a47a06b8046a5d00ab6a4e4d2c4 bought 200000000000000 wei for deployment d979. Actual debit was 527573 microUSDC (461264 swap + 66309 relay), with 4353 refunded from the maximum. Three providers agreed on canonical inclusion. This does not itself prove finality.

The controller naturally claimed the funded app. Its guest became ready and two edges returned valid-TLS HTTP 200 at 03:56 UTC. Nine original targets remain. No hint, restart, repeat funding or new grant was used for this recovery.

The page now refreshes verified context/scope when Get quote is explicitly clicked, displays a live expiration countdown, disables expired quotes, preserves only the context-bound plain app/amount/tier draft through rerenders and reloads, and invalidates quotes across input/context changes. No private keys, signatures or quotes are persisted by the new draft helper. Final Fund remains an explicit, exact, single-use quote action.

Claude on the verified required Max account wrote the candidate and nine tests before its 780-second task timed out; no successful job-completion/report claim is made. Root froze the output, reviewed it and fixed two UI defects: stop the old timer before a new quote starts, and retain the invalidation note across input+change events. Initial failing evidence is retained. Nine reviewed-page tests and the same nine against the integrated source page passed, zero skips. Actual Chromium DOM tested fresh scope after a ten-minute test-clock idle, input preservation, countdown/expiry, zero sign/payment calls and actual reload durability. Core, wallet and RPC were mocked for these UX tests; they are not new financial protocol qualification.

Only UX deltas were integrated into site/js/pages/funding.js; that checkout has an older migration baseline, so the exact production page is separately retained here. SDK 69242be6e8d8d5d3fb7c74e6f838796aa9c6b733108c8ba38dbdd7ff426672ff, grants, contracts and relay are unchanged.

All four edges now serve bafybeig6l7oifypunvthyuoshcvp32r32yk2ghmrfniyr4dem6qlvrsn2q. The composite preserves all 1126 original files and adds exactly five files; each edge passed eight real HTTPS hash checks. The build provenance status describes the earlier build stage; per-edge verification records establish subsequent activation. The initial composite build rejected a wrong root manifest pin before mutation; corrected evidence is retained.

Run the portable focused tests with `node --experimental-vm-modules --test funding-page.test.mjs`. Deployment scripts are single-use historical evidence with workspace dependencies, not reusable installers. Do not rerun them blindly. Screenshots/DOM are in outputs/rpc-production-final-20261025/funding-quote-ux-test-20261029.*. No production payment was submitted by this UX test or deployment.
