# Windows independent install/update: hardening result (2026-10-19)

**Repository:** `enclave`, branch `decentralize/nan-retirement`, working tree only.

**Not done:** no commits, pushes, SSH, private configuration, production changes, chain transactions, Nan, release,
update or install.

**No Windows code was run by me.** Everything C# and PowerShell below was reviewed statically and checked by Node
structural tests. It is ready for the coordinator to run natively with `test\windows-native\run.ps1`.

**Wine incident (my mistake).** Early on I started a Wine C# compile probe, which opened Wine initialization and a mono
install prompt on the user's desktop. After the coordinator stopped it, I ended the six leftover Wine processes it had
started (`services.exe`, `plugplay.exe`, `svchost.exe`, `explorer.exe /desktop`, `rpcss.exe`, and
`control.exe appwiz.cpl install_mono`) with a plain `kill` on those PIDs, and removed `/tmp/wt`. I did not run
`wineserver` or change any Wine configuration. Nothing Wine-related ran after that.

**The coordinator's fix is kept:** `update-host.ps1`'s `${installed}:` lines (now lines 208 and 214) are unchanged.

## Files changed (only the assigned scope)

| File | Change |
| --- | --- |
| `cli/host.ps1` | Rewritten signed and legacy download paths (item 1). Verification brought to parity with Node and C# (item 3). Checks are functions so the harness can load them. |
| `windows/node/release-channel.mjs` | Bounded cache check, transfers, deadlines and cancellation (item 2), plus parity refusals (item 3). New exports `parseReleasePolicy` and `MIN_RATE`. |
| `windows/node/host-identity.mjs` | `quorumReader` now follows `LeaseReader.agreed` semantics (item 4). `rpcClients` needs two or more RPCs on distinct hosts. |
| `windows/installer/EnclaveSetup.cs` | `ReleaseChannel` gets bounded `Fetch` with a hard deadline, `Download` failover and deadlines, a byte-level `Verify(byte[], Policy, DateTime)`, `ParsePolicy` and parity fixes. New `SecureWorkDir`. |
| `windows/installer/update-host.ps1` | New `SecureWorkDir`, called before the work folder's first use. Nothing else changed. |
| `windows/installer/install-host.ps1` | One check: `-Rpcs`, when given, must name two or more RPCs on distinct hosts. |
| `test/windows-release-channel.test.mjs` | 4 new tests; the test server now closes its connections. |
| `test/windows-host-identity.test.mjs` | Quorum test rewritten against `LeaseReader`; liar and stale cases for the name check; fake clients now have chain id and blocks. |
| `test/windows-installer-independence.test.mjs` | `host.ps1` structural checks updated; 2 new tests (bounded downloads; work folder and C# transport). |
| `test/windows-native/make-fixtures.mjs`, `fixtures.json`, `node-verdicts.json`, `Harness.cs`, `run.ps1` | **New:** the native cross-language harness. |
| `docs/network/independent-windows.md` | Name-check quorum, transfer bounds, work folder, harness, and what has and has not been run. |

## Tests actually run (Linux, Node v22.23.3)

```
node --test --test-concurrency=4 test/windows-*.test.mjs windows/node/*.test.mjs \
  test/release-signing.test.mjs test/host-contract-pins.test.mjs test/host-admission-policy.test.mjs
# tests 538, pass 538, fail 0
node test/windows-native/make-fixtures.mjs --check test/windows-native/fixtures.json
# Node agrees with all 120 cases
```

The earlier baseline was 532: the author's 517 Windows tests plus 15 related ones. The 6 new tests are 4 in
`windows-release-channel.test.mjs` and 2 in `windows-installer-independence.test.mjs`. The rewritten quorum test and the
added name-check cases are inside existing tests.

The suite stays well under 1 GiB. The 2 GiB sparse-file test asserts resident memory grew by less than 256 MiB.

## 1. `cli/host.ps1`: bounded transfers, hard deadline, checked before it runs

**`Read-Bounded` (the only network code; no `Invoke-WebRequest`, `Invoke-RestMethod` or `WebClient` remain):**

- **Byte limits while the data arrives.**
  - An announced `Content-Length` over `$Max`, or different from the signed size, is refused before the body is read.
  - A body is refused at the first byte past `$Max` or past the signed size.
  - A pointer is held in memory only up to 64 KiB.
- **A hard deadline over the whole exchange.** This uses `GetResponseAsync()` and `ReadAsync()`, each waited for with
  `Task.Wait(time left)`. When the time runs out, `$req.Abort()` is called.
  - Abort comes before anything is disposed, and `KeepAlive=$false`, so a body that never ends is never drained.
  - `Timeout` and `ReadWriteTimeout` are also set, but only as a backstop for the synchronous parts.
- **Files.** A downloaded file is created with `CreateNew`, so nothing already there is written through. On any failure
  it is removed. A pre-existing file is left alone.

**The signed path:**

1. `New-ReleasePolicy` builds the policy from `ENCLAVE_RELEASE_*`.
2. `Resolve-SignedRelease` asks every mirror, with a 20 s deadline each. The highest version wins. Equivocation is
   judged by `[version]` key, so `1.2` and `1.2.0` count as the same version.
3. `Save-SignedFile` tries the mirrors that served the statement first, then the others.
   - Each mirror gets `min(30 min, 60 s + size at 128 KiB/s)`, and all mirrors together get one hour.
   - Part files have random names. Only a part with the signed size and sha256 is moved to the final name.
4. The script works in a **new private folder** under `%TEMP%`, which also holds the policy file for setup.
5. `Start-CheckedSetup` opens setup with `FileShare.Read`, so it can be read but not written or deleted. It re-hashes
   through that handle, checks size and sha256, and starts setup (`-Verb RunAs`) while the handle is held.
6. If anything fails before setup starts, the folder is removed.

**Thresholds and trust are unchanged:** distinct pinned keys must meet the threshold, and unpinned signatures are
ignored.

**No unsigned fallback.** Any failure in the signed path throws out of the script. New: any `ENCLAVE_RELEASE_*` variable
set while `ENCLAVE_RELEASE_KEYS` names no key now refuses. Before, it silently took the unsigned channel.

**Legacy path.** It uses the same bounded reader: 64 KiB for `latest.json`, and 64 MiB within 30 min for setup. It also
uses the same private folder and lock. Its unsigned semantics and messages are unchanged.

**Windows PowerShell 5.1 only.** The signed path parses JSON with `JavaScriptSerializer`, the reader setup uses (see
item 3). Under PowerShell 7 it refuses, because `JavaScriptSerializer` does not exist there.

## 2. `release-channel.mjs`: bounded cache, transfers and cancellation

**The cache check (`hasSignedBytes`):**

- It uses `lstat`, so only a regular file of exactly the signed size is opened. A link, a directory or a wrong size is
  never read.
- It hashes 1 MiB at a time, reads at most the signed size, and re-checks the size afterwards.
- Cancellation is honoured. A read error counts as "not cached".

**The download (`downloadVerified`):**

- The part file has a random name and is opened with `wx`.
- Each mirror attempt gets `min(timeoutMs, 60 s + bytes at MIN_RATE)`.
- There is one `deadlineMs` over all mirrors (4 h by default).
- The caller's `signal` cancels everything.
- On any refusal, an `AbortController` closes that mirror's connection, so an unread body is not left open (this was a
  leak).
