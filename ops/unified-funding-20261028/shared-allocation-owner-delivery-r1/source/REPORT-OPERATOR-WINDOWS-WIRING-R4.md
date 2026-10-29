# Operator Windows wiring r4: explicit SYSTEM identity slice (SOURCE ONLY, AUTHORED, NOT RUN)

Status: source and tests written. **No test, build, shell, Windows, network, remote or wallet action ran.** Nothing in this
report is a pass count, a hash or a Windows qualification. SYSTEM operator effects remain **refused** (`CutoverUnqualified`).

## Supersession note (history kept as is)

Root's r2 review (`evidence/root-wiring-r2/ROOT-REVIEW.md`) records that the r2 author run timed out with no r2 report or
complete closure. No r3 report exists in this tree either. This r4 report is the current author statement. It does not
rewrite or replace R1 or any earlier report. The fixture header still points to an R2 report that was never written. The
r2 fixture change it describes (derived service SID, service-readable `CFG_SDDL`, `BASY_ONLY_SDDL` as a refusal) is
recorded here instead.

Baseline preserved: root's repaired 249-file tree and its reported 102-test result. Both of root's trust-file additions
(release manifest and migration evidence, plus their ancestors, in `trustPaths`) are unchanged. So are the chain
quarantine, the transport repairs and the bundles.

## Inputs used

- `evidence/target-identity/result.json`: task `\Enclave\Node` runs with principal `SYSTEM`, and the listener's owner SID
  is `S-1-5-18`. `effectiveNodeDir` is `"unknown"` and `qualification` is `false`. Task-to-process ancestry and exclusion
  are listed as not established.
- ROOT-REVIEW r2: the candidate only accepted NT SERVICE accounts. The real principal had to be verified, not changed to
  fit the candidate.

## Implemented slice

`control/windows/node/operator-effects-config.mjs` (additive):

