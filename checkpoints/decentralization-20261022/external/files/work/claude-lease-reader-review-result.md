# LeaseReader quorum fix: late honest heads, one deadline, freshness at acceptance

Repository `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`, uncommitted. Changed only:

- `network/lease-reader.mjs`
- `test/lease-reader.test.mjs`

Both files were clean at HEAD before this work. No commits, SSH, production calls, chain writes or GUI. No Rust
builds. No mutation was run on any shared file: the before-fix evidence below is the original code, run unchanged.

Hashes after the change:

- `network/lease-reader.mjs`: `b0e1bacc8d5986129e0a60f7d3c1d66e2ba55cf94397975f644fe6c033453d64` (before: `bc76c183…71fc1`)
- `test/lease-reader.test.mjs`: `6a2ad30a69a2dcc8216990cd105280b65da86ac686271417c2789bb26d51e391`
- `MUTATION` markers in both files: 0

**The sia-s3 storage baseline is still pending.** It has not run. That Rust source is untouched (`src/store.rs`
sha256 `94c4e445…0e966f`, as the coordinator confirmed), and no storage claim in this report depends on it.

## The defect, reproduced on the unchanged code

`agreed()` froze the set of readers at the first two heads plus 250 ms. A fast liar beside a fast honest RPC therefore
disagreed, and a slower honest RPC (head later than 250 ms) was never asked: no quorum, although two honest RPCs answer
well within any deadline. The same code also had no overall deadline, and checked a block's freshness only before
`read()`.

I added 5 tests first and ran them against the original `lease-reader.mjs`. Log:
`/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-before-fix.log` (16 pass, 3 fail, 2 cancelled).

| Test | Original code |
|---|---|
| fast liar + fast honest + honest head 80 ms late (grace 10 ms) | **fail**: `no fresh agreeing chain quorum` |
| liar's low head makes the first block stale; late honest head | **fail**: `no fresh agreeing chain quorum` |
| block ages past `maxBlockAgeMs` between the read and acceptance | **fail**: accepted (missing rejection) |
| all reads hang; `deadlineMs` 150 | **cancelled**: never settles |
| an agreed inactive lease, then an outage | **cancelled**: the outage read never settles |

## The fix (`LeaseReader.agreed`, same signature, same result shape)

It brings `agreed()` to the rule `network/service-index.mjs`'s `agreedRead` already uses.

- **Choosing the block shuts nobody out.** After two heads plus `headGraceMs`, the block is the second-highest head
  minus `confirmations`, never below `lastBlock`. A head that arrives later still reads at that block. The quorum is
  unchanged: two distinct peers must return the identical whole value (`canonical`, with block hash and timestamp
  included). One peer never wins, and there is no fallback to a first answer.
- **Newer-block retry.** If every reader finished without a match and later heads now give a strictly newer block
  (for example, a liar's low head made the first block stale), the read is repeated there with every peer that
  reported a head. It never moves to an older block.
- **Freshness** (not in the future, not older than `maxBlockAgeMs`) is checked:
  - before the read;
  - after the read and the block-hash recheck;
  - again at the moment two answers match. `lastBlock` rises only then.
- **One deadline** (`deadlineMs`, new constructor option, default 30 s, range 100 ms to 300 s) bounds the whole call:
  - every request goes through a gate. It is refused once the outcome is decided, the round is superseded, or the
    deadline has passed, and it is waited for at most the time left;
  - `read()` receives each client behind the same gate (a `Proxy` over its methods), so its own requests obey it too;
  - in-flight viem requests cannot be aborted (its per-call API takes no signal), but nothing awaits them and nothing
    new is sent.
- **Unchanged:**
  - `lastBlock` rollback floor;
  - batching and queueing in `refresh()`;
  - `limited()` rate-limit-only retry;
  - `authorityPins`;
  - the `failures` array (read failures, as before, plus a stale-at-acceptance note);
  - the error messages consumers match on: `chain quorum unavailable`, `no fresh agreeing chain quorum` (a deadline
    refusal adds `within N ms`);
  - `hold()`, the cache rules (only a definite answer deletes or replaces an entry), and `AdmissionGate`.
- **Latency difference.** A refusal can now wait for a still-outstanding head, up to `deadlineMs`, where it used to
  return as soon as the two early readers disagreed. That is the point of the fix: the late honest RPC gets its chance.

## Tests

**`test/lease-reader.test.mjs`:** 21 pass, 0 fail. These are the 16 existing tests, unchanged, plus 5 new ones:

- a fast liar plus fast honest RPC do not shut out a slower honest head;
- a liar's low head is outvoted at a newer block once the late honest head is in (block 898 tried and found stale,
  then 998; `lastBlock` 998);
