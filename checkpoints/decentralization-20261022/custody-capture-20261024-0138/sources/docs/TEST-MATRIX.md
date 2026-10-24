# Custody v2 test matrix (as of 2026-10-23T22:10Z; refreshed 22:20Z)

**Test classes:**
- **unit:** source tests, with mocks or fixtures.
- **browser:** a headless browser.
- **anvil:** a local chain. "Real bytes" means the deployed vault bytecode (code hash `0x4b949b37…`).
- **SNP-hw:** the real AMD SEV-SNP production machine, with a disposable guest.
- **prod-read:** read-only public RPC calls.
- **prod:** a production action.

**LC** marks secret lifecycle steps.

| area (dir, head) | test | result | class | LC | log / receipt |
|---|---|---|---|---|---|
| dashboard (`custody-v2-dashboard-20261023/repo`, tested at e24a47fb2) | custody-v2-dashboard | 10/10 | unit (fixture vault) | save, rotate, pause, migrate, gated relay delete | `logs/final2.out` |
| | dashboard-browser | 2/2 | browser | the same flow, in a page | `logs/final2.out` |
| | dashboard-contract | 2/2 | anvil, real bytes + book + SessionVault/factory | save, rotate while paused, pause/resume | `logs/final2.out` |
| | mutants | 9/9 killed | unit | | `logs/mut2.*` |
| site release r2 (`custody-v2-site-release-r2-20261023`, 14b5f559) | focused suites | 52/52 (the prior commit fails) | unit | none | `logs/focused-new.out` |
| | release check, inert smoke | OK | build check, offline browser | none | `check/*.json` |
| code admission (`custody-code-admission-20261023`, 8578965c) | original-code-path | 21/21 | anvil, real bytes, test keys | none (code and handover) | `evidence/original-code-path.json` |
| | live-read, static | read-only | prod-read, static | none | `evidence/live-code-state.json`, `original-daemon-static.json` |
| durability (`custody-v2-durability-20261023/repo`, ab589bf8) | root closure | 8/8 | unit (real Caddy) | none | `root-closure.out` |
| | daemon-startup | 1/1 (FAILS on c95dcd3a and on the mutant) | unit (real daemon main, stubbed snpkey) | none | `logs/rc-daemon-startup-2.out` |
| | direct-ingress-paths | 1/1 (the mutant FAILS) | unit (real Caddy + router) | none | `logs/rc-ingress-paths.out` |
| | e2e on the original vault | 1/1 | anvil | genesis, release at t=1, handover, release at t=2 | `logs/fu-e2e-512.out` |
| custodian release (`custody-v2-release-20261023`, 23f7e51) | r2 build twice | A == B, measurement `70aadff5` | build | none | `logs/build-r2-1024.out` |
| | e01206d3 quote canary (image superseded) | ok, 19:31Z | SNP-hw, quote-only | none | `canary/root-hardware-20261023/verdict.json` |
| SNP recovery (`custody-snp-recovery-harness-20261023`, 7c4844a) | harness units | Python 27/27, Node 6/6 | unit | none | `logs/t2.out` |
| | fresh / 503 / reopen on r2 `70aadff5` | PASS, 20:14:49–20:16:29Z | **SNP-hw**, quote-only | **none** (startup recovery only) | `evidence/20261023T201449Z/` |
| original custodian (`c866…`, running) | fresh SNP quote, root-run | PASS 22:12:53Z (PROVISIONAL, root journal) | **SNP-hw**, quote-only | **none** (no secret flow) | `ROOT-CONTINUE-LATEST.txt` L522 |
| ingress forwarder (`custody-v2-ingress-forwarder-20261023`, b1c1feee) | allowlist + forwarder | 13/13; mutants 24/24 | unit | none | `logs/test-7.out` |
| production canary driver (`custody-v2-production-canary-20261023`, 01525201) | driver suites | 49 pass, 1 TODO; mutants 17/17 | unit | plans every step; **NEVER RUN** | `logs/c17.out` |
| owner migration (`custody-owner-migration`, not a repo, 10-20) | rewrap e2e | 1/1 (and 1/1 after the result-auth fix) | anvil, **SYNTHETIC** SNP | migrate (rewrap) | `logs/rewrap-e2e.out`, `logs/resultauth-e2e.out` |
| recipient restore (`custody-recipient-restore-20261023/repo`, a6b1378c) | gsup custody env | 4/4 (the control fails as designed) | unit | none | `logs/test-1.out` |
| | measured-control | 12/13 on BOTH trees (old failure, not called green) | unit | none | `logs/measured-control-1.out` |
| | builds | `ee5df6b8`; H `9f6d37bd` → `08d1f838` (root, PASS) | build | none | `logs/root-build-approved.out` |
| recipient activation (`custody-recipient-activation-20261023`) | activation, attestation, proof-key and recovery tests | 16/16, 21/21, 5/5, 10/10 | unit | none | `logs/tests-2.out` etc. |
| | **root activation of `ee5df6b8`, 21:32Z** | **FAILED adoption; rolled back 21:37** | **prod** | none | `logs/root-activate.out`, `ROOT-REGISTRATION-INCIDENT.txt` |
| D activation kit (`custody-boot-price-activation-20261023`, 8bbd0a74) | root-final-tests | Python 47/47, Node 14/14, mutants 78/78 killed (22:59:32-23:01:25Z) | unit | none | `STATUS.txt` L30 |
| original custodian (`c866…`, running) | fresh SNP quote, root-run, 2026-10-24 | PASS 00:00:27Z | **SNP-hw**, quote-only | **none** | `custody-v2-live-20261023` 3055ee7 `evidence/fresh-quote.json` |
| protected lease keeper (`custody-protected-lease-keeper-20261023`, b3c298c0) | root-run temporary unit | 2 verified renewals (23:57:48, 00:00:15); TTL 03:53:51 | **prod** (app-funded renewals only) | none | `outputs/decentralization-audit/custody-temporary-lease-protection-20261023.json` |
| operational gate v5 (`custody-operational-gate-v5-20261023`, f5077c21) | its source tests | per its README (not re-run here) | unit | none | source only, not activated |
| C9 7702 maintenance (`custody-operator-funding-options-20261023`, fe7e1057) | unsigned plan builder, read-only prepare, revm-processed test | per its README (not re-run here) | unit / read-only | none | source only; nothing signed |
| D boot-fee kit (`custody-boot-fee-activation-20261023`, 9d75f953) | t6 rerun | Python 49/49, Node 16/16, mutants 89/89 PASS (about 23:45Z) | unit | none | root journal [S27] |
| **control activation of `5db2be3f`, 23:36Z** | root production run | registration SUCCEEDED, adoption of both VMs, **gate FAILED** 23:43:16 (one EyesOff URLError); rolled back 23:43:19 | **prod** | none | D boot-fee kit `result.json`, `gate.json` [S29] |
| **control activation of `b007d471`, 23:10Z** | root production run | **FAILED** (no adoption within 300 s; self-registration "exceeds the balance"); rolled back 23:15:29 | **prod** | none | D kit `result.json` |
| recipient binding (`ab589bf8` custodian, `7dd3acd` recipient) | root-reviewed SOURCE review | direct quote gate; proofKey not an input; pointer not chain-verified (integrity caveat) | **source review only, nothing run** | none | `RECIPIENT-BINDING-REVIEW.txt` |
| factory wallet (`custody-factory-wallet-20261023`, 9557ad6d) | activation, browser | 12/12, 3/3; mutants 5/5 | unit, browser (fake MetaMask) | none | `logs/root-batch-tests3.out` |
| | live preflight | pass | prod-read | none | `evidence/root-live-preflight-20261023.json` |

## Summary

| lifecycle step | mock / fixture / browser | anvil | SNP hardware | production |
|---|---|---|---|---|
| save / rotate / pause | yes | yes (real bytes) | **no** | **no** |
| release (threshold decrypt) | — | yes (durability e2e, t=1 and t=2) | **no** | **no** |
| migrate / rewrap | yes (dashboard) | yes (synthetic attestation) | **no** | **no** |
| relay copy delete | yes (gated) | — | **no** | **no** |
| startup / 503 / reopen | yes | — | **yes (r2, 20:14Z)** | — |
| fresh quote of the running original custodian | — | — | **yes (c866, 22:12:53Z, quote-only)** | — |

**Not run:**
- the independent-runtime, independent-lifecycle, governance, identity and host-policy suites (durability `RESULT.md` L125-129);
- the v1 `custody-browser.test`, stopped by the memory guard at 1521 MiB;
- the full anvil wallet-route e2e, which needs a Foundry build over 1536 MiB.
