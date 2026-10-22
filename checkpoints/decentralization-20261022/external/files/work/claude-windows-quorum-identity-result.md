# host-identity.mjs `quorumReader`: configuration hardening and corrected comments (2026-10-20, review round 2)

**Scope:** `windows/node/host-identity.mjs`, `test/windows-host-identity.test.mjs` and
`test/windows-host-identity-quorum.test.mjs` only.

**Not touched:** docs (see "Doc lines left for their owner" below), `network/`, Shield files, `release-channel.mjs` and
the installer.

**Not done:** no Wine, GUI, SSH, chain writes, commits or heavy builds. Mutants were scratch copies only, now removed.

## Fixes

**Duplicate public RPC hosts.**
- New `rpcPeerHost(url)` canonicalises the host: lower case (WHATWG `URL` already lower-cases), all trailing dots
  removed. So `rpc.example`, `RPC.example.` and `rpc.example..` are one host, and ports never make two hosts.
- `quorumReader` and `rpcClients` (the CLI's path) both use it.

**Every peer must name a well-formed RPC.**
- Every client needs a string `transport.url`, which real viem http clients expose (checked).
- `rpcPeerHost` validates it:
  - it must be a URL;
  - https only, or http on loopback;
  - no empty host or label (`https://./`, `rpc..example`).
- A client with no URL, a malformed URL, or a fallback transport (which mixes hosts) is refused, where the old code
  silently skipped it in the host comparison.

**Complete method set.** Every client must have `getChainId`, `getBlockNumber` and `getBlock` as functions.

**Bounded configuration.** The reader is refused at construction unless:
- there are 2 to `MAX_PEERS` (16) clients (`rpcClients` has the same cap);
- `chainId` is a positive safe integer (not a string or bigint);
- `confirmations` is an integer from 1 to 1000;
- `maxBlockAgeMs` is an integer from 1 s to 1 h;
- `deadlineMs` is an integer from 0.1 s to 10 min (no 0, negative, NaN, Infinity or strings);
- `now` is a function.

**Local fixture seam (explicit and isolated).**
- `quorumReader({ localFixture: true })` keeps the port only for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), so a
  test can run several local RPCs.
- It must be a boolean and is passed only as a direct argument; neither the CLI nor `rpcClients` sets it.
- It changes nothing for a public host, so one public host still never casts two votes.