- a block that ages out between the read and acceptance is refused, and `lastBlock` is not raised;
- **one deadline:** a fully hung read is refused at about 150 ms. The cached lease stays to its own validity. Once the
  hung reads are released, no further request is issued (call counts unchanged). A later reader is not stuck;
- **inactive owner facts:** an agreed `active:false` lease replaces the cache, and `AdmissionGate.allows` turns false
  at once with the proof still fresh. A later outage plus `hold()` does not revive it.

**Integration regression:** 29 consumer test files, run one at a time with `--test-concurrency=1` and
`--experimental-test-isolation=none`. Log: `/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-integration.log`.
27 files pass outright, including `windows-host-identity.test.mjs` (9/9). That file runs LeaseReader and
`quorumReader` side by side over 14 liar, stale, fork and reorg cases and requires the same verdicts.

Two files fail:

- **`test/management-plane.test.mjs`: 25 pass, 1 fail.** Test 17, line 462, is the case the review asked for. The
  agreed block is 88 s old at the read's start and 91 s or more once five reads finish. The lease reader now refuses
  that block itself, so management-auth answers **503 `chain_unavailable`** where the test expects **504
  `authorization_expired`**, a label management-auth produced from its own later check.
  - Nothing is forwarded either way: the refusal now comes earlier.
  - This is a direct consequence of enforcing freshness at acceptance.
  - `network/management-auth.mjs` and its test are not mine. The fix belongs to their owner: map a stale-block refusal
    from the reader to 504 `authorization_expired`, or update the expectation at line 462.
