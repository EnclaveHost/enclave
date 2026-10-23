# Custody v2 production canary driver (source only, root-run)

**Status.** Source, plan and unit tests only. Nothing was executed against production:
- no SSH, chain write, VM launch, relay call or custodian call;
- no key, real config or sealed state was read.

No hardware or production pass is claimed. Root executes every step.

**Scope** (root clarification 20:2x, `ROOT-FOLLOWUP.txt`): a BASELINE lifecycle canary of the CURRENT production custody
state.
- The original vault `0xE486…` and the existing committee `0x47742ae8…` (epoch 1, t = 1, one Enclave seat; custodian
  image 9d43e63, chain measurement `0x2530eda0…` = SNP `c8663742…`, endpoint `https://api.enclave.host/t/custody-metal0`).
- Exercised through brand-new dedicated hello-world deployments owned by the configured agent EOA
  `0x29479bf04ed889d46a7afb7f292b9bb26e12647c`.
- It certifies nothing about the corrected r2 candidate.
- Policy `0x4e62…` (the historical canary) is never touched: the plan refuses it as a target, and `Z.final` re-reads it.

## 1. Answers to root's questions

**Can a baseline full lifecycle run safely against the existing committee?** Yes, for create, release, rotate,
attestation-gated refusals, chain-side and relay refusals, and relay → v2 migration with old-copy-clear proof. These
conditions are prerequisites in the plan, and each fails closed when unresolved:
- **Reuse scope.** Root states the reuse scope for 0x29479 in the pins (`owner.reuseScope`). Until then every step is
  BLOCKED, including the reads.
- **Recipient guest.** It is a REAL SNP guest launched by the recipient runner's guestd under a live lease. There is no
  synthetic quote and no standalone launch.
  - The custodian requires the release request to come from the lease holder's registered operator (`not_lease_holder`,
    `operator_sig`).
  - That runner's measured supervisor must sign v2 custody auth for `0xE486` (`CUSTODY_VAULT_V2`; `supervisor.js`
    2614-2632). Root inventory: `S0.root`.
- **One new guest at a time.** hello-world boots with 1024 MiB, 1 vCPU, and a unit cap of +768 MiB
  (`isolation/m4/guestd/pool.go` 41-43). It runs beside the protected production QEMUs.
  - C1 is stopped (`D1.stop`) before C2 is created.
  - Every hardware step requires `hw.oneGuest`, which root confirms in `S0.root`.
  - This stays within the existing ONE-new-guest (≤ 3072 MiB) exception.
- **Billing.** See "Bill/lease prerequisites" below. Never a payout declaration on metal0.

**Exact prior creation and recipient test (records, not live truth).**
- **The Oct-14 v2 "hardware verification" has NO receipt** (audit F9). The strings appear only in
  `docs/security/secret-custody-v2.md` 29-36.
- **Policy 0x4e62.** The canary 0x4e62 was CREATED on 2026-09-24 by 0x29479, with no USDC moved (gas only):
  - `test/fixtures/verifier/linux-canary-2026-09-24/` in history-checkpoint-transport/tree;
  - `create` tx `0x6ceaeb0b…4c10`, gasUsed 411747; public; cpuMilli 100;
  - envelope `{"isolation":{"require":"snp-guest-per-app"}}`;
  - app `hello-world:1.0.4` = `catalog://0x5356e8bd…16ed/4`;
  - rate 0, because 0x29479 called `setPayoutWallet` on the per-app node `metal-iso0` (registry id `0xf7a1256d…c745`;
    tx `0x7ac65fa2…0fd0d`, gasUsed 47796).
- **Current rules and lease (block 52869788, `custody-owner-migration/canary/canary-plan-final-candidate.json`).**
  - The rules admit measurement `9709716c…d230`, runtimeId `297b6c2c…02f8`, appId `9c3d10f1…0d45`.
  - The doc's `ab852fe5…` does not match these rules. Unresolved; recorded, not used.
  - The last lease was on metal0 (runner `0x4dde6d1b…`), active but not live.