- Only a verified part is renamed onto `out`. A failed verification never replaces or removes an existing `out`.

**Elsewhere in the module:**

- `resolveRelease` takes a `signal`, and each per-mirror deadline covers headers and body.
- CLI `download --deadline-sec` (default 4 h) puts one deadline over the whole list `update-host.ps1` hands it.
- `readJsonText` checks the file size with `fstat` before allocating anything. A 1 GiB policy file is refused without
  being read; before, `readFileSync` read the whole file first.

**Tests, all with real loopback HTTP:**

- 2 GiB sparse files:
  - right size, wrong hash: streamed, refused, and `out` left unchanged;
  - all zeros with the matching hash: kept;
  - a size off by one: refused without being read, in under 2 s;
  - a symlink is never the cache.
- Mirrors that are cut off, with the next mirror then used and resident memory checked:
  - announcing 50 GiB;
  - flooding without end (cut off after 1 KiB over the signed size);
  - trickling (cut at 800 ms).
- Three trickling mirrors share one deadline (900 ms in total).
- Cancellation leaves no files.
- A trickling or flooding envelope is refused during resolve.

## 3. One protocol, consistent refusals

These divergences were found by review; I did not run C# or PowerShell. All are now fixed in the module named:

| Divergence | Fixed in |
| --- | --- |
| `cli/host.ps1` had no `issuedAt` check, a weak `expiresAt` check (null passed), and checked only the setup triple (not zip or manifest). | PS |
| `cli/host.ps1` lacked: an envelope exact-field check; signature-entry shape checks; the 16-signature limit; strict canonical base64; the 16 KiB statement limit; the 8-key limit; the duplicate-key check; key on-curve import at policy time. | PS |
| PowerShell `-eq`/`-ne`/`-match` are case-insensitive (format, channel, keyId), and `ConvertFrom-Json` is case-insensitive and turns times into DateTime on PS7. Now `-ceq`/`-cmatch` and `JavaScriptSerializer`. | PS |
| .NET `$` matches before a final `\n`, and `\d` matches non-ASCII digits. Every pattern now uses `\z` and `[0-9]`. | C#, PS |
| C# checked the envelope size in **chars**, not bytes. It now reads bytes, bounded. | C# |
| C# accepted any loopback http host (`127.0.0.2`); Node accepts only localhost, `127.0.0.1` and `[::1]`. | C# |
| JSON `1.0` or `1e3` is an int to `JSON.parse` but a decimal to `JavaScriptSerializer`. Node now refuses fraction and exponent numbers in statements and policy files. | Node |
| `Date.parse` rolls over `02-30` and accepts `24:00`, which .NET refuses. Node now requires an ISO round trip. | Node |
| Mirror spellings that WHATWG URL and .NET `Uri` normalise differently. All three now refuse non-printable-ASCII, `\ ? # @ %`. | all |
| `1.2` against `1.2.0`: .NET `Version` orders them, and Node treated them as equal. Two statements for one numeric version are now equivocation everywhere. | all |

