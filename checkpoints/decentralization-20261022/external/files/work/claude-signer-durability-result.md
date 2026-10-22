# Signer durability and cross-process reservation (`cli/independent-signer.mjs`): result (FINAL)

Both coordinator findings are fixed in the isolated candidate `work/signer-durability/tree`:
- **Finding 1:** two signers or processes on one journal could both send at the same nonce.
- **Finding 2:** intent writes had no fsync.

I edited nothing in `work/enclave`, `work/cli-combined-integration` or `work/cli-final-parity`. I made no commits or
staging, touched no production, used no SSH, and used no real key or wallet; only anvil's published dev keys were used.
Nothing was activated. The interface is `work/signer-durability-interface.txt` (marked FINAL).

## What to apply

Apply from the repository root with `git apply`.

| file | sha256 | applies to |
|---|---|---|
| `work/signer-durability/independent-signer.patch` (1297 lines) | `cdf23f08…5a876` (`cdf23f0879bedcad302954a66f90aa7ba06b0dbf193791f8a53edd445085a876`) | `cli/independent-signer.mjs` plus 5 new test files |
| `work/signer-durability/independent-signer-doc.patch` | `7ed41c416fa25f977939162ced805322b2018c93d7b13abae23247a50da82865` | `docs/network/independent-signer.md` (base `a6919e60…039b`) |
| OPTIONAL `work/signer-durability/enclave-help-optional.patch` | `fa6adab46edded4bf4db093b975b4a1174f06b820af42047e40b4f34a9954b09` | help text in `cli/enclave.mjs` (base `8ebe3411…a781`, the cli-combined snapshot); no functional dependency |

`git apply --check` passes for the main and doc patches on `work/enclave` and on `work/cli-combined-integration/tree`.
`work/cli-final-parity` has the same signer base, `d6eb8771`. A fresh apply onto the frozen base reproduces exactly the
tested files.

| file in the patch | base sha256 | result sha256 | ± lines |
|---|---|---|---|
| `cli/independent-signer.mjs` | `d6eb8771f0153a33557935df39696a0d211995bde9a5b84b4a2f9c9d14559303` | `a09f63aa55778f3ca0e1ae7a56dd4648fd48686627010644040478a344b72527` | +247 −27 |
| `test/cli-independent-signer-durability.test.mjs` | new | `06919359eac893ab619225b413752a946bb29a593acdee4eb835f2d6ea2122bf` | +476 |
| `test/cli-independent-signer-race.test.mjs` | new | `3afda90602b70481fc2f2d9d2a0e41439aadccffe53b2aa6200ca2e60cef5ead` | +120 |
| `test/cli-independent-signer-reservation-cli.test.mjs` | new | `6120b8c2b4c1ed67e8e65df1dd3ebbc78a9ac4e58da7dcefccb688a1a51db506` | +136 |
| `test/helpers/signer-child.mjs` | new | `60f205462475d859e241423c6ba94e5519cd64a81733474194bb896a54ba2c95` | +62 |
| `test/helpers/signer-harness.mjs` | new | `867b2db62cf6cbbc4b0d9262fe0b067a0277b8f8218c00f61fe129bd82723678` | +93 |

**Unchanged and not needed in the patch:**
- `cli/independent.mjs`: the integrated hook version, `82996c8c…72d1`.
- `cli/enclave.mjs`.
- `test/cli-independent-signer.test.mjs` (`5e7e2789…251f`).

**Frozen bases** are in `work/signer-durability/base/`:
- `independent-signer.mjs`: `d6eb8771`;
- `independent.integrated.mjs`: `82996c8c`;
- `cli-independent-signer.test.mjs`: `5e7e2789`.

## The fix

**Reservation (finding 1)**
- **Where it is taken.** `send()` checks for open intents, then takes a reservation, then checks again under it. All of
  this happens before preflight, before the pending-nonce read, and before any wallet transaction request. Those
  requests are:
  - `eth_signTransaction` and `account_signTransaction`;
  - `eth_sendTransaction`;
  - the handoff print.
- **Reservation files.** They live flat in the journal directory: `slot-<chainId>-<from>.<gen>.slot`, created with
  `"wx"` (O_EXCL; CREATE_NEW on Windows).
  - A generation is ended by a `.released` marker.
  - Generations are never deleted or reused, so a late or repeated release can only mark its own generation.
  - Generation N+1 is created only after generation N is released.
  - A marker is only ever written for a generation that exists, and a stray marker is refused.
- **Binding.** The send's intent records its reservation:
  - sign: after the verified signature, before the broadcast;
  - wallet-send: before `eth_sendTransaction`;
  - handoff: before the print.
