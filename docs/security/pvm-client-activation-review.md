# Installed pVM client: activation of a staged update (independent design review, 2026-09-24)

Lab only. Branch `research/independent-verifier`. Reviewed against the pVM owner's client 0.2.1 (e7a2badc,
`shielded/anchor/avf/client/`), whose design text says: *a start must run the staged file only when `pvm-client staged`
reports `bytesMatch: true`; otherwise it stays on the running version and says so. The lab has no launcher; this is the
rule a launcher must keep.* This review states what activation must guarantee, records the design agreed with the owner
before implementation, and defines the acceptance tests this session owns (`test/verifier-pvm-client-activation.test.mjs`).
The owner implements (planned as client 0.3.0); this session never touches the implementation.

## 0. Summary

`update` verifies a signed, countersigned manifest, publishes the bytes immutably under
`pvm-client-<version>-<sha256>.mjs` and commits `staged = {version, sha256, file, sourceCommit}`. Nothing runs them.
Today a client starts as `node pvm-client.mjs ...`: whatever the path holds at that moment runs. The gap is the step
from "staged and verified" to "these exact bytes are what executes", without a check-then-reopen race, without moving
any floor, with defined behaviour when the active bytes are wrong, missing or crash, and with rejected bytes never
executing. Measured on this machine: Node 22 runs a module from stdin (`node --input-type=module -`) with top-level
await, and the pinned 0.2.1 client runs that way, but then `process.argv[1]` is `-` and its default install directory
becomes `.`: a launcher must pass the directories explicitly.

Two proposals crossed on 2026-09-24: this session's (a separate launcher artifact with the base hash embedded, no state
write, a per-launch `--activate-staged` flag, fallback to the base on an integrity refusal) and the owner's, which is
adopted: the installed artifact IS the launcher and the only root of code trust, activation is an explicit command that
commits a monotonic `active` record, `run` alone delegates to the active version by handing its verified bytes over
stdin, and a missing or tampered active file refuses with no fallback. The owner's design is stronger on the two points
where they differ: a forced downgrade vector (refuse the staged bytes and the base runs) is worse than a denial that
names its repair, and an explicit `activate` with a committed record beats a flag every launch.

## 1. The gap, precisely

- `pvm-client staged` hashes the staged file by path and reports `bytesMatch`. Running `node <path>` afterwards reads
  the file a second time: publication is immutable (a link never replaces a file), but the install directory is
  writable by the user, so anything with the user's rights can `rm` and recreate the name between the reads.
- The base client's bytes are anchored nowhere: `initialState` records key fingerprints and a serial floor, not an
  artifact hash. Whatever the installed file holds runs. That is the root of code trust, and it stays out of band.
- The state knows what is staged, not what runs. The running bytes' own `CLIENT_VERSION` is the truth about what runs.
- The MV3 extension has no activation path: Chrome loads the unpacked directory and an extension may not load code it
  fetched. Its `update` can stage, never activate. A property, not a gap, kept explicit.

## 2. Trust and threat model

Trusted: the user's account (and so the state directory), the operating system, the Node binary, and the initially
installed bytes as delivered out of band. Not trusted: anything fetched (manifests, artifacts, policies, evidence), the
install directory's contents after installation (a concurrent stager, a crashed one, another program with the user's
rights), and timing. Activation and delegation must be correct against a writer that can replace any file in the
install directory at any moment, against several launches at once, and against an update or a policy commit running at
the same time.

## 3. Requirements (this session's, kept as the acceptance criteria)

R1. **Exact bytes.** The bytes executed are the bytes hashed, in one read, handed to the runtime over a pipe only the
    launcher writes. No path is reopened between hashing and execution.
R2. **Digest and marker.** Delegation and activation require sha256(bytes) equal to the committed record and the first
    line to start with `/*! enclave-pvm-client <version> ` for the committed version.
R3. **Root of code trust stays installed.** The bytes that verify, stage and activate code are always the installed
    ones; a newer version runs only `run`. Changing the root means reinstalling out of band. (Trade-off recorded: a
    defect in the installed staging verifier is fixed only by reinstall.)
R4. **Monotonic.** `active.version` only grows, `active <= staged`, no rollback command; every writer spreads the
    newest state so a policy commit or a key rotation never drops `active`, and activation never drops a serial, a key
    or the staged record. `run` writes nothing.
R5. **Explicit activation.** `update` never activates. Only `activate` does, and only what is staged and strictly newer
    than max(active, the installed version). Fetched code never runs unattended.