- **No CLI receipt exists for any v2 `update`.**

**Bill/lease prerequisites (`recipient.billing`, `recipient.runner`).**
- **metal0 cannot give 0x29479 a rate-0 lease, and nothing here may try.** metal0's registry payout wallet is the Enclave
  wallet `0x0b2d…` (`payoutIsEnclaveOwner: true`, live-custody.json block 52849851). The vault's Enclave seat is decided
  by that payout.
- **Option (a): a paid lease on the runner.** It must fit the owner's 0.189740 USDC at that runner's rate for the canary
  window. Root reads the rate.
- **Option (b): rate 0 on a runner whose payout wallet is ALREADY 0x29479** (metal-iso0 on Sep-24), if that node is live,
  serves `snp-guest-per-app`, holds an active registry entry, and its supervisor carries `CUSTODY_VAULT_V2`. These are
  unknown today and are root's `S0.root` facts.
- **Deployment creation** uses the EXISTING CLI from the owner wallet (`D1.create`/`D2.create`). A deployment id can
  only come from the ledger: the vault pins `beneficialOwnerOf(id)` at the first `update`. No fictional appID is
  possible or attempted.

**Real release on a NEW r2 committee within the current constraint: NOT possible.**
- A release needs the custodian and the recipient running at the same time. A dedicated r2 canary custodian (3072 MiB)
  plus a recipient (1024 MiB) is TWO new guests.
- In addition, the metal0 owner enrollment for the new committee is blocked (operator gas; the 7702 executor has no
  payable receive).
- So track N (outage, timeout, restart, rollback on a dedicated committee) is listed and BLOCKED by `trackN.committee`
  and `trackN.memory`. Those resolve only from a NEW reviewed pins set (`approvals.*.reviewedPlan`), never from an
  observation of this run.
- Alternatives:
  - **(1)** Root reviews a two-guest exception: custodian 3072 + recipient 1024 + unit overhead, sequential with
    everything else.
  - **(2)** Accept the r2 quote-only and the startup-recovery hardware evidence (`20261023T201449Z`) plus this baseline,
    until rollout.
  - **(3)** An outage of the SHARED custodian, only with every consumer's consent (`O.shared`, blocked by default).
    Never a rollback on it.

## 2. Case matrix (`node driver/cli.mjs plan --pins pins.json` lists every step with its hash)