The protocol is unchanged: the same formats, signing context, P-256 r‖s signatures, key ids, statement fields, limits
and threshold rule. Only refusal parity was tightened. No crypto was written; all three use native verifiers.

**The native harness** (`test/windows-native/`; no install, no elevation, loopback only):

- `make-fixtures.mjs` writes 120 cases (public keys and signatures only) and refuses to write any case Node misjudges.
  - The cases cover expiry and issue time, the time spellings above, `1.0` and `1e3` sizes, and malformed, duplicate,
    off-curve and P-384 keys.
  - They also cover thresholds (`0`, too high, `1.0`, a string), mirror spellings, 16 against 17 signatures, 64 KiB
    against 64 KiB + 1, 16 KiB statements, and signature-shape cases.
  - One case, a duplicate JSON member in the statement, is "agree-only". Node takes the last value. The harness reports
    whether C# and PowerShell do the same.
- `run.ps1` does the following:
  1. parses all three scripts with the native parser;
  2. extracts `ReleaseChannel` unchanged from `EnclaveSetup.cs` and builds it with `Harness.cs` using the in-box .NET 4
     csc;
  3. loads `cli/host.ps1`'s functions from its syntax tree;
  4. checks every verdict, and that accepted results are identical (version, signers and statement sha, or normalised
     mirrors);
  5. runs the C# and PowerShell transfer tests against `Harness.exe`'s misbehaving loopback mirror;
  6. tests the setup file lock with an unelevated start of a copy of `whoami.exe`;
  7. as Administrator only, tests `SecureWorkDir` on a folder under `%TEMP%`.

The coordinator's earlier `windows-native-review/Check.cs` path still works: `Verify(string, Policy)` and `LoadPolicy`
are kept.

**For the coordinator (copy the repository tree; nothing else is needed):**

```
powershell -NoProfile -ExecutionPolicy Bypass -File test\windows-native\run.ps1
#   optional: -Node "C:\Program Files\Enclave\runtime\node\node.exe" to re-judge the fixtures with Node on Windows
#   run it once more from an elevated prompt to include SecureWorkDir
# Exit 0 = all checks passed. Results and the build are left in the %TEMP%\enclave-native-* folder it prints.
```

`Harness.exe` serves 127.0.0.1 only and stops on a stop file, or after at most 10 minutes. `run.ps1` never calls
`Start-CheckedSetup`, because that asks for elevation.

## 4. `host-identity.mjs` `quorumReader`

**The old reader was flawed:**

- The first RPC that answered chose the head, and so the block. A malicious or stale first RPC could pick an old block,
  for example one before the endpoint was registered.
- There was no freshness or reorganisation check.
- **Every** answer had to agree, so one liar vetoed two fresh RPCs.
- A single configured RPC decided alone (`minAgree` was capped at the client count).

**The new reader follows `LeaseReader.agreed` (`network/lease-reader.mjs`):**

- It checks the chain id of each RPC.
- It needs at least two heads; a slower RPC gets a 250 ms grace once two have answered.
- The block is the second-highest head minus 2.
- The block never goes below one already accepted, so a lagging pair cannot roll an answer back.
- The block must be under 90 s old.
- The block hash is re-read after the read, which catches a reorganisation.
- The first two answers equal in value **and** block hash decide.
- It needs at least two clients; `rpcClients` needs at least two on distinct hosts, and `install-host.ps1 -Rpcs` checks
  the same.

**Why it is a port and not an import:** the installed Windows node cannot import `network/lease-reader.mjs`, because
viem resolves from the repository root. The admission bundle does not export `LeaseReader`, and changing the bundle is
outside this scope. The behaviour is instead held to `LeaseReader` by a differential test: 14 scenarios run through both
readers on identical fake RPCs, and they give the same verdict.