R6. **Refusal runs nothing rejected.** A staged file that is missing or does not match is never executed, not even for
    a start check. An active file that is missing or does not match makes `run` refuse (step `launch`, exit 2) with
    NO fallback to the installed version's own `run`: a forced downgrade is worse than a denial. The refusal names the
    expected record and what was found, and the repair path exists (remove the wrong file; `update` with the same
    artifact re-publishes it, idempotently).
R7. **Crash is not a reason to fall back.** A delegated child's exit code passes through; a signal death is reported
    as an error with exit 2 and no `sent: false` claim (the child may have sent); never a retry, never the installed
    version's `run` after a child ended.
R8. **Concurrency.** Two activators: one activates, the other is idempotent or refuses on the newest state; activation
    against staging a newer version, and against a policy commit or rotation, in both orders, loses no field; a file
    swapped while activating is caught by the commit re-check or by the next `run`, never executed.
R9. **One hop.** A delegated child runs itself whatever the state says when it reads it; a marker from the launcher
    makes that unconditional.
R10. **Explicit directories.** Under stdin the child's `process.argv[1]` is not a path; the launcher passes the resolved
    `--state` and `--install-dir`, and no command derives a directory from a non-path `argv[1]`.
R11. **Scrubbed start check.** The start check (verified bytes run with `version`) runs with `NODE_OPTIONS` removed,
    no `--state`, and the configuration directories pointed at an empty scratch directory; exactly the version line on
    stdout and exit 0 within a timeout.
R12. **Observable.** `activate` prints one JSON object with the outcome; `state` shows `active`; the child's result
    carries its own `clientVersion`; refusals name their step.

## 4. Agreed design (the owner's proposal of 2026-09-24, with this session's asks folded in)

- **Roles.** The installed artifact runs `install`, `state`, `staged`, `update`, `activate` and `version` itself; only
  `run` executes the active version.
- **State.** New field `active = {version, sha256, file, sourceCommit}`, null at install, monotonic, `active <= staged`;
  `staged` kept. No rollback command.
- **`activate [--state D] [--install-dir D]`.** On the newest state: `staged` must exist and be newer than max(active,
  the installed version); the staged record already active is idempotent (`already`). The staged file is read once;
  sha256 and version line must match the record, else refused and nothing runs. Start check: the in-memory bytes on
  stdin of `node --input-type=module -` with the argument `version`, `NODE_OPTIONS` removed, 30 s timeout, must exit 0
  and print the version line for `staged.version` (ask 3: scrubbed configuration directories, no `--state`). Commit
  through the store's compare-and-swap, re-decided on the newest state: the staged record must still be the one
  verified, `active` must still be older, then `{...newest, active}` is committed so a concurrent rotation or policy
  survives. Output `{"activate": {ok: true, version, sha256, gen, already?}}` exit 0, or `{ok: false, reasons}` exit 1
  (ask 4: the reason names its step).
- **`run`** when `active.version` is newer than the installed version: the active file is read once, sha256 and version
  line verified, the bytes handed over stdin with the same arguments (ask 2: plus the resolved `--state` and
  `--install-dir`; ask 1: a one-hop marker so the child never delegates). stdout, stderr and the exit code pass
  through. Missing or mismatched bytes: `{"result": {step: "launch", refused, sent: false}}`, exit 2, no fallback (ask
  4: expected record and what was found). A child killed by a signal or that cannot spawn: `{"error"}`, exit 2, no
  retry, no fallback. If `active.version` is not newer (a newer artifact reinstalled out of band over the same state)
  the installed version runs itself.
- **Failure and crash.** A crash before the activation commit activates nothing; after it, the new version is active. A
  failed start check is refused with `staged` kept and `active` unchanged. A failed start at run time fails closed and
  is reported. Repairs: a missing active file is re-published by `update` with the same artifact (idempotent); a
  tampered file is removed by the user first (publication never overwrites).

## 5. Failure, crash and concurrent activation: what is checked

