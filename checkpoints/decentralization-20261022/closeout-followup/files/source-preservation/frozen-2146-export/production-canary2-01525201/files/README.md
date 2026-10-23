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

## 0. Transaction review fixes (ROOT-TRANSACTION-REVIEW, 2026-10-23)

Every fix below is source only. No production, chain, wallet or hardware action was taken.

1. **Cost accounting and the aggregate budget** (`driver/sender.mjs`, `driver/budget.mjs`).
   - **Per-update worst case** = gas × maxFee + **Base L1 data fee** + **operator fee**.
     - Gas = max estimate of both RPCs × 1.25, at most the step cap.
     - maxFee = 2 × base + max tip, at most the fee cap.
     - L1 data fee = `GasPriceOracle.getL1FeeUpperBound(argument)` (signed-size correction, ROOT-SIGNED-SIZE; the same
       as `custody-operator-fees-20261023` 7bf4c94).
       - The size is computed from the EXACT transaction: its real nonce at prepare (and again at send), gas, fees and
         calldata.
       - `argument = max(unsigned, signedMax − 68)`, where `signedMax` is the encoding with yParity 1 and r = s = 2^256−1.
         The oracle adds its own 68 bytes, so its size covers the largest signed form.
       - A smaller argument refuses (`l1_size`).
       - The first version sized a nonce-0 transaction. That undercounts as soon as the real nonce needs more RLP bytes.
       - Prepare records `encodedBytes` (unsigned, signedMax, oracle argument, 68).
     - Operator fee = `GasPriceOracle.getOperatorFee(gas limit)`, and `isIsthmus()` MUST be true.
       - Not Isthmus, a revert, or an RPC disagreement means the fee is undetermined, and the plan AND the send refuse
         (`operator_fee`). There is no zero claim.
       - `S0.chain`'s `fees.bounded` likewise requires Isthmus.
   - **These are bounds at the agreed block's oracle parameters, not a timeless guarantee.** L1 fee inputs and
     operator-fee parameters can change before inclusion. `send` re-reads them fresh and refuses if they no longer fit.
   - **Refusals.** If an oracle read fails, or a bound exceeds its pinned allowance (`fees.l1FeeWei`,
     `fees.operatorFeeWei`), the step REFUSES. Unaccounted cost is never allowed.
   - **Aggregate budget, plan level.** It covers every enabled spending step:
     - the custody updates;
     - the CLI deployment creates, lease-gas configure + deposit (deposit value included) and stops;
     - the USDC lease funding.

     If the whole plan's worst case exceeds `budget.totalWei` (or `budget.usdcUnits`), EVERY spending step is blocked.
   - **Aggregate budget, run level.** A spend is allowed only while spent (from receipts, conservative) + this worst case
     + the cleanup stops still owed ≤ `budget.totalWei`, AND the agreed balance covers this worst case plus that reserve.
     `S0.chain` requires the owner's balance to back the whole `budget.totalWei`.
   - **CLI steps: the allowance is NOT enforced on the CLI's own transactions.**
     - The existing CLI (deploy, lease-gas, stop) builds and sends its own requests.
     - The driver can only check the budget before (`gate`) and cost the receipts afterwards (`record`: gasUsed ×
       effectiveGasPrice + l1Fee + value + the operator-fee allowance). A step over its allowance FAILS the run, but only
       after the money is spent.
     - Root must therefore review and cap each actual CLI request before sending it manually: gas limit, fee fields, value
       and target. For example, use `lease-gas` unsigned/handoff output, and `deploy --chain-only` with explicit
       `--max-rate`/`--fund`.
     - A budget constant plus after-the-fact receipts is NOT a readiness claim for those steps.
   - **Numbers.** The owner holds 61654449641751 wei (19:59Z) and 189740 USDC units. With the example caps:

     | | worst case | fits `budget.totalWei` 5.5e13? |
     |---|---|---|
     | full matrix | 8.01e13 wei | NO |
     | profile A: everything except migration (the example's `cases.disabled: ["migration"]`) | 4.73e13 wei | yes (cleanup reserve 1.5e12 included) |
     | migration alone, run separately later with its own pins | ~3.3e13 + its share of fees | — |

     **Shortfall retained.**
     - The full requested matrix (8.01e13 wei worst case) does NOT fit the 6.165e13 wei balance.
     - The migration-disabled example is a budget-fitting profile, NOT completion of the requested lifecycle. Migration,
       old-copy clear and migration rotation stay untested until root funds them or runs them in a separate, separately
       budgeted plan.
     - No recharge is requested here.
2. **Durable intent before broadcast; ambiguous outcomes never re-signed.** `sender.mjs` is the reviewed operator-helper
   pattern narrowed to one custody update. It is not a general engine.
   - It uses exactly two RPCs (`sendRpcs`), one agreed block, the vault code hash, and a settled nonce (agreed =
     latest = pending on both).
   - `send` re-runs every check, signs the prepared fields, and writes the signed bytes, hash and nonce to a private
     0600 intent file (temp, fsync, exclusive link, dir fsync) BEFORE any broadcast. A failed write broadcasts nothing.
   - An intent file blocks any second signing or preparing of that step.
   - `resume` never signs:
     - it reconciles through both RPCs (agreeing receipt, 2 confirmations, the mined tx matches the intent);
     - `--rebroadcast` re-sends the SAME bytes only while the nonce is unused on both RPCs;
     - a nonce consumed by another transaction is a final `conflict`;
     - only final outcomes are journaled.
   - The step journal entry therefore follows a durable pre-broadcast intent, instead of being the only record written
     after the receipt.
3. **Recipient readiness is BLOCKED.**
   - Root's provenance: the measured metal0 control image (`dist-leasegas-deabf8f90`, manifest `c7cb436d…`, measurement
     `ed918e4b…`) has NO `CUSTODY_VAULT_V2`, so its supervisor cannot sign v2 custody auth.
   - `recipient.runner` resolves only from an `S0.root` record that names the activated control manifest sha (not in
     `KNOWN_LACKING_CONTROL_MANIFESTS`), `CUSTODY_VAULT_V2 = 0xE486`, and an evidence reference. Until D's restore is
     activated, every C1/C2 step stays blocked.
   - The public reads (`/availability` snp-guest-per-app, `claimEnabled`) show only that the runner is advertised.
   - **Lease gas.** It uses the EXISTING app-funded reserve path (`enclave --independent lease-gas configure/deposit`,
     reserve `0x12a3f873…`). This involves no operator gas and no new contract, and the metal0 7702 delegation is
     untouched.