| case | steps | evidence that decides it |
|---|---|---|
| inventory | `S0.chain` read · `S0.custodian` probe · `S0.root` operator · `S1.markers` local | vault code hash `0x4b949b37…716b`; committee epoch/t/W and machine; 0x4e62 snapshot; owner balance and nonce agreed by every RPC; `/v2/custody/info` encKey = chain |
| create (C1) | `D1.create` (CLI) · `D1.check` · `C1.create` mutation · `C1.create.check` | ledger owner = owner, policyRev 0, live lease on the recipient, `/exists` false → `update` → policyRev 1, secretRev 1, bundle/rules keccak = prepared, `/exists` custody:true |
| release | `C1.release.1` hardware · `C1.markers.1` | front line `secrets revision 1 from a v2 threshold of 1 over 1`; custodian `release <C1> … OK` with the pinned image measurement prefix, without `SYNTHETIC roots`; no refusal; app answered; marker counts 0 plus a working control |
| rotate | `C1.rotate` · `.check` · `C1.release.2` · `C1.markers.2` | secretRev 2; front revision 2; rev1 and rev2 markers absent |
| wrong owner | `N.sim.notOwner` (eth_call only) | reverts `NotOwner` from a key-less decoy sender |
| stale policy | `N.sim.staleRev` (eth_call) · `N.probe.stale` | `StaleRevision` on chain. Live custodian: `stale_revision`, `wrong_committee`, `stale_epoch` (409), with no partial in any answer |
| nonce / replay | `N.probe.nonce` | burnt nonce → `bad_challenge`; nonce left 125 s → `bad_challenge`; no partial. A non-evidence body is sent, and attestation is NOT claimed |
| wrong image | `N.image.rules` · `N.image.boot` | real boot: custodian `REFUSED evidence_refused …measurement…`; front custody error; app not started |
| wrong runtime | `N.runtime.rules` · `.boot` | `REFUSED runtime_not_admitted` |
| wrong app | `N.app.rules` · `.boot` | `REFUSED evidence_refused` (app id) |
| paused | `N.pause` · `.boot` · `C1.restore` · `C1.release.3` | `REFUSED paused`; then revision 2 released again |
| relay refusals | `N.relay` | owner-signed legacy set → 409 `custody_held`; `/get` signed by a throwaway in-memory key → 401/403 with no names; `/exists` custody:true |
| migration (legacy relay-held C2 → v2) | `D1.stop` · `D2.create` · `D2.check` · `M.legacy.set` · `M.legacy.check` · `M.migrate` · `M.clear` · `M.clear.proof` · `M.release` · `M.rotate` · `M.release.2` · `M.markers` · `D2.stop` | relay values proven equal to the c2-legacy markers by commitment; update; clear only after custody:true; **clear proof** = owner `/get` names `[]` + root `has(C2)=false` + marker search 0 with control + R6 retention LISTED; release; ROTATE (the old values were relay plaintext) |
| v1-vault migration | not generated | There is no v1→v2 tool: `cli/custody.mjs` migrate moves relay → v1, and `rewrap.mjs` is v2→v2. A v1-vault canary is owner re-entry into the separate DO-custodian system: a separately reviewed plan |
| outage / timeout / restart / rollback | `O.stopped` · `O.timeout` · `O.restart` · `O.rollback` | BLOCKED (track N). `O.rollback` is a declared limitation: EXPECTED-FAIL |
| shared outage | `O.shared` | BLOCKED unless every consumer consents |
| end | `Z.final` | 0x4e62 unchanged; committee unchanged; owner nonce delta vs the transactions journaled (the CLI's create/stop transactions are counted separately) |

**Exact contract call.** Every mutation is
`EnclaveSecretVaultV2(0xE486).update(bytes32 id, (uint64 expectPolicyRev, bool setPolicy, bytes32 committeeId, bool paused, bytes rules, bool setBundle, bytes bundle, bool clear))`.
- It is built only by the pinned `custody/v2/owner.mjs` `makeUpdateV2` / `buildBundleV2` and `custody/rules.mjs`
  `validateRules` (repo-r2 `ab589bf8`, file hashes in `pins.example.json`).
- Its selector is `0xe4373411`, printed by the test job from the pinned ABI.
- There are 9 mutations, and their planned `expectPolicyRev` values are C1 0..6 and C2 0..1. A mismatch refuses to
  prepare.
- No other function, contract, admin, book-owner or payout call exists in the driver.

**Gas and budget.**
- Caps:
  - create 1,200,000 gas;
  - rotate 600,000;
  - rules/pause 500,000;
  - pinned fee ceiling 0.02 gwei;
  - per-transaction cost cap = gas cap × ceiling (create 2.4e13 wei).
- Global ceilings: 3M gas, 0.1 gwei, 3e14 wei.
- Worst case for all 9 at the ceiling is 1.22e14 wei, which is ABOVE the owner's last public balance of 6.165e13 wei
  (19:59Z, block 52998091). The two CLI deployment creates (~411,747 gas each) and stops come on top.
- **Expected spend** at a realistic Base price (~0.005–0.01 gwei) is ~2–4e13 wei, so it should fit. No funding is
  requested.
- **Balance gate.** Every execute refuses unless the live balance ≥ that step's cost cap, and the plan says where it
  would stop. If a step is refused for balance, the run stops there and root decides.

## 3. How the driver bounds production actions

- **One command, at most one step.** Steps are ordered by `after` and gated by prerequisites. A blocked or out-of-order
  step refuses. A step is journaled once and never re-run.
- **Journal.** `runs/<label>/journal.jsonl` is append-only and hash-chained. It is bound to the pins hash and to each
  step's hash, and each step hash covers the learned deployment id. Deployment ids and live facts come ONLY from
  verified journal entries.
- **Mutation:** `prepare` → `execute --confirm <prepared hash>`.
  - `prepare` reads the chain at an agreed block and builds the calldata with the pinned code. It writes
    `private/<label>/prepared-<step>.json` (O_EXCL, 0600) and prints the prepared hash.
  - `execute` re-checks:
    - target and selector;
    - the deployment id inside the calldata;
    - the calldata hash, chain, zero value and sender;
    - gas, fee and cost caps;
    - balance and nonce.
  - It simulates first, refuses when the estimate exceeds the cap, and sends with gas = cap.
  - It waits at most 120 s and never retries. A missing receipt is recorded as `aborted` (UNKNOWN).
- **Relay and record steps** need `--confirm <step hash>`. Hardware and operator observations are judged only from the
  real front and custodian log lines, filtered to the canary id.
- **Secrets.**
  - Markers are `CANARY_<run>_<set>_<64 hex>`, in a 0600 O_EXCL file in 0700 `private/`.
  - The journal holds sha256 commitments only.
  - The owner key comes only from the env var NAMED in the pins.
  - Every marker, the key and the throwaway key are registered with an output guard. It refuses stdout or journal
    content holding any of their encodings, or fields named like keys, plaintext, env, report or auxblob.
  - Relay reads return names, rev and an equality verdict, never values.
- **Repo pin.** `checkRepo` requires the pinned HEAD, a clean tracked tree and every listed file hash before any
  networked command.
- **Public RPCs.** Reads use the pinned reader (`createChainReaderV2`, 2 confirmations, majority of ≥ 3 public RPCs) and
  are described as agreement of public endpoints, **not trustless**.

## 4. Root's run order (after review; every value public)

1. Copy `pins.example.json` to `private/pins.json` and set:
   - `runLabel`;
   - `owner.reuseScope` (statedBy, at, `onlyPlanCreatedDeployments: true`);
   - `image` from `isolation/m4/expected-measurement.sh --pin` for the runner's CURRENT domain release (the
     chain-derived candidate is in `imageCandidateFromChain` and is NOT used until copied);
   - `recipient.endpoint`;
   - `rpcs`/`sendRpc`;
   - `fees`.
