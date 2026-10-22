# host-identity.mjs `quorumReader`: no early cut-off, freshness after the snapshot (2026-10-20)

**Scope:** `windows/node/host-identity.mjs`, `test/windows-host-identity.test.mjs`, the new
`test/windows-host-identity-quorum.test.mjs`, and `docs/network/independent-windows.md`.

**Not touched:**
- `network/lease-reader.mjs`, the `network/` service index and any shared quorum helper, which are owned by the other
  worker;
- the installer, `release-channel.mjs`, `cli/host.ps1` and the native harness, which are left stable for coordinator
  review.

**Not done:** no commits, SSH, Wine, GUI, production changes, chain writes or execution-policy changes.

## Audit of the source as it was

The bug is real, plus two related ones:

1. **A late honest head was excluded.** As soon as two heads had arrived, a 250 ms grace timer started. Heads arriving
   after it fired were dropped for the whole call. With a fast liar, a fast honest RPC and a second honest RPC answering
   500 ms later, the read ran on {liar, honest} only, disagreed 1 to 1, and refused. The two honest RPCs could never
   outvote the liar. The cause was the `grace = setTimeout(done, headGraceMs)` in the head phase. This fails closed
   (denial of service, not wrong state), but one malicious fast reply could permanently exclude honest readers.
2. **A fast stale head pinned the block.** With a fast liar reporting a low head and one fast honest RPC, the
   second-highest head was the liar's. The block was therefore stale for everyone, and a late honest head could not move
   it, because it was excluded anyway.
3. **Freshness was checked only at the start.** The block timestamp was checked before `fn` read the snapshot, not after.
   A slow snapshot could finish on a block that was no longer fresh.

`network/lease-reader.mjs` `LeaseReader.agreed` uses the same 250 ms grace. I did not edit it, as instructed.

## Fix (`quorumReader().agreed`)

- **Heads are taken until the deadline** (`deadlineMs`, 30 s by default). There is no grace cut-off.
  - When a second head exists, the block is the second-highest head so far minus the confirmations. It never goes below
    a block already accepted.
  - A later head is read at the current block.
  - A head that raises the second-highest head moves the block up, and every client with a head is read again there.
    The block only ever moves up.
- **Agreement is unchanged.** The first two answers whose whole value and block hash are identical decide. The whole
  value is the full snapshot: in practice registry entry endpoint, operator and active for the name check, and
  registry, owner, pending owner, revision and policy hash for ownership.
  - The chain id is still checked, and a single RPC still never decides.
  - Callers still receive only the agreed value.
- **Freshness is checked three times:** before the snapshot read; after it, together with the existing block-hash
  recheck ("chain block went stale during the read"); and again when the two agreeing answers meet.
- **Fail closed:**
  - It refuses once every head and every read has settled without two fresh agreeing answers.
  - If an RPC never answers, it refuses at the deadline instead.
  - The messages are kept: "chain quorum unavailable: n of m", "no fresh agreeing chain quorum at block …", and
    "… within N s".
- The `headGraceMs` option is gone, since nothing passed it, and `deadlineMs` was added. `checkEndpointOnChain`,
  `host-ownership.mjs` and `host-onchain.mjs` (which only passes `clients`) are unchanged.

## Tests (focused only, `--test-concurrency=1`)

```
node --test --test-concurrency=1 test/windows-host-identity.test.mjs test/windows-host-identity-quorum.test.mjs
# tests 15, pass 15, fail 0
```

**`test/windows-host-identity.test.mjs` (9 tests):**

- The 14-scenario differential against the real `LeaseReader` still gives identical verdicts.
- The block-choice assertion now reflects the progressive block. With heads arriving 10⁹, then 500, then 501, the reads
  are at 498 and then 499, and never near the liar's head.

**`test/windows-host-identity-quorum.test.mjs` (6 new tests, timed fake RPCs):**

- A fast liar and a fast honest RPC, then a second honest RPC 500 ms later, decide "honest". The same holds in other
  orders, including the honest pair arriving 1 s apart.
- When the liar's snapshot read is fastest and the honest reads are slower, the result is still "honest".
- A fast stale head (40, an hour old) is moved past when the late honest head arrives: both honest RPCs read block 998.
  A far-future head never chooses the block.
- When the clock jumps 2 minutes during the snapshot read, the reader refuses ("went stale during the read").
- It fails closed in each of these cases:
  - liar against honest;
  - liar, honest and dead;
  - one fresh RPC with a dead one and a wrong chain;
  - a three-way split;
  - two stale RPCs;
  - a hung RPC with liar and honest, refused at the 0.4 s deadline;
  - an honest answer after the deadline, refused rather than waited for;
  - one RPC configured.

  A hung RPC does not delay two agreeing honest RPCs (under 500 ms).
- Disagreement in any one of owner, operator or code refuses, and so does the same value on another block hash.

**Mutation checks** ran on isolated copies in `/tmp/qm` (since removed), through `QUORUM_MODULE=<copy>`. The repository
module was never edited for this.

| Mutant | Result |
| --- | --- |
| M1: late heads ignored | caught by 3 tests |
| M2: the block never moves up | caught by 1 test |
| M3: no post-read freshness check | survived, because the meet-time freshness check catches the same case |
| M3b: no post-read and no meet-time freshness check | caught by 1 test |
| M4: one answer decides | caught by 4 tests |
| M5: gives up before late heads | caught by 6 tests |
| M6: no deadline | caught: the hung-RPC test runs past the 20 s test timeout and is cancelled |
| M7: block hash not part of agreement | caught by 1 test |

The broad repository suite was not run, as instructed.

## Docs (`docs/network/independent-windows.md`)

- **Name check:** the reader is described as above, including that it deliberately goes beyond `LeaseReader` on late
  heads and the 30 s deadline.
- **Native verification, stated exactly:**
  - Done on minipc on 2026-10-20, without Wine and with no policy change: C# verdicts 157 of 157 (after 119 of 120 the
    first time), all C# bounded-transfer tests passing, `EnclaveSetup.cs` and `TrayTheme.cs` compiling, and the three
    PowerShell scripts parsing with 0 errors.
  - Not done on Windows: any PowerShell at run time, including `run.ps1`, `cli/host.ps1`'s functions, `SecureWorkDir`,
    the lock, and the scripts themselves; `-Verb RunAs`; setup's UI; C# `SecureWorkDir`; any install or update.
- The fixture count is now 157, and the run-on-Linux table has the new test file.

## Note for the other worker

`network/lease-reader.mjs` `agreed()` has the same 250 ms grace, which excludes late heads, and checks freshness only
before the read. The test file above shows the scenarios, and the same approach applies there.