4. **Value consumption: a GAP, plus a plan.**
   - hello-world (catalog v4; the current source is a WASIp3 fixed "Hello World!") reads no env. The release evidence
     here is the guest FRONT's lines: revision, name count, and the configSha256 gate. It does NOT show that an app
     consumed a value.
   - I did not find an approved per-app-tier app that exposes a value-derived output. I did not audit the whole catalog:
     on Sep-24 hello-world was the only approved wasi:http app for the tier.
   - `CANARY-APP-PLAN.md` specifies a narrowly scoped HASH-ONLY canary app (an HMAC over a client challenge, never the
     value or a reflection endpoint).
     - It is a plan only: not built, deployed or published.
     - It is FROZEN as of c4d96a11: M builds the proof app separately, and this repo does not change the plan.
5. **gitleaks ignore scope.**
   - `.gitleaksignore` holds ONE fingerprint, `pins.example.json:generic-api-key:45`: that file, that rule, that line.
     The line is the PUBLIC sha256 of `relay/secrets.js` at repo-r2 `ab589bf8`, and `test/plan.test.mjs` re-hashes every
     pinned file and asserts that line 45 is exactly that entry.
   - Any other file, rule or line is still reported. If the line moves, the finding reappears (it moved from 46 to 45 in
     this revision and was re-adjudicated).
   - `gitleaks git` fingerprints carry the commit and are NOT covered by this entry.

