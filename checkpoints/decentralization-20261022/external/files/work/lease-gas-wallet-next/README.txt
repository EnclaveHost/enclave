STATUS 2026-10-20 21:56Z: setup steps 2 and 3 were executed by root from a frozen snapshot of this candidate and are
confirmed on Base; this candidate re-verified them read-only (see work/claude-lease-wallet-next-result.txt). Do not resend.

Lease-gas setup steps 2 and 3 (executor creation, one-time binding) - candidate for ROOT REVIEW; NOT activated.

Step 1 (reserve creation) is root's live work/lease-gas-wallet handoff; this candidate only READS its journal
(work/lease-gas-wallet/reserve-handoff-state.json) and never writes any root file.

New files
  trust.mjs       production pins (admin 0x0b2d…E61, address book, ledger16d, registry4, oracle, code hashes, accepted
                  source sha256, providers, caps). Unit-tested equal to root's read.mjs / calibration fixture.
  artifacts.mjs   frozen artifact verification (accepted main source; app-lease-gas and forge/src copies identical; every
                  compiler-closure input's keccak; artifact/creation-code/compiler/settings == preflight provenance) and the
                  exact executor runtime (compiled runtime with reserve, ledger and its own address filled in).
  stages.mjs      prepareExecutorRequest / verifyExecutor / prepareBindRequest / verifyBinding (read-only).
  stage-app.mjs   stage servers on root's handoff transport; one journal per stage; crossed-stage hashes refused.
  serve-next.mjs  node serve-next.mjs --stage executor|bind --serve   (INACTIVE until root's review)
  stage-cli.mjs   node stage-cli.mjs check-artifacts | prepare-executor | verify-executor | prepare-bind | verify-bind
  stage.html, next-app.js   the page (next-app.js = root's app.js with the confirmation text taken from the page)
  handoff-server.patch      root's handoff-server.mjs + an optional accept(hash) hook (backwards compatible)

Byte copies of root files used unchanged: request.mjs, verify-reserve.mjs, app.js (+ root's three test files, run here
against these copies). base/ holds the frozen root originals; base/BASE.sha256 and base/INPUTS.sha256 their hashes.

Order (each needs a wallet signature; nothing here signs or sends):
  1. root: reserve creation -> its journal confirmed (verifyReserve on two providers).
  2. serve-next --stage executor: prepare re-verifies the reserve ON CHAIN from root's journaled request+hash, refreshes
     anchor/nonce/pending/fees/balance/authority, simulates on both providers, journals, then hands the exact request
     to MetaMask once. Verification: receipt two blocks deep and canonical on both, exact runtime and getters.
  3. serve-next --stage bind: prepare re-verifies the reserve AND the executor on chain, simulates bindExecutor, journals,
     hands it once. Verification includes the single ExecutorBound event; only then is the reserve a funding destination.
