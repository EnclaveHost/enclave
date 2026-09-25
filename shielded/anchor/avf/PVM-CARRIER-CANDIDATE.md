# The pVM carrier as a scoped candidate for main (review/pvm-carrier-candidate; for review, NOT merged, NOT deployed)

**What this branch is.** The smallest tree that carries the reviewed pVM carrier onto current main, with everything it needs
to build, deploy and be tested there:
- **origin/main at 164e7279**;
- **plus U7**, security/u7-eligible-routing at **18772bf7** (approved by enclave-d1 and enclave-5d; not yet on main), merged
  cleanly as **4c8334cb**. It is a prerequisite: the carrier is a carve-out inside U7's routing and does not stand without it;
- **plus the carrier's files from review/pvm-u7-integration at 48c6efb3** (approved by enclave-99; the Pixel regression passed
  at that revision, results/pvm-cpu-relay-reconnect-u7 on that branch).

Everything the relay runs is byte-identical to 48c6efb3. What is not:
- this note;
- two test files adapted to this smaller tree;
- two assertions in main's test/verifier-integration.test.mjs, which assumed the module is never in the tree (below;
  enclave-99's file, for their approval).

The full reviewed branch is untouched: review/pvm-u7-integration (head 8e18618d) and pvm-cpu/portable-runtime (742d1b01)
stay as they are.