- **`test/service-index.test.mjs`: 12 pass, 3 fail** ("RPC peers must use distinct public hosts or distinct loopback
  test ports"). Unrelated to this change:
  - the message comes from `scripts/network/service-index.mjs`, modified at 17:21 today by another workstream;
  - that script imports only `network/service-index.mjs`, never `lease-reader.mjs`;
  - the test passes the same `--rpc` URL twice.

**Memory.** Each file was measured as process max RSS. Most were 57–150 MB. Over 150 MB:

| File | Max RSS |
|---|---|
| `site-independent-browser` | 699 MB |
| `service-index` | 405 MB |
| `prepare-host-policy` | 361 MB |
| `deployed-sources` | 338 MB |

These figures are each process's total RSS. Lower absolute memory was not achievable for those files; they are not
re-run.

## Remaining and not mine

- **Bundles.** `windows/node/host-admission.bundle.mjs` and `relay/network-runtime.bundle.mjs` embed a copy of the old
  `LeaseReader`. They keep the old behaviour until their owners rebuild them.
- **management-plane line 462**, as above.
- **No real-RPC validation.** All tests use injected clients.

---

# Round 2: coordinator final review

Same two files only. Hashes now:

- `network/lease-reader.mjs`: `096e4f7e6ee5d095c6fd1d00489903610c3c6dc35c33aa757bf2211769fec9eb`
- `test/lease-reader.test.mjs`: `76b545a4a6a7f10d2794a3470f0880de863434df3b82882ac712cf283b2abb5a`
- `MUTATION` markers: 0
- `git diff --stat` for the two files: 271 insertions, 49 deletions

No consumer file was edited. The sia-s3 storage baseline is **still pending** (not run; Rust source untouched).

## Changes

- **High-water mark checked again at decision.** When two answers match, the block must be no older than
  `lastBlock`. Another call on the same reader (`registryEntries`, `bookAddress`, a direct `agreed`) may have
  accepted a newer block while this one read. If so, the read moves up to the block `choose()` now gives (at least
  `lastBlock`). If no newer block is available, it refuses. It never returns an answer from below an already-accepted
  block. `lastBlock` is set only at acceptance.
- **Headers checked completely.** `getBlock` must return:
  - `number` equal to the requested block (bigint or safe integer);
  - a 32-byte hex `hash` (normalized to lowercase for comparison and in the result);
  - a non-negative whole-second `timestamp`.

  The header read again after the read must match in hash and timestamp, and in number (checked against the request).
  A failure excludes that peer, and the reason goes into `failures`.
- **Clients validated.** A config is refused if it has fewer than two clients, the same client object twice, `null`,
  or a client missing `getChainId`, `getBlockNumber` or `getBlock`. The constructor throws. `agreed()` and `refresh()`
  reject if `clients` is reassigned to such a set; tests reassign `reader.clients`.
- **Header placed last, reserved fields refused.** The answer is `{...value, hash, blockNumber, timestamp}`. A read
  callback that returns any of `hash`, `blockNumber` or `timestamp`, or that returns a non-object, makes the whole
  call reject at once with that reason (for example "returned the reserved field timestamp"). This is a caller bug,
  reported as one rather than as a quorum failure. I checked every consumer callback (reconcile-core,
  host-admission-runtime and policy, management-auth, owner-signature, authority-profile, and LeaseReader's own); none
  returns those keys.
- **Unchanged:** full-snapshot dedup by `canonical` with two distinct peers, the late-peer joining and newer-block
  retry, the deadline and gates, batching, rate-limit retry, pins, the cache and `hold()`.

## Tests (focused only)

**`test/lease-reader.test.mjs`: 25 pass, 0 fail.** That is 21 from round 1, with their fakes now returning `number`,
plus 4 new:

| New test | What it shows |
|---|---|
| overlapping reads | Deterministic. Call A chooses block 998 and stalls in its read; call B, on newer heads, accepts 1008; A, released, returns block **1008**, not 998. |
| headers | Another block's header, a missing number, a 31-byte or non-hex hash, a negative or non-numeric timestamp, or a timestamp that changes between header reads: each is refused, and `failures` names the reason. |
| clients | `[c, c]`, a client without the read calls, or `null` is refused, in the constructor and after reassignment. |
| reserved fields | Each of `timestamp`, `hash` and `blockNumber`, `null`, an array, or a non-function read rejects with its reason; a normal answer carries the checked header. |

**The new tests fail on the round-1 code.** That run used a scratch copy in `/tmp`: copied `network/` and `relay/`
sources plus the round-1 `lease-reader.mjs`, with only `node_modules` symlinked. Log:
`/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-round2-before-fix.log` (21 pass, 4 fail). The
overlapping-reads failure is `'998' !== '1008'`, an answer from below an accepted block. The shadowing failure: a
`timestamp` returned by the callback was not refused. The scratch copy is deleted.

**Targeted `test/management-plane.test.mjs`** (owned by another worker, not edited):

- **On the shared tree: 8 pass, 22 fail**, all `chain_unavailable`. Log: `lease-reader-management-shared.log`; max
  RSS 148 MB. Its fake `getBlock` (line 54) returns no `number`, so every header is now refused.
- **In a disk scratch copy of the repo** (`~/.cache`; sources copied, `node_modules` symlinked; now deleted), adding
  `number:blockNumber` to that one fake makes it **30 pass, 0 fail**. That includes test 17, which in round 1 expected
  504 at line 462. Log: `lease-reader-management-scratch-fixture.log`.
  - So the only change management-plane needs is that one fixture line.
  - Its owner should apply it with this source, or I can apply it if given that file.

**Other LeaseReader fakes without `number`.** Found by search and not run, per the no-broad-suite instruction. Each
needs the same one-line `number: blockNumber` in `getBlock`:

- `test/network-authority-pins.test.mjs:12`
- `test/connectivity-chain.test.mjs:7`
- `test/provider-bootstrap.test.mjs:69`

`test/windows-host-identity.test.mjs` already returns `number`.

## Still open

- **Fixtures:** the four consumer fakes above.
- **Bundles:** rebuilding `windows/node/host-admission.bundle.mjs` and `relay/network-runtime.bundle.mjs` is deferred
  until this source is committed.
- **Validation:** no real-RPC validation yet.

---

# Round 3: LeaseReader integration, RPC identity, policy bounds

The Rust storage baseline is the coordinator's. I ran no cargo, edited no storage file, and make no claim about it.
No commits, bundles, production, SSH, Wine, GUI or chain writes. No broad suite.

## Files and hashes

| File | sha256 | Change |
|---|---|---|
| `network/lease-reader.mjs` | `b80cd33eed4edaa51caf9f9765ed211b0e36ceef8d5c71677cc32cf0400278f5` | RPC identity, client and policy validation |
| `test/lease-reader.test.mjs` | `9d26234624afad7c6f7afce9ff7b0494de0391e08c56303888bd4f653ce56cfd` | 4 new tests |
| `test/management-plane.test.mjs` | `abff9b1f93c2f947f4ae9582be0a830ec81486d3756c74c69303f958da7a60b4` | fake `getBlock` returns `number: blockNumber` (1 line) |
| `test/network-authority-pins.test.mjs` | `58105057618b4af61990dd6f86d785f3031bcccaa131e6902f96e9643dc77b60` | the same 1 line; and its two pin-validation constructions now pass `clients:[peer(),peer()]` instead of `clients:[]` (assertions unchanged, see below) |
| `test/connectivity-chain.test.mjs` | `6a0e0034f3e2ec8bf0a3d4c021ab6ad993cc09fb0c820f364e9230e9c9b545e0` | the same 1 line |
| `test/provider-bootstrap.test.mjs` | `4cbcfba08803bc2347edef1246c239cf80b914fa98b1703b9fcb380fbb78cc9b` | the same 1 line |

`MUTATION` markers in all six files: 0.

## Changes in `network/lease-reader.mjs`

The round-2 deadline, current-round and high-water floor, strict header and reserved-field changes are unchanged.

- **`rpcIdentity(url)`, exported.** The same rule as `service-index.mjs` `rpcIdentity` and the service-index CLI
  `peersFor`, written locally so this module does not depend on service-index:
  - A public host is one vote: lowercase, any trailing dot removed, whatever the path, query (API key) or port.
  - A loopback test chain (`localhost`, `127.0.0.1`, `[::1]`) counts by port.
  - Only HTTPS. Credentials and fragments are refused, and so is a URL that does not parse.
  - Errors never echo the URL.
  - Distinct identities are distinct configured endpoints, not proof of independent operators.
- **Constructor with `rpc`:** 2 to 16 URLs, all with distinct `rpcIdentity`.
  - Before, raw `URL.hostname` values were compared. Case and port aliases were already caught, because `hostname`
    is lowercased and excludes the port; a trailing-dot alias (`rpc-a.example.`) counted as a second vote.
  - Credentials and fragments were accepted.
- **Injected `clients` (constructor, and again at every read, so a reassigned set is checked):**
  - 2 to 16 distinct objects, each with `getChainId`, `getBlockNumber` and `getBlock`.
  - A client that exposes its transport URL (viem: `transport.url`; verified for real viem http clients) is also
    counted by `rpcIdentity`. Two clients for one host are refused, and a malformed or non-HTTPS exposed URL is
    refused.
  - A client with no visible URL is a test double or a caller's own transport. It stays allowed and is known only by
    object identity, which the caller vouches for (documented in the code).
- **Policy bounds (constructor, and again at every read):**

  | Field | Allowed |
  |---|---|
  | `chainId` | positive safe integer |
  | `maxBlockAgeMs` | 1000 to 120000 |
  | `confirmations` | 1 to 64 (before: unbounded) |
  | `deadlineMs` | 100 to 300000 |
  | `headGraceMs`, `retryDelayMs` | 0 to 10000 (before: unchecked, settable to NaN, Infinity or negative) |
  | `now` | a function |

## Tests

**4 new tests in `test/lease-reader.test.mjs`:**

| Test | Covers |
|---|---|
| same-host aliases | case, trailing dot, port, path, query key all refused; distinct hosts allowed; loopback by port |
| malformed configuration | http, credentials, fragment, not a URL, 1 URL, a string, 17 URLs; no secret in the message |
| injected clients | two real viem clients on one host (`https://rpc-a.example/k1`, `https://RPC-A.example./k2`) refused; distinct hosts allowed; an exposed http or garbage URL refused; URL-less test clients still read; a reassigned same-host or 17-client set refused at the read |
| policy bounds | bounds at construction; reassigned `headGraceMs`, `retryDelayMs`, `deadlineMs` and `confirmations` refused at the read |

**The new tests fail on round-2 code.** The round-2 `lease-reader.mjs` was rebuilt in a `/tmp` scratch copy by
reversing this round's edits; its hash matched the recorded round-2 hash `096e4f7e6ee5d095…` exactly. Only
`node_modules` was symlinked, and the copy is deleted. Log:
`/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-round3-before-fix.log` (25 pass, 4 fail):

- **Same-host aliases:** the first alias tried, an uppercase host, was refused but with the old message, and the loop
  stopped there. That failure is a message mismatch, not an acceptance; the trailing-dot acceptance is from the code
  above, not this run.
- **Malformed configuration:** a URL with credentials was accepted.
- **Injected clients:** two viem clients for one host were accepted.
- **Policy bounds:** `confirmations: 65` was accepted.

**Final focused run.** One file at a time, `--test-concurrency=1`. Log:
`/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-round3-focused.log`.

| File | Result | Max RSS |
|---|---|---|
| `test/lease-reader.test.mjs` | 29 pass, 0 fail | 124 MB |
| `test/management-plane.test.mjs` | 30 pass, 0 fail | 158 MB |
| `test/network-authority-pins.test.mjs` | 4 pass, 0 fail | 141 MB |
| `test/connectivity-chain.test.mjs` | 3 pass, 0 fail | 120 MB |
| `test/provider-bootstrap.test.mjs` | 5 pass, 0 fail | 139 MB |

Max RSS is each process's total. management-plane is about 8 MB over 150 MB, from that suite's own rig.

**network-authority-pins fixture.** On the first run its "pins are complete" test failed. It built readers with
`clients:[]`, which the new client-count bound refuses before pins are examined. I searched the source tree
(`network`, `cli`, `windows`, `relay`, `management`); no production code constructs a LeaseReader with an empty list.
The test now passes a valid pair, and its `/pin/` assertions are unchanged.

## Still open

- **Bundles:** rebuilding `windows/node/host-admission.bundle.mjs` and `relay/network-runtime.bundle.mjs` waits until
  this source is committed.
- **Validation:** no real-RPC validation.
- **Rust storage baseline:** the coordinator's (cgroup OOM at 768 MiB and 1536 MiB; still pending).

---

# Round 4: loopback HTTP for local chains (CLI rig regression)

**The regression.** Round 3's `rpcIdentity` refused every plain-HTTP URL. `test/helpers/cli-independent-rig.mjs`
builds its gateway LeaseReader from real viem clients on `http://127.0.0.1:<port>` (local Anvil proxies), so it threw
`invalid chain clients: … RPC URLs must be HTTPS`. The new regression below reproduced exactly that against the
round-3 source, before the fix. Log: `/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-round4-before-fix.log`
(29 pass, 1 fail).

## Fix (only `network/lease-reader.mjs`)

`rpcIdentity` now follows service-index's `peersFor`/`rpcIdentity` policy:

- **Public hosts:** HTTPS only, one vote per host (lowercase, trailing dot removed, whatever the path, query or port).
- **Loopback** (`localhost`, `127.0.0.1`, `[::1]`): HTTPS or plain HTTP, one vote per port. A missing port is the
  scheme's default (http 80, https 443), and any loopback name or scheme on one port is one vote.
- **Unchanged:** credentials and fragments are refused, errors never echo the URL, and the client, policy, header,
  deadline and high-water rules are as before.
- **Not changed:** no consumer and no client URL. The rig keeps its real `http://127.0.0.1` viem clients.

## Regression test (`test/lease-reader.test.mjs`)

Two real JSON-RPC servers on `127.0.0.1` answer `eth_chainId`, `eth_blockNumber` and `eth_getBlockByNumber`. Real viem
clients on `http://127.0.0.1:<a>` and `http://localhost:<b>`:

- construct a LeaseReader, and `agreed()` returns an agreed answer at block 998 over plain loopback HTTP;
- work through the `rpc` option with the same URLs;
- `http://127.0.0.1:<a>` plus `http://localhost:<a>` is refused as one vote, both as injected clients and as `rpc`;
- `rpcIdentity`: `http://127.0.0.1` is `loopback:80`, `https://127.0.0.1` is `loopback:443`, `http://[::1]:8545` is
  `loopback:8545`;
- plain HTTP stays refused for `rpc-a.example`, `127.0.0.2` (not in the loopback list) and `8.8.8.8`, as `rpc` and as
  an injected viem client.

## Results

- **`test/lease-reader.test.mjs`:** 30 pass, 0 fail (`--test-concurrency=1`).
- **`test/cli-independent.test.mjs`** (CLI worker's file, run unedited): one run, inside a `systemd-run --user
  --scope` capped at 1200 MiB with no swap; max RSS 146 MB. The forge output already existed; no build ran. **13
  pass, 1 fail.** Log: `/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-round4-cli.log`.
  - Test 13 ("sessions and owner management … through the signed host endpoint") passes. It runs the gateway
    LeaseReader on loopback-HTTP viem clients: the path this round fixes.
  - Test 12 fails at line 261: `enclave session new --preset auth-only` exits 0 where the test expects 1 ("hosted
    sessions relayer" refusal). That is CLI command handling. It does not reach LeaseReader, and `cli/enclave.mjs` was
    modified at 17:50 by the concurrent CLI worker. It is for that worker.

## Final state

| File | sha256 |
|---|---|
| `network/lease-reader.mjs` | `7e29764516db8683b66b509b1fe3f8ff3764c3f84df6bc7bb7ee1f556da52548` |
| `test/lease-reader.test.mjs` | `df57d4669001daafde54df1eba4f4e2dd42a6fe90454198b22443e4150fae419` |

The four consumer fixture edits from round 3 are unchanged. `MUTATION` markers: 0. No commits, bundles, production,
Wine, GUI, cargo or storage edits.

---

# Round 5: address-literal aliases (IPv4 written as IPv6)

**The finding.** `rpcIdentity` counted `https://8.8.8.8` and `https://[::ffff:8.8.8.8]` as two votes: URL serializes the
latter as `[::ffff:808:808]`. The new regression reproduced it against the round-4 source. That source was rebuilt in
a `/tmp` scratch copy by reversing this edit; its hash matched round 4's `7e29764516db8683…` exactly. The new test
failed with `'host:[::ffff:808:808]'`, the earlier 30 passed, and the copy is deleted. Log:
`/home/steven/Documents/Codex/2026-10-18/wo/work/lease-reader-round5-before-fix.log`.

## Fix (only `network/lease-reader.mjs`, browser-compatible: `URL`, a regex and integer math; no Node APIs, no DNS)

- **URL does part of the work already.** It canonicalizes every IPv4 spelling (`127.1`, `0x8.8.8.8`, `134744072` all become
  dotted quads) and IPv6 case and zero compression.
- **Folded on top of that:**
  - **IPv4-mapped `::ffff:0:0/96`** (RFC 4291) becomes dotted IPv4 for the vote and for loopback: to the local stack it
    *is* that IPv4 host. `[::ffff:127.0.0.1]:8545` is the loopback listener on port 8545 (plain HTTP allowed, one vote
    with `127.0.0.1:8545` and `localhost:8545`).
  - **NAT64 well-known prefix `64:ff9b::/96`** (RFC 6052) becomes dotted IPv4 for the vote only. A translator reaches the
    same IPv4 host, but the traffic leaves this machine, so it is never loopback and never allows plain HTTP.
    `http://[64:ff9b::7f00:1]` is refused.
- **Not folded, left as distinct IPv6 addresses (documented in the code):** the deprecated IPv4-compatible `::/96` and
  SIIT `::ffff:0:0:0/96`.
- **No name is resolved.** Two names, or a name and an address, may reach one machine, and nothing here can tell.
  Distinct hosts never proved distinct operators anyway.
- **Public plain HTTP stays refused**, including `http://[::ffff:8.8.8.8]` and `http://[64:ff9b::8.8.8.8]`.
- **Duplicate URLs** have the same identity and are refused (tested).

## Regression (`test/lease-reader.test.mjs`, 1 new test)

- **Refused as the same host as `https://8.8.8.8`:**
  - `https://8.8.8.8/other`, `0x8.8.8.8`, `134744072`;
  - `[::ffff:8.8.8.8]`, `[::FFFF:808:808]:8443`, `[0:0:0:0:0:ffff:808:808]/k`;
  - `[64:ff9b::8.8.8.8]`.
- **Also refused:** `[2001:db8::1]` vs `[2001:DB8:0:0:0:0:0:1]:8443`, and one URL twice.
- **Distinct addresses accepted:**
  - `8.8.8.8` + `8.8.4.4`, both bare and both mapped;
  - `[2001:db8::1]` + `[2001:db8::2]`;
  - `8.8.8.8` + `[2001:4860:4860::8888]`.
- **Edge forms:** `[::ffff:0:1]` and `[64:ff9b::1]` both become `host:0.0.0.1`.
- **Mapped loopback:**
  - `http://[::ffff:127.0.0.1]:8545` is `loopback:8545`;
  - it is refused alongside `http://127.0.0.1:8545` or `http://localhost:8545` (same vote);
  - it is accepted with `http://localhost:8546` (different port).
- **No plain HTTP opened:** `http://[::ffff:8.8.8.8]`, `http://[64:ff9b::8.8.8.8]` and `http://[64:ff9b::7f00:1]:8545` are
  refused.

## Results

- **`test/lease-reader.test.mjs`** (`--test-concurrency=1`): **31 pass, 0 fail.** No CLI test or broad suite was run this
  round.
- **Hashes:** `network/lease-reader.mjs` is `95a7adbfd97f17d98aa7af2b62fc46bd44a4df4aa307e146e99f1559811939b7`; `test/lease-reader.test.mjs` is `47ae8904ace8235f72fbfc740d7b38b7f3fedd838cc5b711e711201e68c2d1ed`. `MUTATION` markers: 0.
- No commits, bundles, SSH, production or Wine. The round-3 consumer fixture edits are unchanged.

## The same gap elsewhere (report only; not edited)

| File | Gap |
|---|---|
| `network/service-index.mjs` `rpcIdentity` (line 167) | lowercases and drops the trailing dot only: mapped-IPv4 and NAT64 aliases of one address count twice |
| `scripts/network/service-index.mjs` `peersFor` (line 86) | same; mapped loopback (`http://[::ffff:127.0.0.1]`) is refused as non-loopback rather than counted as one |
| `cli/independent.mjs` `validateRpcOrigins` (lines 20-37) | compares raw `u.hostname`, so `a.example.` and `a.example` count as two hosts, and mapped aliases count twice; loopback counts by origin plus path, so `http://127.0.0.1:8545` and `http://localhost:8545` (or two paths on one port) are two votes |
| `scripts/independent-custody.mjs` (line 46) | compares raw `new URL(r).hostname`: trailing-dot and mapped aliases count twice (HTTPS only, so no HTTP concern) |

The same rule (the `rpcHost`/`rpcIdentity` pair in lease-reader) would close each gap. The owners of those files
should apply it when they next change them.