2. `node driver/cli.mjs plan --pins private/pins.json` and review the blockers and budget.
3. `read --step S0.chain`; `probe --step S0.custodian`; `record --step S0.root --obs <public facts> --confirm <hash>`;
   `markers --step S1.markers`.
4. Run `D1.create` with the existing CLI (`ENCLAVE_KEY` from the owner wallet), then
   `record --step D1.create --obs {deploymentId, createTx, gasUsed} --confirm <hash>`, then `read --step D1.check`.
5. For each mutation: `prepare` → review the summary → `execute --confirm`. For each check: `read`. For each boot: root
   (re)starts the guest, saves the guest-front and custodian logs for the window, and runs
   `record --obs {frontLog, custodianLog, appAnswered}`.
6. Marker searches:
   - `needles --set <set>` writes `private/<label>/needles-*.txt`;
   - root pipes it over SSH stdin to `grep -rcFf /dev/stdin <paths>` on the relay and custodian hosts (counts only);
   - root also searches for the id as the control;
   - `record --obs {counts, control, locations}`.
7. `read --step Z.final`.

## 5. Known current-image defects to report (gates stay ON; never disabled)

- **Banned hosts.** The running 9d43e63 custodian has no platform host-ban check, so a banned host with a live lease can
  get a release (audit F7). No canary step depends on it.