| Kind | Scenarios | Verdict |
| --- | --- | --- |
| One bad RPC against two fresh ones | liar, dead, wrong chain, stale (behind with old blocks), far-future head, other fork, reorganised mid-read | decides |
| No two fresh agreeing RPCs | split of two, split of three, only one answering, one fresh plus one wrong chain, two agreeing but stale, two agreeing on different forks | refuses |

Also tested:

- the block choice (heads 10⁹, 501 and 500 give a read at 499);
- no rollback below an accepted block;
- the refusal messages;
- the name check returns "taken" when a lying or stale "free" RPC faces two fresh RPCs that see another operator.

**Callers:** `host-ownership.mjs` and `host-onchain.mjs` use the same reader and still pass. The reader returns only the
agreed value; the block metadata is not merged in, unlike `LeaseReader`, because callers read tuples and strings.

## A further finding I fixed: the work folder

`ProgramData\Enclave-setup` is created by elevated setup, but it inherits ProgramData's "Users: create files". Neither
`install-host.ps1` nor setup restricted it. Any local account could therefore do the following:

- pre-create, or keep, a cached `EnclaveSetup-<v>.exe` or zip that hashes correctly, then swap it after the hash check,
  so SYSTEM runs it;
- plant a missing file in the kept bundle, which a delta hard-links **without** any hash check;
- pre-create setup's RunOnce copy of itself.

**The fix:** setup (C#) and `update-host.ps1` use the folder only if all of these hold:

- it is not a link;
- its access rules are protected;
- it is owned by SYSTEM or Administrators;
- every rule is for SYSTEM or Administrators.

Otherwise it is moved aside untouched to `Enclave-setup.untrusted-<time>-<id>` (never recursively deleted, so a planted
junction cannot redirect a delete). A new folder is then made with `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`.

**The cost:** on an existing host, the first run of the new updater makes one whole (non-delta) update, and there is no
rollback copy for that update. The quarantined folders accumulate until an operator deletes them.

**Risk:** this runs hourly as SYSTEM on every host once shipped, and it is untested natively. If `Get-Acl` or
`Directory.Move` misbehaves, every update fails closed with a logged reason. Please run `run.ps1` elevated before
shipping.

## Untested assumptions (need Windows)

- **Compilation.** `EnclaveSetup.cs` must compile after these changes. Its new fully qualified names are
  `System.Threading.Timer`, `System.Security.AccessControl` and `System.Security.Principal`. `Harness.cs` must compile
  with the in-box csc.
- **Parsing.** `cli/host.ps1`, `update-host.ps1`, `install-host.ps1` and `run.ps1` must parse; only a crude brace and
  paren balance check was done here.
- **PowerShell 5.1 behaviour of `Read-Bounded`:**
  - `GetResponseAsync().Wait(ms)` and `ReadAsync().Wait(ms)`, and `Abort()` ending a blocked read;
  - `BeginGetResponse` can resolve DNS synchronously on .NET Framework, so a slow DNS answer is bounded by the resolver,
    not the deadline.
- **Duplicate JSON members.** `JavaScriptSerializer` is assumed to take the last value, as Node does. This is the
  harness's agree-only case.
- **Off-curve keys.** CNG `CngKey.Import` is assumed to refuse an off-curve point at policy time (a fixture case).
- **The lock under elevation.** `Start-Process -Verb RunAs` must still work while `Start-CheckedSetup` holds the file
  with `FileShare.Read`. The harness tests only an unelevated start. If consent.exe or AppInfo need more sharing, setup
  launch fails closed with an error.
- **ACL creation.** `SecureWorkDir`'s SDDL creation is assumed to behave as described both as an elevated admin and as
  SYSTEM.
- **Full runs.** The setup UI flow, the update execution, the Hyper-V resume and a live signed update are all untested,
  as before.

## Residual items (not changed)

- **The policy file passed to setup.** It sits in the user's own `%TEMP%` folder, so the same user (not another
  account) could swap it before elevated setup reads it. A same-user attacker can already control the unelevated
  `host.ps1`.
- **The legacy unsigned paths are still unsigned by design.** The `update-host.ps1` legacy downloads (`Invoke-WebRequest
  -TimeoutSec 3600`, `WebClient` for deltas) and setup's legacy zip download are not bounded by this change. They are
  outside items 1 and 2, but the work-folder fix covers their local-planting risk.
- **`LeaseReader` export.** Exporting `LeaseReader` from `network/host-admission-runtime.mjs` and rebuilding
  `host-admission.bundle.mjs` would let `host-identity.mjs` import the real class instead of the tested port. Those
  files are outside this scope.
