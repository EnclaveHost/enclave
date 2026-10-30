# chain-consumer-closure E2E with the Foundry build: 7/7 pass (2026-10-25)

Source is `control-source` at HEAD ec56a70f143cf1bb6bbdd52228401bcf24eca05b. There is no new commit and no push.

## Result (run 2, `logs/consumer-e2e2.{tap,summary,guard,out,rc}`)
`# tests 7 # pass 7 # fail 0 # cancelled 0 # skipped 0`, rc=0, duration 324.6 s.

- The guard reported `exit=0 peakTreeRssMiB=1184` with the cap at 1408 and minHostAvailable at 20827 MiB.
- The run was offline: the unshare runner printed "external network: unreachable".
- The runner header records HEAD ec56a70f1 with `dirty: M test/chain-consumer-closure.e2e.test.mjs`.

| # | case | result |
|---|---|---|
| 1 | relay mode: claim, adopt on the verified receipt, renew; own backend only, no provider/public origin | ok |
| 2 | proof-source outage: claims refuse, app keeps serving, restart keeps it, claims resume | ok |
| 3 | lost submission answer + restart: release decided from verified receipt/nonce, sent once | ok |
| 4 | owner veto + admin delisting through the verifier | ok |
| 5 | admin AddressBook migration reaches a no-provider verifier host (book polling) | ok |
| 6 | positive control: recorder sees a legacy host's public defaults | ok |
| 7 | direct mode with planDirectBoot's chainVerifier environment | ok |

**Correction to my earlier report:** this file has 7 tests. The other 4 cases in `logs/control-e2e.txt`, which passed there, come from a different test file and were not part of this rerun. Also, run 1 was stopped by root (SIGINT) after its first failures; it did not exit on its own.

## Changed files
- **Runtime/production code: none.** `supervisor.js` and everything under network/ and metal/ are unchanged, and so are all `contracts/*.sol`.
- **Tests: `test/chain-consumer-closure.e2e.test.mjs` only** (+30/−3). The patch is `logs/consumer-e2e-test-fix.patch` (sha256 bf020c4f…b261); the resulting file sha256 is 366d33d2…8a11.
  1. **Case 1 registration assertion.** Since 92223d0df the supervisor adopts the rig's pre-registered row after a `setProofKey`, instead of a full `register()`. The wait now accepts either log line (`registered` / `adopted the existing registration of`). A new `verifyRegistration(H)` then checks the result on chain:
     - the endpoint and id equal the rig runner;
     - the registry row `get(id)`, read on chain, has `operator == rig.operator`, `active == true`, and `proofKey ==` the host's logged `proof-of-time signer`;
     - the logged tx has a `success` receipt, its `to` is the registry, and the receipt holds `ProofKeySet(id, signer)`;
     - the own backend recorded a registry send with the `setProofKey` or schema-4 `register` selector.

     This is stricter than before: the old check matched the log line alone.
  2. **Case 2 test hygiene.** `t.after(() => proof.st.mode = 'ok')` restores the proof source if the case fails, so later cases do not inherit an outage. The failure message of the "running app was not stopped" assertion now includes the delete effects and the stdout tail. The assertion itself is unchanged.
- **Build artifacts only (gitignored, `!!`):** `contracts/foundry/{out,cache}` from `jobs/forge-subset.sh`, using forge 1.7.1 and svm solc 0.8.35 (sha256 fa8ac9a3…). The subset build passed (rc 0, peak 336 MiB). The 12 artifact sha256s are in `logs/forge-subset.out`.
- **Outside the repo:** `jobs/{forge-subset.sh,consumer-e2e.sh,consumer-e2e2.sh,q.sh}`. `q.sh` retries the queue on exit 98 only.

## Outage-stop analysis (case 2)
Run 1's `the running app was not stopped (20 !== 0)` did not come back once case 1 was fixed. In run 1, case 1 threw at its registration wait, so the host was left mid-scenario: its later claim, launch and renew assertions never ran. Case 2 then counted delete effects against a host in that state. Case 2 also left the proof source `down`, which explains run 1's case 5 error (`no verifiable witness … HTTP 503`).

With case 1 completing, case 2 passed with its no-teardown assertions unchanged. So the evidence points to a cascade from the test, not to supervisor behaviour. One limit: case 2 has not been run in isolation after a failed case 1.

## Notes
- Run 1 log, from the earlier 11-test file set: `[proof] checkpoint submission failed: Execution reverted for an unknown reason.` I did not analyse it, and no case asserts on it.
- Not exercised here: a live chain, SNP, or real funds. The head authority is synthetic and the chain is a reth `--dev` rig.
