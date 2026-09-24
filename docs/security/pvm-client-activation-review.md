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