**Comments corrected against the source.**
- **`LeaseReader`:** the old comments said it "stops taking heads 250 ms after the first two". Today's
  `network/lease-reader.mjs` (working tree, the other worker's) does something different:
  - it waits `headGraceMs` (250 ms) after the second head before choosing its block;
  - it still reads later heads at that block;
  - it moves to a newer block only after a round fails.

  The quorumReader comment now says that, and that this reader moves up as soon as a head raises the target.
- **Shield market:** the header said an independent verifier "is follow-up work". In fact it is implemented in source:
  `host.mjs` opens the market on `verifierMarketOpen()` from verdicts of operator-selected verifiers
  (`shield-verdict.mjs`). It is switched on only by configuration: `agent.mjs` starts it only with
  `ENCLAVE_SHIELD_VERIFIERS_FILE` (no built-in verifier) and the pinned readiness witness. The header now states that
  distinction between source and activation.
- **`resolveIdentity`'s `unavailable` list** (runtime text, in my file) said the market needs "an attached relay's
  attestation verdict". Now:
  - with no relay and no `ENCLAVE_SHIELD_VERIFIERS_FILE`, it says the market needs a relay's verdict or operator-selected
    verifiers, owner-only until then;
  - with the verifier file set, the market is not listed as unavailable.

## Tests (focused, `--test-concurrency=1`)

```
node --test --test-concurrency=1 test/windows-host-identity.test.mjs test/windows-host-identity-quorum.test.mjs
# tests 26, pass 26, fail 0
```

The 26 are the 21 from the last round plus 5 new ones. The existing fakes now carry distinct `https://rpc-N.test/` URLs;
the 14-scenario `LeaseReader` differential is unchanged and passes.

**New tests:**

| # | File | What it checks |
| --- | --- | --- |
| 13 | quorum | Aliases are one host: `rpc.example` / `rpc.example.`, case plus double trailing dot, the same host on another port, an IPv4 host on two ports, and a third peer aliasing the first are refused. Distinct hosts are accepted. `rpcClients` refuses `rpc.example` / `rpc.example.` and case aliases before making any client. |
| 14 | quorum | Each missing or non-function method is refused, and so is a null client. A missing, `{}`, numeric, null or fallback transport is refused. These URLs are refused: `""`, `not a url`, `ftp:`, `ws:`, public `http:`, `rpc..example` and `./`. |
| 15 | quorum | 16 peers are accepted and 17 refused. Bad values are refused for `chainId` (0, -1, 1.5, a string, NaN, Infinity, a bigint), `confirmations` (0, -1, 1.5, a string, NaN, Infinity, 1001, a bigint), `maxBlockAgeMs` and `deadlineMs` (out of range, fractional, NaN, Infinity, strings) and `now` (not a function). The minimum valid values are accepted. |
| 16 | quorum | Two loopback ports are one host by default and two with `localFixture: true`. The same loopback port twice is still refused. Public same-host on two ports is still refused under the seam. A non-boolean seam is refused. `rpcClients` with two loopback ports is refused. |
| — | identity | The Shield market is listed unavailable only with no relay and no `ENCLAVE_SHIELD_VERIFIERS_FILE`, and the message names the verifier option. |

**Mutation checks** (scratch copies in `/tmp`; `node_modules` symlinked so viem resolves; an unmutated control copy
passes all tests):

| Mutant | Caught by |
| --- | --- |
| P1: trailing dots kept | #13 |
| P3: URL optional (the old behaviour) | #14 |
| P4: no method check | #14 |
| P5: deadline unbounded | #15 |
| P6: no peer limit | #15 |
| P7: the seam keeps ports for public hosts | #16 |
| P8: `rpcClients` uses the raw hostname | #13 |
| P9: malformed host allowed | #14 |
| P10: public http allowed | #14 |
| P11: confirmations unchecked | #15 |
| S1: Shield message ignores the verifier file | the new identity test (checked directly on the scratch copy) |
| P2: no `toLowerCase` | **equivalent** (survives) |

P2 survives because WHATWG `URL` already lower-cases the hostname, so the explicit call is redundant. Case aliasing is
still refused, as shown by #13 passing on the real module.

A first mutant run without viem resolvable made #13 fail for every mutant. That run was discarded and redone with the
symlink and a control.

## Doc lines left for their owner (`docs/network/independent-windows.md`; not edited, per scope)

- **Line 98 is now false. It currently says:**

  > `LeaseReader` stops taking heads 250 ms after the first two. This reader keeps taking them until its deadline
  > (30 s).

  **Suggested replacement:**

  > `LeaseReader` waits 250 ms after the second head before choosing its block, still reads later heads at that block,
  > and moves to a newer block only after a round fails. This reader keeps taking heads until its deadline (30 s), and
  > moves up as soon as a head raises the target.
- **Line 82 could add:** "Hosts are compared lower-cased and without trailing dots (`rpc.example.` is `rpc.example`)."
- **Line 136 (the Shield market row)** has already been corrected by its owner and matches the source.

---

# host-identity.mjs `quorumReader`: authorization bypass fixed, censorship resistance kept (2026-10-20)

**Scope:** `windows/node/host-identity.mjs`, `test/windows-host-identity.test.mjs`,
`test/windows-host-identity-quorum.test.mjs`, and `docs/network/independent-windows.md`.

**Not touched:** `release-channel.mjs`, the installer, `cli/host.ps1`, the native harness, `network/` and any shared
quorum helper.

**Not done:** no Wine, SSH, GUI, production changes, commits or chain writes. Mutants were scratch copies in `/tmp`, now
removed.

This replaces `claude-windows-quorum-result.md`. That version had the authorization bypass described below.

## The bypass in the previous version (confirmed)

In the previous version:

- the agreement key was `stable({hash, value})`, with no block number, timestamp or peer;
- the `answers` map was shared by every round of one call;
- a matching earlier answer counted even if the same client had produced it.

When a late head raised the target block, every client was read again at the new block. A single malicious client that
returned a fixed fake block hash and a forged value at both heights therefore matched its own first answer, and the reader
**accepted the forged value**. That is an authorization bypass, not merely a denial of service.

**Reproduced:** a scratch mutant restored exactly those three properties. The new test then reports
`decided {"owner":"forged","operator":"forged","code":"forged"}: the liar's two answers met each other`.

## Fix

Both properties must hold, and the tests check each one.

**Authorization: no single RPC decides.**

- **Peers are distinct.** Each configured client is one peer (its index).
  - The same client object twice is refused: `an RPC client is configured twice`.
  - Two clients whose `transport.url` is on one host are refused. Real viem clients expose `transport.url`; this was
    checked.
  - `rpcClients` already required distinct hosts.
- **Votes are per round and per distinct peer.** A round is one requested block, with its own vote map and its own
  `AbortController`.
  - A vote counts only if its round is still the current one when it arrives (`live(r)`).
  - Agreement needs a key held by two distinct peer indexes in that round.
  - Starting a new round discards the old round's votes and aborts its signal.
- **The key is the whole snapshot:**
  - the requested block number;
  - the returned block, validated: its `number` must equal the requested block, its `hash` must be `0x` plus 64 hex
    digits (lower-cased), and its `timestamp` must be a safe time;
  - the hash and timestamp re-read unchanged after `fn` (otherwise "reorganized");
  - the whole value `fn` returned.
- **Freshness** is checked before `fn`, after the whole snapshot, and at the decision.
- **The high-water mark is enforced at the decision.**
  - If the agreeing round's block is below `lastBlock` (because an overlapping call accepted a higher block meanwhile),
    it is not accepted. A new round starts at `lastBlock`.
  - `lastBlock` is set only at a decision.
  - Rounds also start at no less than `lastBlock`.
- **Chain id** is still checked for every peer, and heads must be non-negative integers.

**Censorship resistance: no early cut-off (kept).**

- Heads are taken until `deadlineMs` (30 s).
- The target is the second-highest head so far minus the confirmations, never below `lastBlock`.
- A late head is read in the current round.
- A head that raises the target starts a higher round, where every peer is read again.

**Fail closed, and no requests after the end:**

- The reader refuses when every head and read has settled without two distinct fresh agreeing peers in the current round,
  or at the deadline.
- Every await-dependent step of a read (`getBlock`, then `fn`, then the `getBlock` recheck) first checks that its round is
  still current and the call is unsettled. A timed-out, decided or superseded read never starts its next request.
- The round's `AbortSignal` is passed to `fn` as its third argument, for readers that can cancel. Existing callers ignore
  it, and viem's `readContract` and `getBlock` cannot take it.
- Requests already in flight cannot be recalled, but their results are discarded.

## Tests (focused, `--test-concurrency=1`, low memory)

```
node --test --test-concurrency=1 test/windows-host-identity.test.mjs test/windows-host-identity-quorum.test.mjs
# tests 21, pass 21, fail 0
```

**`windows-host-identity.test.mjs` (9 tests):**

- The 14-scenario differential against the real `LeaseReader` gives identical verdicts.
- Name check, ownership and the agent boot are unchanged.
- The fake RPCs now return the block `number`, and a block's timestamp belongs to the chain, the same for every RPC and
  every read. Before, each fake computed it from its own head and the current time, so one block had different
  timestamps; that is not how a chain behaves, and the stricter key exposed it.

**`windows-host-identity-quorum.test.mjs` (12 tests; 6 are new):**

| # | Test |
| --- | --- |
| 1-3 | Late honest heads outvote a fast liar: 500 ms or 1 s late; a liar's fastest read; a fast stale head moved past; a far-future head ignored. |
| 4 | Freshness after the whole snapshot (the clock moves 2 minutes during the read). |
| 5 | Fails closed: split; liar, honest and dead; one fresh with dead and wrong-chain peers; a three-way split; two stale; a hung peer refused at the deadline; an honest answer after the deadline refused; one RPC configured. |
| 6 | The whole snapshot (owner, operator, code) and the block hash must agree. |
| **7** | **The reported bypass.** A fast liar returns one fixed forged hash and a forged value. A late honest head raises the target, so the liar really is read at 998 and 999 (asserted). With the two honest peers differing, the reader refuses and never accepts the liar. With the honest peers agreeing, it decides `h1@999`, never the liar. A liar across three rounds is also refused. |
| **8** | The same client twice, or two clients on one RPC host, is refused at construction. Distinct hosts are accepted. |
| **9** | A returned block numbered differently from the one asked for is refused. A malformed hash (`0xabc`, no `0x`, non-hex, a number) is refused. |
| **10** | A superseded round never decides. Its slow reads agreeing at 998 after the target moved to 999 do not count; the result is `v@999`, and the superseded round's signal is aborted. With a slow `getBlock`, the superseded round never calls `fn` at 998. |
| **11** | After the deadline, a `getBlock` that answers later does not go on to `fn`. After a decision, a slower third peer does not go on to `fn` either. |
| **12** | Overlapping calls on one reader. An older call targeting 998 (slow) and a newer one at 1098 (fast): the newer decides `v@1098`, and the older one's 998 agreement is refused at the decision and re-read at 1098 (`v@1098`, never `v@998`). A later call whose peers are behind the accepted block refuses. |

**Mutation checks** (scratch copies, run through `QUORUM_MODULE=<copy>`):

| Mutant | Caught by |
| --- | --- |
| Q0: the reported bypass (key without block or timestamp, votes shared across rounds, responses counted instead of peers) | #7, which shows it decided the forged value |
| Q2: a superseded round's results count | #10 |
| Q3: no high-water check at the decision | #12 |
| Q4: no guards between steps | #10, #11 |
| Q5: returned block number not checked | #9 |
| Q6: hash not validated | #9 |
| Q7: duplicate client allowed | #8 |
| Q8: late heads ignored | #1, #2, #3, #7, #10 |
| Q9: no deadline | the hung-peer test is cancelled at the 15 s test timeout |
| Q10: no freshness after the read or at the decision | #4 |
| Q11: hash not in the key | #6 |
| Q12: the block never moves up | #3, #7, #10 |
| Q1: responses counted instead of distinct peers | **not caught (equivalent)** |

Q1 survives because, in the current structure, each peer is read at most once per round: its head arrives once, and a
round reads each head once. The per-peer set is therefore defence in depth. The configuration check (Q7) and the per-round
votes (Q0, Q2) carry the property.

The broad repository suite was not run, as instructed.

## Docs

`docs/network/independent-windows.md`, "Name check", now states both properties separately (authorization and
censorship resistance) and how the reader fails closed. The run-on-Linux table lists the new adversarial tests. The
native-verification section from the previous pass is unchanged.

## Notes for review

- **Callers.** `checkEndpointOnChain`, `host-ownership.mjs` and `host-onchain.mjs` (which passes only `clients`) are
  unchanged and pass.
- **`LeaseReader` comparison.** The differential with `LeaseReader` covers the scenarios both readers handle (no
  late-head rounds). The late-head rounds go beyond `LeaseReader`, which has a 250 ms grace, single round, so it cannot
  re-read a peer. The other worker owns that code.
- **Cancellation.** `AbortSignal` cancellation reaches only readers that use it. Requests already sent by viem run until
  their own 15 s transport timeout, and their results are discarded.