This branch authorizes nothing. Landing it on main is a production relay deploy (deploy.yml ships relay/** on a push to
main), and that is a separate decision (below).

## The inventory: what the reviewed branch carries beyond U7, and what came here
`git diff 18772bf7 48c6efb3` names **1,878 files**. None of them has its 48c6efb3 content on origin/main already. The
only one main has changed since U7 branched is relay/api-relay.js, and 48c6efb3 already carries main's version of that
change.

| What | Files | Here? | Why |
|---|---|---|---|
| **Relay runtime** (shipped by relay/deploy.sh) | relay/api-relay.js, relay/tunnel.js, relay/deploy.sh (modified); relay/pvm-app-attest.mjs, relay/pvm-serving.mjs (new) | **yes**, byte-identical | the carrier itself; tunnel.js imports pvm-app-attest.mjs **statically**, so it must ship whatever the switch says |
| **Relay-side checker, not runtime** | relay/pvm-checkpoint.mjs | **yes**, byte-identical | test/fixtures/pvm-fake-vm.mjs imports it. Nothing shipped imports it, and deploy.sh does not ship it. main's verifier/pvm-proof-key.mjs already expects it beside pvm-app-attest.mjs |
| **The carrier's contract** | shielded/anchor/avf/RELAY-SERVING.md | **yes** | the reviewed statement of what the carrier does; api-relay.js, deploy.sh and pvm-serving.mjs cite it |
| **Browser modules the test VM needs** | shielded/anchor/avf/web/{pvm-sealed.js, pvm-verify.js} | **yes**, byte-identical | the fake VM builds real evidence and sealed answers with them. Nothing deploys them: the site does not serve shielded/, and the relay never reads them |
| **Vendored, generated** | web/vendor/hpke-core-1.9.0.js, hpke-LICENSE.txt, build-hpke.sh | **yes** | @hpke/core 1.9.0 + @hpke/common 1.10.1 (MIT), bundled by build-hpke.sh from integrity-pinned npm tarballs with the lockfile's esbuild 0.28.1. **Rebuilt for this candidate: byte-identical** (sha256 a4302f89…3e34) |
| **Tests and fixtures** | test/{api-relay-pvm-serving, pvm-runner-resolver, pvm-app-attest, pvm-u7-integration}.test.mjs, test/tunnel.test.mjs (modified), test/fixtures/{avf-lab-root-preload, pvm-fake-vm}.mjs | **yes**, byte-identical | every one's import closure is inside this tree |
| **Tests adapted to this tree** | test/pvm-carrier-hub.test.mjs (new), test/mutate-pvm-serving.mjs; on main's side, test/verifier-integration.test.mjs | **yes**, changed | below |
| **Other pVM tests** | 48 of the 56 test/ entries (tests, fixtures, checkers' tests, three other mutation harnesses) | no | each needs something that is not here: the pVM client (shielded/anchor/avf/client), the runner (attach co-signer, proof and runner agents), the VM payload's C headers or the runtime's vectors, the lab carrier, or a device capture in results/ |
| **The pVM lane** | avf/runtime (57), cpu (27), client (23), payload (9), host (5), runner (4), web (the other 4: the lab page and the browser client), build.sh, 6 design notes | no | the VM, its host app, the owner's client and runner agents. They build the APK and run the lab; no relay or site deploy reads them |
| **Evidence** | shielded/anchor/avf/results/** (1,673) | no | device and lab captures. They stay on the reviewed branch, where 99's offline re-verification points |
| **Secret-scan config** | .gitleaks.toml | no | the reviewed branch's extra entries are all for results/ and client/ captures, which are not here. main's file (enclave-99's) passes this candidate unchanged |

There is **no package.json or lockfile change** anywhere in the delta. "Unrelated history": the reviewed branch's 67 commits
include merges of main and U7. Nothing of that history comes here; this branch has one merge (U7) and new commits only.

### The adapted test files
- **test/pvm-carrier-hub.test.mjs.** The reviewed branch's test/pvm-relay-serving.test.mjs drives the carrier with the pVM
  CLIENT (client/dist, the lab carrier and a device capture), which does not come here.
  - Its three client-free tests are copied VERBATIM, with their helpers:
    - `carrierRoute`'s exact raw routes;
    - the bootstrap route on the real hub;
    - v3 at attach on the real hub.
  - Three NEW tests cover, over raw HTTP, what the client-driven tests covered:
    - the carrier's bounds and a stream's life: a hung ledger gets 504 and then 429; a slow VM's answer is cut at the bound;
      two buyers stay apart; a buyer that leaves is closed on the VM side;
    - the real hub's stream rule: evidence reaches any AVF-attested pVM tunnel, and a sealed stream reaches only an app the
      hub verified;
    - the cross product of the app and runtime lists.
- **test/mutate-pvm-serving.mjs.** The same 42 mutations (M01-M37, U01-U05) and the same anchors. Changed:
  - its module suite is test/pvm-carrier-hub.test.mjs;
  - its tree copy is what this branch carries;
  - M17, M18, M19 and M20 name the test here that catches them. On the reviewed branch the client-driven tests did.
- **test/verifier-integration.test.mjs** (main's, enclave-99's; a separate commit **for their approval**). Two of its
  assertions assumed relay/pvm-app-attest.mjs is never in the tree. With this candidate it is, so both failed:
  - "non-strict, module absent" ran the device suite with `ENCLAVE_PVM_MODULE` empty. That now loads the tree's module, and
    the suite RAN instead of skipping. It now names an explicitly absent path, which is the absent case whatever the tree
    holds.
  - "resolve: the pinned commit materialises…" asserted that the tree has no relay/pvm-app-attest.mjs, as its check that
    resolve wrote nothing into the tree. It now asserts that the tree's copy is exactly as resolve found it, present or
    absent.
  - Both pass here, and on main+U7 without the module.

## Build and deployment copy lists
- **relay/deploy.sh (the api relay, nan):** the scp list gains pvm-app-attest.mjs and pvm-serving.mjs. test/relay-deploy-closure
  passes: every relative import reachable from a shipped entrypoint is shipped. pvm-checkpoint.mjs is reachable from none.
- **The data-plane relays** (relay.js and the others, deploy.sh's `$RH` loop): no file of theirs changes.
- **scripts/deploy-us-west-egress.sh:** its shared set is egress-relay.js's imports (net-guard.mjs, fleet.mjs, connlog.mjs)
  plus the npm manifests. This candidate changes none of them beyond U7, so the pVM files add nothing to the egress host's
  preflight. (U7's own fleet.mjs change does matter there; that is U7's rollout note, not this one's.)
- **The vendored verifier** (relay/vendor/enclave-verifier-node.mjs, which deploy.sh ships; verifier/dist; the CLI):
  rebuilt with verifier/node/build.mjs in this tree and in main+U7. Both are identical to the committed copy, apart from
  node_modules path prefixes. The verifier's only route to pvm-app-attest.mjs is a non-literal import(), which esbuild does
  not follow.
- **The site:** nothing here is under site/ or served by it.
- **The web verifier bundle** (verifier/web/build.mjs) could not be built in this checkout, in either tree: the `buffer`
  package is missing from the shared node_modules. It reaches the pVM module only through the same non-literal import.

## What changes on main if this lands, and what does not
- **PVM_SERVING off (the default; nothing in the repository sets it, and production leaves it unset, enclave-5d below):**
  - api-relay.js does not even load pvm-serving.mjs (test: an OFF relay beside a deliberately BROKEN pvm-serving.mjs boots
    and serves);
  - `/x/<id>/pvm/*` is an ordinary `/x` path, with the same status, body, response headers and forwarded headers;
  - the hub issues no ABI/2 challenge, and no stream kind of the carrier is reachable.
- **Changes even with the switch off:**
  1. **tunnel.js `avfOn`** now also counts `METAL_AVF_PAD_CODE_HASHES` and the `PVM_CPU_CODE_HASHES` list.
     - A relay configured with only those lists now VERIFIES an AVF attach it used to refuse with 401.
     - Such a tunnel is never U7-eligible, so it gets no tenant traffic.
     - **Production today sets none of these** (enclave-5d, below), so on the live api relay this changes nothing. A later
       configuration change could make it matter.
  2. **pvm-app-attest.mjs loads at startup** (a static import). It is a pure module with no side effects at import.
  3. **The in-tree independent verifier** (verifier/index.mjs `verifyPvmAbi2`, verifier/pvm-evidence.mjs,
     verifier/pvm-proof-key.mjs) looks for `../relay/pvm-app-attest.mjs` when `ENCLAVE_PVM_MODULE` is unset. On main today
     it answers "unsupported". With this candidate, in-tree runs JUDGE pVM evidence with the module:
     - **48 of enclave-99's verifier tests** that skip on main now RUN, and pass, against this candidate's module. Among them
       are the device-evidence acceptance cases, the instance-binding and v3 captures, and the client-lifecycle reviews;
     - the bundled verifier is unchanged (above).
- **PVM_SERVING on (NOT proposed):** the carrier, exactly as RELAY-SERVING.md and U7-INTEGRATION.md (on the reviewed
  branch) state it:
  - exact raw POST routes only;
  - its own resolver;
  - the body only, and sandboxed answers;
  - U7's refusals for everything else.
  It needs `PVM_APP_IDS` and `PVM_APP_RUNTIME_IDS` too; without them every pVM route answers 503.
- **Pre-existing, not this candidate's:** `GOOGLE_ATTESTATION_ROOT_SHA256` is a mutable exported Map on main (rollout note 2
  of U7-INTEGRATION.md). test/fixtures/avf-lab-root-preload.mjs uses that seam, and only in a spawned test relay. The
  integration test asserts that nothing deployable references it.

## Validated on this candidate (source-only; no device, no chain, no deploy)
All of the following ran on 2026-09-25, at concurrency 2, in this worktree and in a main+U7 worktree at 4c8334cb, sharing
one node_modules.
- **The whole suite** (`node --test test/*.test.mjs`), compared test by test with main+U7:
  - **this candidate** (a6f9ecd7): 2,066 tests, 1,966 pass, 14 fail, 86 skipped;
  - **main+U7**: 2,037 tests, 1,888 pass, 14 fail, 135 skipped;
  - **no test that passes on main+U7 fails or skips here.** The 14 failures are the same tests on both. None is a relay or
    pVM test, and the candidate touches none of their sources:
    - ten are native C/C++ fixture tests of the shielded and pad code: seven fail to compile in this checkout (e.g. an
      implicit declaration in the pad receiver fixture), and three fail at run time;
    - four are bundle reproductions that need the `buffer` package, which is missing from the shared node_modules, or the
      real node_modules paths;
  - 29 new tests pass (the carrier's), and 48 of enclave-99's verifier tests go from skipped to passing (above).
- **The default is off, and OFF is inert** (test/api-relay-pvm-serving.test.mjs):
  - OFF, `/x/<id>/pvm/*` answers exactly as any `/x` path: the same status, body, response headers and forwarded headers;
  - an OFF relay beside a deliberately broken pvm-serving.mjs boots and serves, and an ON relay refuses to start.
- **Non-pVM routes are unchanged:** 17 named suites, 208 tests, 197 pass, 0 fail. The 11 skips are the egress end-to-end
  cases that need a patched wasmtime, as on main. The suites:
  - U7's own: relay-u7-eligible-routing, dns-relay-u7, certs, secrets, api-relay, fleet, tunnel;
  - the relay's: mcp, dns-relay, egress, relay-deploy-closure, deploy-us-west-egress;
  - the carrier's: api-relay-pvm-serving, pvm-runner-resolver, pvm-app-attest, pvm-u7-integration, pvm-carrier-hub.
- **The narrow verified-AVF carrier contract** (test/pvm-u7-integration.test.mjs: a SPAWNED real api-relay from this tree,
  a stub ledger, synthetic AVF phones bridging fake VMs, an eligible app host and a token tunnel), unchanged from 48c6efb3:
  - **authorized:** the bootstrap route before any lease; `/x/<D>/pvm/{evidence,sealed}` for the lease holder; an in-place
    re-attach with no tier;
  - **refused:** another holder; an eligible non-phone holder; an expired lease, and a lapse mid-session; a tunnel whose
    public URL is not the runner's; a token tunnel claiming avf; a refused attestation;
  - **the phone row gets nothing else:** app, control, WebSocket, and certificates and secrets get exactly U7's
    `403 host_ineligible`;
  - **the lab-root preload is test-only**, and its negative control holds.
- **The mutation harness** (test/mutate-pvm-serving.mjs) on this tree: the control passes, and all 42 mutations are caught
  by the test each names.
- **Reproducible inputs:**
  - web/vendor/build-hpke.sh rebuilds hpke-core-1.9.0.js and hpke-LICENSE.txt byte for byte;
  - the vendored node verifier rebuilds identical to the committed copy, apart from node_modules path prefixes (above).
- **Secret scans on 164e7279..HEAD:** .githooks/scan-crypto-keys.py `--range` is clean, and gitleaks with main's
  .gitleaks.toml finds no leaks (11 commits). No .gitleaks.toml or .githooks change is needed or made.
- **Not re-run:** the Pixel device and the local chain. The relay files are the ones the 48c6efb3 regression ran.

## Remaining prerequisites, in order
1. **U7 on main.** This candidate merges 18772bf7 itself. If U7 lands in a different form, the candidate is rebased onto it,
   and the carve-out is re-reviewed against that form.
2. **enclave-99's review of this candidate**: the inventory, the adapted test files (the verifier-integration change is to
   their own file), and the claim that the relay files are byte-identical to 48c6efb3.
3. **Production facts: ANSWERED by enclave-5d**, redacted (set or unset, and counts only), read-only over the documented
   relay-admin route, with no new access attempt.
   - **The api relay** is on `nan` (unit enclave-api-relay), read 2026-09-25T15:14:27Z:
     - its only environment file is /etc/nan-relay/api-relay.env, and the deployed unit is byte-identical to main's
       relay/systemd/enclave-api-relay.service (no inline Environment=);
     - **none of the nine is set:** `METAL_AVF_CODE_HASHES`, `METAL_AVF_PAD_CODE_HASHES`, `METAL_AVF_AUTHORITY_HASHES`,
       `PVM_CPU_CODE_HASHES`, `PVM_CPU_AUTHORITY_HASHES`, `PVM_CPU_MODELS`, `PVM_SERVING`, `PVM_APP_IDS`,
       `PVM_APP_RUNTIME_IDS`;
     - so the api relay admits no AVF attach today, and the `avfOn` change and the ABI/2 path are inert there.
   - **nan-relay**, read 2026-09-25T15:14:30Z: none of the nine in dns.env, egress-relay.env, tcp-relay.env, tcp6-relay.env
     or udp-relay.env.
   - **us-west: NOT checked** (no existing access route). Its egress relay imports none of the pVM files (above).
   - These are the facts as of that read. A deploy audit re-reads them at landing time.
4. **A landing decision with its own deploy audit.** A push to main that touches relay/** redeploys the api relay.
5. **Separately, if pVM serving is ever wanted in production**, each of these is its own decision and none is made here:
   - a production `PVM_SERVING`;
   - an app and runtime admission list;
   - a published runner build;
   - Base contracts.

## Limits (unchanged, and not claimed)
- **Tested on:** one Pixel 10, one app VM at a time, a local anvil chain and a lab relay.
- **Not tested:** a Pixel 11, several app VMs at once on one device, Base, and the production relay.
- **The device regression is not re-run for this candidate.** Its relay files are the ones that regression ran (48c6efb3),
  and there is no new reason to repeat it.