- `SYSTEM_ACCOUNT = "NT AUTHORITY\SYSTEM"` and `SYSTEM_SID = "S-1-5-18"`.
- `launcherIdentity(l)` checks the launcher is exactly `{ kind: "scheduled-task", taskPath, taskName, specifiedBy: "local-machine-owner" }`:
  - `taskPath` is `\` or `\<folder>\…\`, with 1–4 folders and at most 200 characters.
  - Each folder and `taskName` is 1–64 characters from letters, digits, space, `_ . -`, with no trailing dot or space and
    no reserved device name.
  - Any bounded task the owner chooses is accepted. `\Enclave\Node` is one example, not a required name.
  - Nothing is approved by Enclave or any central service.
- `systemIdentity({ account, sid, launcher })`:
  - The account must be `NT AUTHORITY\SYSTEM`, matched case-insensitively and rendered in canonical form.
  - The SID must be exactly `S-1-5-18`.
  - The launcher is validated separately. The SID is never derived from the task.
  - Bad account or SID gives `BadProcessIdentity`; a bad launcher gives `BadLauncherIdentity`.
  - `serviceIdentity` is unchanged and still refuses SYSTEM in every spelling.
- `SYSTEM_CUTOVER_UNPROVEN`: continuous old-writer exclusion, the running process's effective NODE_DIR, and
  scheduled-task-to-process ancestry.
- `systemCutoverUnqualified(where)` builds the coded `CutoverUnqualified` error and attaches `unproven[]`.
- ACLs:
  - `stateAclProblem(sddl, S-1-5-18, …)` requires exactly two entries: SYSTEM full control and Administrators full
    control. It refuses a duplicate SYSTEM "service" entry, any third entry, a deny, an unprotected directory or a wrong
    owner.
  - For any other SID the three-entry NT SERVICE rule (service SID Read+Write `0x12019f`, no Delete) is unchanged.
  - `aclProblem` read evaluation for `S-1-5-18` counts grants to SYSTEM, Administrators, Everyone and Authenticated Users.
    The NT SERVICE token groups are unchanged.
  - Write, replace and broad-principal rules are not weakened. SYSTEM was already in `TRUSTED_PRINCIPALS`.
- Config `/2` (schema string unchanged) also accepts `instance { processAccount, processSid, launcher, nodeDir }`:
  - The NT SERVICE form and its bytes are identical to before.
  - Mixing the two forms is refused as `Malformed`.
  - The parsed SYSTEM instance carries `principalType: "local-system"` and no `serviceSid`.
  - `configBytes` renders the SYSTEM form in a fixed key order.
- `operatorEffectsForHost`: right after the pinned config is loaded and parsed, a `local-system` instance throws
  `CutoverUnqualified`. This happens before the NODE_DIR comparison, legacy reads, exclusion construction or any probe.
  The Host receives the existing REFUSING options, so Stop, Offline and read-only paths behave exactly as for any refused
  configuration.

`control/windows/node/install-operator-effects.mjs` (additive):

- New SYSTEM input form: `processAccount`, `processSid`, `launcherTaskPath` and `launcherTaskName` replace
  `serviceAccount` (migration keys optional as before). CLI flags: `--process-account`, `--process-sid`,
  `--launcher-task-path`, `--launcher-task-name`.
- The inputs are validated by `systemIdentity`; failures surface as `BadInput` with the inner code in the message.
- `preflight` refuses a valid SYSTEM binding with `CutoverUnqualified` right after input validation and the platform
  check. That is before `inspectInstall`, the release and ACL probes, and the attempt marker, state directory, journal,
  config or receipt.
- `apply` keeps `NotConfirmed` first, then reaches the same refusal.
- CLI error JSON includes `unproven[]`.

## What this slice deliberately does not do

- It makes no observation of the task, process, ancestry, effective NODE_DIR, writer exclusion, ownership tokens, process
  death or task mutation, and adds no transition machinery.
- No caller Boolean, environment variable, TEST key or input string lifts `CutoverUnqualified`. Tests pass such values
  and assert that the refusal still happens.
- The production account, privileges, task registration and machine environment are not changed.
- `createStateDirScript` still adds a service-SID entry. It cannot be reached for SYSTEM while the refusal stands. A
  two-entry SYSTEM creation script belongs to the later qualified cutover work.
- It does not depend on any central Enclave authorization. Local machine-owner authority (the owner pins the config bytes
  and names the task) is the only authority assumed.

## Authored tests (NOT RUN)

`test/windows-permit/ow-r4-system-identity.test.mjs`. External boundaries are labelled `TEST-ONLY-NOT-WINDOWS` fixtures;
no test executed.

- S1: a valid SYSTEM identity using the observed `\Enclave\Node`, a second non-Enclave owner task
  (`\Owner Tasks\Base\` / `operator-node 2`) and a root-folder task. The SID is the same regardless of the launcher.
  `serviceIdentity` still refuses SYSTEM.
- S2: wrong accounts (bare SYSTEM, LocalSystem, Local/NetworkService, Administrators, Users, Everyone, a domain user,
  NT SERVICE, a raw SID) and wrong SIDs are refused, as are 25 malformed or extended launcher shapes.
- S3: the two-entry SYSTEM state ACL is accepted. A duplicate SYSTEM entry, a service entry, broad entries, Users in
  place of Administrators, a narrowed SYSTEM entry, a deny, an unprotected DACL, an untrusted owner or wrong flags are
  refused.
- S4: SYSTEM reads via SYSTEM or Administrators are accepted, and a deny is honoured. Broad and non-trusted write or
  replace grants are still refused.
- S5: NT SERVICE retained: three-entry state ACL, the service still cannot write trust inputs, BA/SY-only stays
  unreadable for the service, and an NT SERVICE config with the SYSTEM ACL is refused.
- S6: the actual loader parses both SYSTEM launchers and round-trips them through `configBytes`.
- S7: 14 SYSTEM config refusals (mixed forms, non-canonical account, wrong SID, launcher faults, ACL faults).
- S8: the runtime seam refuses `CutoverUnqualified` with zero probes and no state artifact. The refusal is the same with
  a mismatched NODE_DIR, an unreadable legacy file, environment "qualified" flags and TEST Booleans. The actual
  `openOperatorEffects` refuses before any file access.
- S9: malformed SYSTEM configs refuse at the seam with their own codes. An NT SERVICE config run by a process reporting
  `S-1-5-18` is refused by the existing `ServiceIdentityMismatch` check before the storage probe.
- S10: SYSTEM plan and apply (with confirmation, including a TEST Boolean) refuse `CutoverUnqualified` with zero probes
  and nothing created. The base-form inputs refuse the same way.
- S11: 14 SYSTEM installer input refusals (`BadInput`), each with nothing probed or created.
- S12: the NT SERVICE plan is retained, and the SYSTEM CLI flags parse.

The default `ow-fixture` stays NT SERVICE. `fixture`, `installFixture` and `testRun` are unchanged, so the r1/root
assertions mean what they meant before. `installFixture` hashes the current sources when it runs, so the edited files
are pinned by whoever runs the tests. No new import edges were added to the operator closure.

## Unresolved, separate work

- A qualified SYSTEM cutover boundary: continuous old-writer exclusion, effective NODE_DIR and task-to-process ancestry.
- Native Windows execution, EXLOCK, effective-access ACLs, process-death observation and resource admission.
- Migration of legacy obligations.
- Every hash, test run and production decision belongs to the coordinator or root.