| situation | agreed behaviour | acceptance check (this session) |
|---|---|---|
| staged file replaced before `activate` | refused; not executed, not even for the start check | the planted canary's token never posts; `active` null |
| start check fails (wrong version line or non-zero exit) | refused; `active` unchanged, `staged` kept | refusal names the start check; state unchanged |
| active file replaced after activation | `run` refused at `launch`, exit 2, no fallback | planted token never posts; no launcher-own result line; then the repair path |
| active file missing | `run` refused; `update` same artifact re-publishes; `run` works | as above |
| delegated child exits non-zero or dies by signal | code passed through; signal as `{"error"}` exit 2; no fallback | launcher exit 7; `error` line and exit 2 on self-kill; no second canary post |
| two activators at once | one activates, the other idempotent on the newest state | both exit 0; one generation added; `active` equals `staged` |
| activate, then stage newer (and the reverse) | `run` uses `active`, never `staged`; the next `activate` moves forward | the token that posts is the active one in each step |
| activation and a policy commit or rotation, both orders | neither loses the other's fields | serial, keys and `active` all present afterwards |
| `run` while the file is swapped (stress) | either the active bytes ran or a refusal; never the swapped bytes | swapped token never posts across the loop (evidence, not proof) |
| any `run` | writes nothing | state generation and directory listing unchanged |

## 6. Explicit limits (stated, not solved here)

- **Initial installation and the root of code trust.** How the user obtains and verifies the first bytes and the two
  key fingerprints is out of band (a reproducible build the user rebuilds, or a publisher-signed hash the user checks).
  The lab records fingerprints at `install`; it does not solve first contact, and a replaced installed artifact is a
  replaced root.
- **Production key distribution.** Lab Ed25519 keys are made per run; production needs a Sigstore bundle under the
  release workflow's identity for manifests and a distribution path for the policy key's fingerprint. Nothing on this
  branch signs with production keys; nothing is merged or deployed.
- **Whole-machine power loss.** The published file and the state are fsynced by design; nothing here cuts power, so
  persistence across power loss is not proven (as for the persistence suites).
- **The runtime.** The Node binary and the OS are trusted; `NODE_OPTIONS` is scrubbed for children, nothing more.
- **The extension** stages and cannot activate; its code is what Chrome loaded.
- **The staging verifier is frozen** at the installed version (R3): a defect there needs a reinstall.
- **A delegated child reads its program from stdin**, so it has no interactive standard input; this client takes
  arguments only.

## 7. Independent acceptance tests (this session's, black-box)

`test/verifier-pvm-client-activation.test.mjs` (`npm run test:client-activation`), against `ENCLAVE_PVM_LAUNCHER` (the
pinned installed artifact with `activate`, from 0.3.0 on) with lab keys and the lab carrier of
`test/helpers/pvm-lab.mjs`. Staged artifacts are **canaries**: valid, lab-signed artifacts whose first line is the
version marker and whose body, whenever it executes, posts its embedded token, the command, `process.argv`,
`import.meta.url`, `process.cwd()`, `NODE_OPTIONS` and the one-hop marker to the lab, answers `version` correctly (or
wrongly, for the start-check fixture) and on `run` exits 0, exits 7 or kills itself. A canary that must never run
carries its own token: "never posted" is the evidence that rejected bytes did not execute. Lab versions are chosen
above the installed artifact's own version at run time. The suite skips without the launcher and joins the strict
command once the owner's artifact is pinned and reproduced. It is written from the agreed interface, not from the
implementation, and was not run against any implementation when written.