- **Release.** A reservation is released when its intent is decided by any command (send, resolve, attach, rebroadcast,
  abandon), or when a send ends with no open intent. It never waits and never takes over a holder.
  - A reservation whose intent is already decided (a crash right before the release) is completed automatically by
    the next reserve.
  - A reservation with no recorded intent needs an explicit `signer release <key>`. That command is refused while an
    intent holds the reservation or while any intent file is unreadable.

**Manual-release interleavings (reviewed and tested)**
- **The protocol.** The holder writes its intent, then checks for a release. If it finds one, the intent becomes
  `abandoned` and the holder stops before any broadcast or request. The release does the opposite: it checks for an
  open intent, then writes its marker.
- **Case analysis.**
  - **Holder's check before the marker.** The holder's intent was on disk before the marker. A later send's re-check
    under its own reservation sees that intent, so the later send is refused.
  - **Holder's check after the marker.** The holder stops.
  - **Holder killed between its intent write and its check.** The intent stays open and blocks sends until it is
    resolved or abandoned.
  - **A marker that is empty or partial** still counts as a release.
- **Tests.** Each case is covered across real processes, including a stale marker written after the holder recorded
  its intent and a holder SIGKILLed right after its intent's rename.

**Durability (finding 2)**
- **Order of writes.** An intent is written to a tmp file opened `"wx"` 0600, fsynced, closed, renamed into place, and
  then the directory is fsynced. Markers are created exclusively, fsynced, and the directory is fsynced.
- **Platforms.**
  - **Linux and macOS:** fsync on the file and on the directory. On macOS, libuv's fsync asks for F_FULLFSYNC; this was
    not tested on macOS.
  - **POSIX directory fsync refused:** if it fails with EINVAL or ENOTSUP, that is tolerated as best effort. Any other
    error fails the write before it is reported.
  - **Windows:** the file is flushed before the rename, then reopened `r+` and flushed again. Node cannot flush a
    directory, so the rename's own durability rests on NTFS's metadata log. That is **best effort**: after a power loss
    it may revert to the previous record, or to none.
- **Permissions.** On POSIX the journal directory is tightened to 0700 and files are 0600. On Windows, files take the
  directory's ACL.

**Unreadable or unknown records**
- An unreadable `tx-*.json` is no longer silently dropped. It blocks every send from that journal, without contacting
  the wallet and without taking a reservation, until it is reviewed and set aside with `signer quarantine <id>`. The
  file is renamed and kept; readable intents are refused by that command.