**ROOT-LEDGER-REVIEW (see `LEDGER-RECONCILIATION.md`).**
- The canary ledger is **`0xB1783B61…` (rev16d, the original vault's book entry)**, NOT the CLI's baked, retired
  `0xF9e71385…`. PREFLIGHT-CLI.md is corrected.
- CLI steps now require `S0.clipins` (the reconciled `cli-pins/canary-contract-pins.json`) and `record` checks every
  mined target.
- **No rev16d ABI discrepancy.**
- **The CLI hazards are default-mode silent fallback and unreconciled pins.** The tracked pins file and the reviewed
  profile name the MODIFIED vault 0x56b8.
- `proposals/cli-ledger-write-guard.patch` is not applied to `work/enclave`.

**ROOT-CLI-PREFLIGHT (see `PREFLIGHT-CLI.md`, computed by `tools/budget-matrix.mjs` in queue job c13).**
- **A 12 mwei fee cap does NOT fit the full matrix** into 5.5e13: 8.74e13 with the literal CLI constants, 9.74e13 with
  the CLI re-derived from gas. A fit needs maxFee ≤ 5.1 mwei, below 2 × base + tip at root's block (11 mwei). The
  shortfall stands.
- **The current CLI does not bound the canary's own transactions** (create/fund, lease-gas configure/deposit, stop). It
  caps maxFeePerGas only (`--max-fee-gwei`, default 5 gwei), allows gas up to 15M, and bounds no L1 or operator fee and
  no total.
- **Manual review path.** `PREFLIGHT-CLI.md` gives the exact calls, approval boundaries and the review path (handoff
  output + oracle bounds). None of these steps is marked ready.

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
- With every case enabled there are 9 updates (C1 revisions 0..6, C2 0..1). Disabling optional cases renumbers the
  expected revisions of the kept updates; a chain revision that differs refuses to prepare.
- No other function, contract, admin, book-owner or payout call exists in the driver.

**Gas, fees and budget** (pins; root re-reads the live numbers in `S0.chain` before anything is spent).
- **Gas caps:** create 900,000; rotate 300,000; rules/pause 250,000. Each prepare takes estimate × 1.25 within the cap.
- **Fee cap:** 0.01 gwei.
- **Allowances:** L1 data fee 3e11 wei and operator fee 1e11 wei per transaction. The oracle values must be within them
  (`fees.bounded`, then rechecked at every prepare and send).
- **CLI allowances per operation** (`budget.cliWei`): create 7e12, lease configure 2e12, lease deposit 1.5e12 plus the
  deposit value `leaseDepositWei` 8e12, and stop 1.5e12. USDC lease funding is 90000 units per deployment.
- **Global ceilings** (tx.mjs): 3M gas, 0.1 gwei.
- **Aggregate:** see §0.1.

## 3. How the driver bounds production actions

- **One command, at most one step.** Steps are ordered by `after` and gated by prerequisites and the aggregate budget. A
  blocked or out-of-order step refuses. A step is journaled once and never re-run.
- **Journal.** `runs/<label>/journal.jsonl` is append-only and hash-chained. It is bound to the pins hash and to each
  step's hash, and each step hash covers the learned deployment id. Deployment ids, live facts and spent costs come ONLY
  from verified journal entries.
- **Update:** `prepare` → `execute --confirm <prepared hash>` → (if unknown) `resume [--rebroadcast]`.
  - `prepare` builds the calldata with the pinned client code (no key, except to read the relay's values in the
    migration). It checks the pins (target, selector, the id inside the calldata, the calldata hash, caps), the
    aggregate gate, and the sender's priced plan. It writes `private/<label>/prepared-<step>.json` (0600) and prints the
    prepared hash.
  - `execute` re-checks all of it and sends through `sender.mjs` (§0.2).
- **CLI spending steps.**
  - `gate --step` runs before the CLI, and `record --obs {txHashes, [deploymentId], [usdcUnits]}` costs the receipts
    from both RPCs afterwards. Over the allowance or the aggregate is a `fail`, which stops the run.
  - The driver does NOT cap the CLI's actual requests: root reviews and caps each one before sending it (§0.1).
- **Relay and record steps** need `--confirm <step hash>`. Hardware and operator observations are judged only from the
  real front and custodian log lines, filtered to the canary id.
- **Secrets.**
  - Markers are `CANARY_<run>_<set>_<64 hex>`, in a 0600 O_EXCL file in 0700 `private/`.
  - The journal holds sha256 commitments only.
  - The owner key comes only from the env var NAMED in the pins, read at signing time.
  - Every marker, the key and the throwaway key are registered with an output guard.
  - Relay reads return names, rev and an equality verdict, never values.
- **Repo pin.** `checkRepo` requires the pinned HEAD, a clean tracked tree and every listed file hash before any
  networked command.
- **Public RPCs.** Reads use the pinned reader (majority of ≥ 3 public RPCs) and sends use 2 agreeing RPCs. Both are
  described as agreement of public endpoints, **not trustless**.

## 4. Root's run order (after review; every value public)

1. Copy `pins.example.json` to `private/pins.json`. Set:
   - `runLabel`;
   - `owner.reuseScope`;
   - `image` from `isolation/m4/expected-measurement.sh --pin` (`imageCandidateFromChain` is NOT used until copied);
   - `recipient.endpoint`;
   - `rpcs`/`sendRpcs`;
   - `fees`;
   - `budget` (`totalWei` ≤ the live balance; deposit and USDC from `lease-gas plan` and the runner's rate);
   - `cases.disabled`.
2. Run `plan` and review the blockers, the aggregate budget (`budget.fits`) and the disabled cases.
3. Run `read --step S0.chain` (including the fee bounds), `probe --step S0.custodian`, and `record --step S0.root`. The
   S0.root record must include the ACTIVATED control manifest sha + `CUSTODY_VAULT_V2` + an evidence reference.
   Then run `markers`.
4. For each CLI step (`D1.create`, `D1.leasegas`, `D1.stop`, …): `gate`, then run the existing CLI, then
   `record --obs {txHashes, deploymentId?, usdcUnits?}`. Then `read --step D1.check`.
5. For each update: `prepare` → review → `execute --confirm` → (`resume` while unknown). For each check: `read`. For
   each boot: `record --obs {frontLog, custodianLog, appAnswered}`.
6. Marker searches:
   - `needles --set <set>`;
   - counts only, over SSH stdin, on the relay and custodian hosts;
   - the id as the control;
   - `record --obs {counts, control, locations}`.
7. `read --step Z.final`.

## 5. Known current-image defects to report (gates stay ON; never disabled)

- **The recipient control image cannot sign v2 custody releases.** metal0's measured control image
  `dist-leasegas-deabf8f90` lacks `CUSTODY_VAULT_V2` (root provenance; the previous 2857356cd gsup had it). This is a
  regression that blocks every v2 release to apps on metal0.
- **Banned hosts.** The running 9d43e63 custodian has no platform host-ban check, so a banned host with a live lease can
  get a release (audit F7).
- **High-water marks and nonces are memory-only** (audit F4).
- **CLI migrate** clears the relay copy on one `/exists` call and never verifies the clear (audit F6). The driver adds the
  proof (`M.clear.proof`).
- **The clear proof covers the live relay store only.** Backups, snapshots, earlier hosts and process memory are listed,
  not cleared.
- **No owner-read on the running image** (F5).
- **Delivery evidence is indirect** (§0.4).

## 6. Limitations

- **Rollback (expected FAIL, `test/limitations.test.mjs`, against repo-r2 `startup-state.mjs`).** An OLDER valid sealed
  blob opens under the same identity: there is no monotonic anchor.
  - `evalRollback` returns `expected-fail`, never pass.
  - An old-secret refusal is labelled "chain revision check only; NOT sealed-state anti-replay".
- **Log formats.** The production front build (`d84fb52b` adopt list / CPU release 16c2999d) is not in this tree. The
  regexes follow repo-r2. A mismatch FAILS the step.
- **Untested against live endpoints.**
  - The live adapters in `cli.mjs` are thin and are not tested against live endpoints.
  - `sender.mjs` and `receiptCosts` are tested against a two-RPC fake Base, whose oracle answers whatever the test sets.
    - A fake oracle that passes is NOT production evidence of the live fee values.
    - The tests prove the sizing (real nonce, signed maximum, the 68-byte coverage), the refusals and the arithmetic only.
    - The oracle ABI (`getL1FeeUpperBound`, `isIsthmus`, `getOperatorFee`) is the OP-stack GasPriceOracle interface.
      If the live oracle lacks one of them, the read fails and the step refuses: it never proceeds unbounded.
  - The receipt cost adds the operator-fee ALLOWANCE (not the receipt's own operator fee fields), so the ledger can
    over-count but never under-count.
- **The CLI's own transactions are not bounded by the driver.** They are gated before and costed after; the run stops
  when one is over. Root must review and cap each actual request before sending it.
- **This is no evidence of decentralized custody.** The custody here is n = 1, t = 1, one chip and one operator.

## 7. Tests (queued, `q.sh`, 256 MiB lane; no network, chain, keys or VMs)

`test/run-tests.sh` runs:
- syntax checks;
- the pinned `update` selector and the example budget;
- all suites (`core`, `plan`, `prepare`, `net`, `assert`, `sender`, `limitations`, `cli`);
- 14 mutation controls (`test/mutants.sh`). Each disables one guard in a temp copy and the suite must fail:
  - the calldata id check;
  - SYNTHETIC acceptance;
  - the protected-policy constant;
  - the rollback pass;
  - the sender's balance + reserve gate;
  - the operator fee omitted;
  - L1 sizing with nonce 0;
  - L1 sizing below the signed maximum;
  - an undetermined operator fee treated as zero;
  - broadcast before the durable intent;
  - the cleanup reserve forgotten;
  - the aggregate budget ignored;
  - S0.root accepting the known-lacking control image;
  - relay value leakage.
- gitleaks;
- the source repo's crypto-key scanner on the staged tree.

**Result.** Queue job c17 (final staged tree), 256 MiB lane: EXIT 0.
- Tests: 49 pass, 0 fail, 1 TODO. The TODO is the rollback property, which fails as expected.
- Mutation controls: 17/17 killed (`grep -c '^mutant "' test/mutants.sh`).
- gitleaks: no leaks. Crypto-key scan: clean.
- Budget unchanged: profile A worst case 4.73e13 wei fits 5.5e13; the full matrix does NOT fit.

**gitleaks adjudications (all exact-scope).**
- `.gitleaksignore` holds two line fingerprints:
  - `pins.example.json` line 45: the public sha256 of `relay/secrets.js`;
  - `cli-pins/canary-contract-pins.json` line 12: the public original-vault address under the key `secretVaultV2`.
- `test/clipins.test.mjs` lines 24 and 32 carry inline `gitleaks:allow` comments for the same public addresses.
- Any other finding still fails.

**Earlier runs.**
- c7 had 7 failures: `fees.bounded` was not yet observable, and a step count assumed every case was enabled. Both were
  fixed in c8.
- c10 failed only because two mutant patterns still named the pre-rename `totalMaxWei`. Fixed in c11.
- Correction: the c9 handoff said 12/12 mutants. It was 11/11; the count had included the helper's definition line.
- The first handoff (7bcd501f) used a gas × fee-only cost cap, a post-receipt-only journal and a line-46 gitleaks
  fingerprint. All three are superseded by §0.