**Results against 0.3.0 (owner's 0f4c79fd, 2026-09-24).** The two output hashes and every source hash the owner sent
were recomputed here from the git objects and matched (`pvm-client.mjs`
`fad5ba229c5dbbb339aa6d3d505e31c6a07eaaabadbe2431533cf882fb0f6aa4`, 137180 bytes; `pvm-client-ext.zip`
`09efc6fc34292d39a0ebf3d677d075985537182f9032b2d09e227ac18808c140`, 128994 bytes; `src/activate.js`
`16289f02…`); the pins `pvm-client-dist` and `pvm-client-src` and the artifact record moved there, and both artifacts
reproduced under the strict command. First run of this harness against any implementation: two harness defects and no
defect in the owner's code. Both harness defects were the same mistake, a synchronous spawn of a command that talks to
the lab (the manifest fetch of `update`, the start-check post of `activate`), which starves the lab server hosted by
the blocked test process; every such command is now driven asynchronously. Per case, all pass:

| case | observed on 0.3.0 |
|---|---|
| activate | `ok`, the staged version and digest; `state.active` equals the staged record (version, digest, file) with `size`; one generation added; the start check executed the canary exactly once with `version`, `import.meta.url` not a path, `NODE_OPTIONS` absent, HOME, `XDG_CONFIG_HOME` and cwd one scratch directory that no longer exists afterwards, no `--state`; nothing executed `run`; a second `activate` is `already: true` with no new generation |
| run delegates | the active canary executed once, not from a path; its arguments carry the resolved `--install-dir` and `--state`; the marker equals `<active version>:<active digest>`; `NODE_OPTIONS` absent, the real configuration directory kept; the child's own result names the active version; the generation and the directory listing unchanged |
| exit and signal relay | exit 7 relayed as 7; a self-SIGKILL reported as `ended by signal SIGKILL` with exit 2 and no `sent: false`; the child ran exactly once; no result line of the installed version and no commit line: no fallback |
| replaced or missing active file | `run` refused at step `launch` with the expected record and the planted file's digest (or `missing`), exit 2, the planted token never posted, no fallback, state untouched; `staged` exits 1 with `active.bytesMatch: false`; re-staging over the wrong file refused and the file left as it was; after removal, `update` with the same artifact re-published it and `run` worked; the repair changed no field |
| activate refusals | nothing staged: step `nothing newer`; a replaced staged file: step `file`, the planted bytes never executed, `active` null; a wrong version answer and a non-zero exit: step `start check`, the fixture executed exactly once, `active` null, `staged` kept |
| one hop | a marker planted on the installed artifact started from a file path is ignored and it delegates as usual; fed over stdin, a marker naming another version is refused (`delegated as 9.9.9, but this client is 0.3.0`) and a delegated client refuses `state` (`runs only run`), both exit 2 and neither ran anything |
| two activators at once | both exit 0, one generation added, `active` equals `staged` |
| activation and staging, both orders | after activating the first, staging a newer one leaves `active` at the first and `run` executes the active bytes, never the staged ones; the next `activate` moves to the newer; an older version cannot be staged over it and `activate` stays idempotent; two staged then one `activate` takes the current staged record and the superseded bytes never ran |
| activation and a policy commit | a policy commit held at the evidence barrier, then `activate`, then release: serial and `active` both present; after activation `run` is delegated and the canary commits nothing. The reverse order (a policy commit after activation) needs a real client as the active bytes and is the owner's evidence, not this session's |
| swap loop | twelve launches with the active file replaced right after each start: the swapped bytes never executed; each launch either ran the active bytes or was refused at `launch` (evidence, not proof) |

Strict command with this suite included: 86 cases, 86 pass, 0 fail, 0 skipped, verdict PASS, against the six pins and
both reproduced artifacts. The limits in section 6 are unchanged.

## 10. The real client activated: closing the order a canary cannot reach, and the two evidence classes

A canary commits nothing, so "a policy commit after activation" was left to the owner above. It is now closed on the
host with the REAL client as the activated version. `verifier/integration/next-build.mjs` builds, reproducibly, a next
version of the pinned client from the pinned source with exactly one line changed (`CLIENT_VERSION`), in a detached
temporary worktree with the pinned esbuild, and records the bytes in `verifier/integration/next-builds.json` (0.3.1
`ad8ff60b…`, 0.3.2 `4453598c…`, 137180 bytes each; the strict command rebuilds them and refuses on any difference). It
also reimplements the owner's device recipe (`client/tools/lab-next.mjs`: from the pinned dist bytes, line 1 replaced by
a banner that names the base and its sha256, the single `var CLIENT_VERSION` replaced, nothing else): the result is
`ed82869d033964081b2dcb45dd9ae8b238db79693f3ff10cf1cdfef510bde84c`, 137343 bytes, exactly what the owner reported, and
beyond its first line it is byte-identical to the source rebuild at 0.3.1. That ties the device artifact to the pinned
source; the strict command checks the tie on every run.

`test/verifier-pvm-client-next.test.mjs` (`npm run test:client-next`), 7 cases on the pinned 0.3.0 as the launcher, all
pass: staging the real 0.3.1 runs nothing (the launcher still answers with its own version and commits serial 3) and
activation keeps the serial and both key anchors while the active record equals the staged one with its size; a policy
commit AFTER activation is made by the delegated real client, its `committed` line printed before its evidence request,
with serial, staged, active and keys all kept; a policy-key rotation is committed by the delegated client, the successor
key is accepted (the anchor moves), the retired key and a rollback are refused without a request, and `active` is kept
throughout; a release-key rotation carried by staging 0.3.2 after activation moves `staged` and `nextReleaseFp` while
`active`, the serial and what `run` executes stay at 0.3.1; one hop under a concurrent activation (a 0.3.1 run held at
the evidence barrier while 0.3.2 is activated finishes as 0.3.1, and the next run is 0.3.2, with serial, active,
staged and all three key fields as expected); the owner's derived device artifact stages, activates, delegates and
commits on the host exactly like the rebuild; a tampered active real file is refused at launch with what was found,
nothing is requested, the state is unchanged, and re-staging the same artifact repairs it.