- A record in an unknown state blocks its account and can be abandoned.
- Parse errors never echo file content (V8's JSON error text would quote it), and raw signed bytes are never printed.

**Mutations by other commands**
- A decided intent never reopens.
- A waiting send stops promptly when another command decides its intent.
- If another command confirmed the intent, the waiting send returns the agreed receipt; before, `confirmIntent`
  returned `undefined`.

## Tests: final commands and exits

All jobs ran serially in the foreground, capped at 512 MiB, with no swap and a 16 GiB host floor. Since the
coordinator's queue switch, they ran through `python3 work/claude-test-queue.py --mib 512 --log <log>.guard -- …`
(`run-guarded.sh`, `final-runs.sh`, `retry.sh`, `mutate.sh` in `work/signer-durability/`). A queue answer of 98 means
NOT STARTED, and was retried. Logs are `work/signer-durability/logs/final-*.log` and `mutants.log`.

| step | command (cwd) | result |
|---|---|---|
| durability (new, module `a09f63aa`) | `node --test --test-concurrency=1 test/cli-independent-signer-durability.test.mjs` (tree) | **21/21, exit 0**, peak 409 MiB (before the queue switch: same cap, systemd scope and guard) |
| existing suite, unchanged test file | `… test/cli-independent-signer.test.mjs` (tree) | **13/13, exit 0**, 405 MiB |
| race, fixed module | `… test/cli-independent-signer-race.test.mjs` (tree) | **6/6, exit 0**, 355 MiB |
| race, **negative control**, frozen old module `d6eb8771` | `SIGNER_TREE=../old node --test … race.test.mjs` | **0/6, exit 1 as expected**: every case has 2 handoffs or 2 wallet requests at one nonce (e.g. `eth_sendTransaction requests: 2; … confirmed nonce 0; … unknown nonce 0`) |
| integration CLI test, source | `… test/cli-independent-signer-cli.test.mjs` (cli-tree) | **3/3, exit 0**, 302 MiB |
| reservation CLI test, source | `… test/cli-independent-signer-reservation-cli.test.mjs` (cli-tree) | **3/3, exit 0**, 291 MiB |
| bundle | `node cli/build.mjs cli-tree/cli/dist/enclave.mjs` | exit 0, `95fec6198294cf6afa6aa7c0b357453524ab4a66b364f9b08a468964e579726d` |
| integration CLI test, **bundle** | `ENCLAVE_CLI_ENTRY=cli/dist/enclave.mjs node --test … signer-cli.test.mjs` | **3/3, exit 0**, 294 MiB |
| reservation CLI test, **bundle** | `ENCLAVE_CLI_ENTRY=… … reservation-cli.test.mjs` | **3/3, exit 0**, 320 MiB |
| CLI **negative control**, old module (cli-tree-old; inputs unchanged since, so not repeated) | `--test-name-pattern="two CLI processes" … reservation-cli.test.mjs` | **fail, exit 1 as expected**: `handoffs printed: 2 (… nonce 0x0; … nonce 0x0)` (22:38) |
| mutants (each breaks one guarantee) | `./mutate.sh` | **8/8 killed** by the targeted test: file fsync, directory fsync, post-record release check, re-check under the reservation, auto-completion, unreadable ignored, unknown state ignored, reopen allowed |

**What the tests cover**
- **Concurrency.** Same process (two signer objects, and one object with two sends), separate processes, and two real
  CLI processes, in handoff, sign and wallet-send modes. The interleaving is forced deterministically by holding every
  pending-nonce read: in-process, at the QuorumChain, and for the CLI, at an RPC forwarder.
- **Real SIGKILL crashes:**
  - before any wallet request;
  - between an intent's flushed tmp file and its rename;
  - after the intent's rename, before the release check;
  - during `eth_sendTransaction`, both when the wallet broadcast and when it did not;
  - during the signature request;
  - after the signed bytes were journaled but before publication;
  - after publication;
  - between an intent's decision and its release.
- **Other cases:** manual release against a live holder (in-process and cross-process), a stale release, the
  intent-between-check-and-reservation window, unreadable and unknown records, permissions, the fsync order, EINVAL
  tolerance, and the Windows branch with `process.platform` forced to win32.
- **Not covered:** power loss itself cannot be simulated here. Durability is shown by the order of the
  open/write/fsync/rename/directory-fsync calls, which the spy test checks and the fsync mutants confirm.

**CLI tree.** `work/signer-durability/cli-tree` is the static import closure (111 files, `cli-tree-snapshot.sha256`) of
the cli-combined-integration tree at 22:36, with `cli/enclave.mjs` `8ebe3411…`, plus my module. It is not the CLI
worker's final tree.

## Process notes (honest)

- One early smoke run of the existing suite (about 3 s) ran without the memory guard, at about 18.2 GiB available. All
  other runs were guarded.
- One durability run was stopped by the guard: 535 MiB > 512 MiB at start-up, exit 99. Two anvils were spiking. I
  replaced the suite's second anvil, which was only a signing wallet, with an in-process key wallet on the same
  published dev key. Later peaks were at most 421 MiB. The cap was never raised.
- The background reviewer launched in the first session left no output; it was stopped with that session. I did the
  review synchronously instead. It found and fixed:
  - release errors inside `update()` (they are now left for the next reserve to complete);
  - directory-fsync EINVAL/ENOTSUP;
  - release and doc wording after a quarantine;
  - doc platform claims.
  It also added tests for the stale-release, crash-after-intent and recheck windows.
- Two earlier finalize attempts spent their time waiting for capacity under the old 18 GiB rule; no test ran in them.
  No owned process, fixture, mutant tree or watcher remains.

## Limitations and remaining activation gaps

1. **Apply and rebuild in the real tree.** Root or the CLI worker applies the patches to the final CLI tree, rebuilds
   `cli/dist/enclave.mjs`, and runs the four suites there:
   - existing;
   - durability;
   - race;
   - reservation-cli, both with and without `ENCLAVE_CLI_ENTRY`.
   The optional help patch may need rebasing onto the worker's `enclave.mjs`.
2. **Separate `--state-dir`s are separate journals.** Concurrent sends for one account through different journals are
   not serialized.
3. **Older CLIs.** A CLI that predates reservations, writing to the same journal, takes no reservation.
4. **Filesystems.** Old NFS without exclusive create gives no guarantee.
5. **Windows.** Durability is best effort, as described above. Windows and macOS were not run natively; only the
   Windows code path was exercised, with the platform forced.
6. **Sign-only requests.** A signature request that reached the wallet before a crash or a hand release is never
   journaled or broadcast by this CLI. It relies on sign-only wallets not broadcasting.
7. **Releasing a live holder.** `signer release` on a holder that is still running is safe, because at most one send
   proceeds, but it stops that holder's send.
8. **Real wallets.** Clef, Frame, MetaMask and hardware wallets were not exercised; unchanged from the earlier signer
   report.