- **High-water marks and nonces are memory-only.** Restart protection restarts from the next read (audit F4).
- **CLI migrate.** It clears the relay copy only if one `/exists` call answers custody:true, and never verifies the clear
  (no `/get` names-[] check). The driver adds that proof (`M.clear.proof`). The CLI path still has the race (audit F6).
- **The clear proof covers the live relay store only.** Backups, snapshots, earlier hosts and process memory are listed
  (R6), not cleared.
- **No owner-read on the running image.** Owner-read routes are not tunnelled (F5).
- **Delivery evidence is indirect.** It is the revision, name count and configSha256 binding. No canary app proves value
  equality (audit §5); an HMAC canary app would be new code and is not built here.

## 6. Limitations

- **Rollback (expected FAIL, `test/limitations.test.mjs`, run against repo-r2 `startup-state.mjs`).** An OLDER valid
  sealed blob opens under the same identity: there is no monotonic anchor (spec 176-181; the host keeps 20 blobs).
  - The `todo` test is the missing property, and fails as expected.
  - `evalRollback` returns `expected-fail` and can never return pass.
  - A refusal of an old SECRET revision is labelled "chain revision check only; NOT sealed-state anti-replay".
- **Log formats.** The front build that serves production (`d84fb52b`, branch custody/front-prod) is not in this tree. The
  regexes follow repo-r2 `front/custody.go` 290 and the 9d43e63 custodian log lines, and root confirms them on the first
  real line. A mismatch FAILS the step; it is never assumed.
- **Untested network paths.** The live adapters in `cli.mjs` (reader, viem clients, relay and custodian fetch) are thin
  and are not tested against live endpoints. The modules they call are unit-tested with fakes. The `prepare` test uses
  the real pinned client code with the secp256k1 generator as Y: an encoding check, not a release.
- **Deployment create/stop gas is not bounded by the driver.** Those steps use the existing CLI (operator steps) and
  record their transactions.
- **This is no evidence of decentralized custody.** The custody here is n = 1, t = 1, one chip and one operator. Its
  protection is subject to the SEV-SNP, attestation and software assumptions.

## 7. Tests (queued, `q.sh`, 256 MiB lane; no network, chain, keys or VMs)

`test/run-tests.sh` runs:
- syntax (`node --check`, `bash -n`);
- the pinned `update` selector and the example budget;
- all suites (`core`, `plan`, `prepare`, `net`, `assert`, `limitations`, `cli`);
- 6 mutation controls (`test/mutants.sh`). Each disables one guard in a temp copy and the suite must fail:
  - the calldata id check;
  - SYNTHETIC acceptance;
  - the 0x4e62 refusal;
  - the rollback pass;
  - the balance gate;
  - relay value leakage.
- gitleaks;
- the source repo's crypto-key scanner on the staged tree.

**gitleaks.** The only finding is adjudicated in `.gitleaksignore`: `pins.example.json` line 46 is the PUBLIC sha256 pin of
the public file `relay/secrets.js`, flagged as `generic-api-key` because the key name contains "secrets".

**Earlier runs.**
- c4 found that a mutant removing only the first of two redundant 0x4e62 guards survived. The mutant now changes the
  constant itself, and the test uses the literal id.
- c4/c5 found the gitleaks false positive above.

**Result.** Queue job c6, 256 MiB lane: EXIT 0, peak 143 MiB.
- Tests: 35 pass, 0 fail, 1 TODO. The TODO is the rollback property, which fails as expected: "Missing expected
  rejection".
- Mutation controls: 6/6 killed.
- gitleaks: no leaks. Crypto-key scan: clean.
- Update selector: `0xe4373411`. Example budget: worstCase 1.22e14 wei, largest step 2.4e13 wei.