**Evidence classes, stated apart.** Everything in this section and in section 7 is HOST evidence with lab keys: the
relay is this session's, and it answers every evidence request with 503, so the delegated real client reaches "policy
committed, evidence requested, refused: no evidence" and never a verified attestation or a sealed request (the sealed
counter is asserted to be zero). Nothing here is a real attestation, and the owner's own host tests with a fake VM
show refusals, not a successful end-to-end attestation either. What can only be real on the device: the delegated
0.3.1 verifying the Pixel's evidence under a committed policy and sealing a request the VM answers, and the key
rotation through the delegated client on that device. That is the owner's bounded Pixel 10 run
(`results/pvm-cpu-client-activation`, pending at the time of writing), reviewed independently when it lands: the
derived artifact rebuilt and compared, the generation log, the activate line, each delegated run's `committed` line
before its evidence request, the refusals and repairs, and the served-count cross-check against the VM capture. Stream
traces are not available from the installed CLI (it never writes session secrets), so the authenticity of the device
streams rests on the client's own FIN verification plus the served count; that is a limit, recorded as such.

## 8. Asks sent to the owner (2026-09-24, answered with agreement on Q1 to Q5)

1. One hop: a marker so a delegated child never delegates. 2. Explicit `--state` and `--install-dir` for the child; no
directory derived from a non-path `argv[1]`. 3. A scrubbed environment and no `--state` for the start check. 4. Named
refusals with the expected record and what was found. 5. No fallback confirmed, with the repair path documented.

## 9. Alternatives considered

- A separate launcher artifact with the base hash embedded (this session's first proposal): equivalent root of trust,
  one more artifact to install and reproduce, and a per-launch flag instead of a committed record; superseded.
- Fallback to the installed version when the active file is wrong: availability at the price of a forced-downgrade
  vector; rejected in favour of a named refusal and a repair path, with the policy's `minClientVersion` as the kill
  switch for an installed version that must not run any more.
- `node /dev/fd/N` on an open descriptor: binds execution to the inode hashed, but a same-user writer can still change
  that inode's content after the hash (mode 0444 is advisory to the owner); bytes in memory are what was hashed.
- A `data:` URL import: the same guarantee as stdin with a very long command line; no advantage.
- In-process `import()` of the active file by the installed client: reopens by path and mixes two versions in one
  process.

## 11. Independent review of the Pixel 10 activation run (owner's a7d624c2, `results/pvm-cpu-client-activation`)

The results were copied verbatim (`git archive`) into `test/fixtures/verifier/pvm-client-activation-device/` with a
per-file hash record, and `test/verifier-pvm-client-device-activation.test.mjs` (in the strict command) reviews them
with this session's own code, never the owner's checker. The run's own checker output is kept as produced: it FAILED
once, and the reason is confirmed here from the raw files rather than from the corrected output.

What was verified independently, all passing:

- **The fixture** is the owner's results (137 files hash to the record; the five hashes the owner reported match).
- **Artifact identity.** The activated 0.3.1 (`ed82869d…`, 137343 bytes) is this branch's own reproduction of the
  owner's derivation from the pinned 0.3.0 dist (`next-builds.json`, tied to a source rebuild beyond line 1). Both
  manifests name exactly it (version, digest, size, source commit 0f4c79fd, no release-key rotation); their release
  signature verifies under the lab release key and each countersignature under the key it claims (the original, then
  the successor) and fails under the other; the fingerprints are sha256 of the raw keys and are the install anchors.
- **The generation log** (7 generations): the serial never decreases; the digest at each accepting generation equals
  the sha256 of that policy's exact bytes (policy 1, policy 2, the rotation, the successor's); the release key never
  changes; `staged` appears at generation 3 equal to the signed record, `active` at generation 4 equal to `staged`, and
  both are kept by every later commit made by the delegated client; the rotation is recorded (successor named at
  generation 6, anchor moved at 7). No generation 8 exists: no refusal, repair or rollback attempt committed anything,
  and every snapshot from the rotation on (tamper, the two refused repairs, both repairs, missing, rollback, final) is
  generation 7 with the same state.
- **The six policies replayed** with `verifier/pvm-policy.mjs` under the anchor the state names and its rollback memory
  reach the device's outcomes: 1, 2 and the rotation accepted in order; the successor's policy accepted only because
  the rotation admits it (under the original anchor alone it is a stranger); the retired key refused; serial 3 under
  the successor refused as a rollback.
- **Running identity and order.** Before activation the launcher answers with 0.3.0 and commits itself; after it, all
  ten answered runs carry 0.3.1 and none 0.3.0. The owner's first checker expected nine because it had not counted the
  two policy refusals, which also answer with a result line; the miscount is confirmed from the jsonl files, and the
  original output line (`FAIL ... (10 results)`) and the corrected one (`want 10`, PASS) are both matched. Every
  delegated run printed its `committed` line before its result, streamed 24 tokens to a verified FIN with status 200,
  and its verified summary names exactly the policy's pins (format v2, app, runtime, code hash 433dd3df…).
- **Refusals and repairs.** The tamper was in place (same inode, the tampered size); `run` printed exactly one line,
  the launch refusal with the expected record and the tampered digest as `found`, exit 2, no client result; `staged`
  exited 1 with both records mismatching; the same artifact could not overwrite the wrong file; the manifest
  countersigned by the retired key could not repair; the successor's manifest re-published (idempotent, a new inode,
  read-only, generation unchanged), twice; the missing file gave `found: missing`; the launcher's own file kept its
  inode and size throughout.
- **The VM capture, decoded here** from its hex notes: 9 streams served to FIN and 1 whole answer, equal to the client
  side's 9 complete streams and 1 whole; and one to one by nonce: each of the nine distinct stream nonces the client
  reported is a stream the VM served to FIN, the whole answer's nonce is the one the VM served, and the VM served
  nothing the client did not report. No request or token appears in the clear in the capture, the hub or either
  carrier log; no private key anywhere in the results.

**Evidence classes, stated apart.** What rests on the device: the 0.3.0 launcher handed the activated 0.3.1 bytes over
from memory, and that client, under policies it committed first, reported verified real evidence (format v2, the
policy's app, runtime and code hash) and complete HPKE-sealed streams that the VM's own capture confirms one to one by
nonce; it committed a key rotation; the refusals and repairs happened against that setup. What does not: the raw
evidence envelopes are not in the results, so this session did not re-verify the attestation chains offline for this
run (the earlier device envelopes l1/l2 were re-verified with the owner's verifier through this branch's adapter; here
the claim rests on the activated client's own result lines plus the served-count and nonce cross-check); stream
authenticity rests on the client's FIN verification plus that cross-check, since the installed CLI writes no session
secrets and no trace can be re-opened offline; the start check's environment, the swap races and one hop across a
concurrent activation are host evidence only (sections 7 and 10). This is not called a successful end-to-end
attestation by this session beyond what those two sources show.

**Findings sent to the owner.** (1) The miscount, confirmed and correctly fixed. (2) After a policy-key rotation, a
repair with the original manifest is refused because the retired key countersigns it; correct as a rule, but a repair
then needs a freshly countersigned manifest for bytes the state already names by digest; a manifest-free repair path
that re-publishes only bytes hashing to the committed record is suggested, not required. (3) Future device runs should
save the raw evidence envelopes (they are not secret) so the chains can be re-verified offline here. (4) The notes'
times are local while the documents carry UTC; the review clock is derived from the policies' validity.

**Follow-up (owner's d12e78c9, verified here).** The reviewed results are byte-identical between a7d624c2 and d12e78c9
(`git diff` on the results path is empty), so the fixture hashes stand. Ask (3), raw envelopes: the lab carrier now
records each `/evidence` exchange as received (the client's request line and the VM's answer, never sealed traffic),
off by default and enabled by the device script, and the checker requires one v2 envelope per exchange answering the
nonce the client sent; the a7d624c2 run is reported as predating that capture and its chains remain un-re-verified
offline, as stated above; the next device run can go through this branch's adapter like l1 and l2. Ask (4), time
zone: the run's local clock was MST (UTC-7), so 05:20-05:30 local is 12:20-12:30Z, consistent with the policies'
`notBefore` of 11:20:27Z set one hour before signing; the script now logs UTC; the run's notes were deliberately not
edited because they are hashed here. Ask (2), a manifest-free repair: agreed sound by the owner, not built, recorded
as a candidate (`repair --artifact SRC`: never stages, never changes the state, lays back only bytes whose sha256,
size and version line equal the committed record); it would change the accepted client and so needs a new version and
review cycle, which nobody has asked for.
