# IPNS publisher, anchor and cutover: final closure

**Status: the source closure is complete and verified; nothing is applied to main.**
- Root ran `patches/build.py` with an exact scratch apply: `enclave-apps.patch` is
  `3329613eb607c1acfad681b26a46a2d0bc82e0b8e57699e83b4bb6a79c72d72f`, and `enclave.patch` is
  `916689be35215498932cda4399983b5c483567890db671718a3f1f4ee591a329`.
- All 29 patched sources on disk still equal `patches/MANIFEST.json` (`9acb8e5a…`).
- **Not done:** no signing, no sending, no deploy, commit, stage, restart or top-up. No key, SSH, credential, wallet
  prompt or new contract was used.

**Governance** (`work/effective-goal-requirements.txt`):
- existing contracts first;
- Enclave platform administration and the owner's migration control are preserved;
- the goal is resilience to external interference;
- no step anywhere is irreversible: no `retire`, no ownership or authority burn, and the old IPNS authority is never
  burned.

**Historical evidence (for the OLD source only):** the earlier 51/51 Rust, 7/7 e2e and 9/9 fork runs on
`271da791…`, the earlier reports, and the frozen plan. Every current claim below is for the new bytes.

## 1. Contract necessity: existing contracts first

**Result: no new contract is required.** ReleaseAnchor is an optional, additive proposal, needed only for unattended CI
release with a narrowly scoped key.

| Option | Contracts | Per release | Evidence |
| --- | --- | --- | --- |
| **A. Existing ledger** (`setConfig`) | deployed, unchanged | one owner signature: `value: /ipfs/<CID>` via `enclave config set`, or site-release `publish-plan`; the deployed 1.0.5 already supports it | the current production config uses `value`; removing the `site-root` URL dependency needs no code |
| **B. Existing EnclaveAddressBook** `0xab21…0907` | deployed, unchanged | one owner signature: `setMany` of 3 address-valued keys (sequence, digest 0..20, digest 20..32 + CID prefix) | `snapshots/book-evaluation.json` (`6d6794c5…`), below |
| **C. ReleaseAnchor** (optional, additive) | one new independent contract; nothing existing is modified or migrated | none: a CI delegate calls `publish(cid, expectedSeq)`, CID-only, ≤ 180 days, owner override and revoke | the tests in §4 |

**The book, measured read-only** at Base block 52856375 (3 of 3 providers agreeing):
- runtime `0xe4f570e9…` (1,809 bytes), owner `0x0b2d009c0c9Af05b12100D77F3c815fea822eE61`, 13 entries;
- the deployed runtime has `set`, `setMany`, `addr`, `all` and `setOwner`, but no `pendingOwner` or `acceptOwnership`
  selector, so the deployed ABI differs from source HEAD;
- both the current IPNS CID and the apex CID **round-trip** through the 3-key encoding;
- the owner's `setMany` simulation returns **ok** (estimated 240,737 gas); the same call from a narrow CI key reverts
  `!owner`.

**Why C exists at all:** the book has exactly one writer, the platform governance EOA that also repoints the registry,
ledger and catalog. It has no per-key writer, no expiry and no compare-and-swap. A CI key could therefore publish
through the book only by holding the governance key. Option A's session route is broader too: a session may
`setConfig` only on a vault-held record, and it can rewrite the whole config. C is the minimal additive way to give CI
"choose this CID" and nothing else.

If unattended CI release is not wanted, **use A** (or B with a book-read mode, which is not implemented) and **do not
deploy C**. The publisher's legacy `value` path is unchanged and tested.

## 2. Defects fixed in `ipns-publisher` (root's review), with real negative controls

| File | Base sha256 | Now |
| --- | --- | --- |
| `src/anchor.rs` (new) | `770cb956…` (the previous round) | `cf0e60be770913ac…` |
| `src/webreq.rs` | `39d9850e…` | `1c6c3bed78b3e8c8…` |
| `README.md` | — | `f11a00fd49a3ebee…` |

### 2.1 Public-host identity and loopback

**Measured `webreq::Url::parse` behaviour:** it does not normalize. `user@rpc.example`, `rpc.example:`,
`rpc.example?k=1`, `127.evil.example` and `0x7f.0.0.1` all stay verbatim in `host`.

**The fix: `parse_rpc_url`.** It uses the grammar of the s3-ipfs-adapter's `contract_wallet.rs`, plus the folds of
`network/rpc-identity.mjs`:
- **Refused:** userinfo, query, fragment, escapes, backslash, whitespace and non-ASCII.
- **Hosts and ports:** a numeric host must be a dotted quad, and a port is 1..65535. IPv4-mapped and NAT64 addresses
  count as their IPv4 host.
- **Loopback:** a parsed `Ipv4Addr`/`Ipv6Addr::is_loopback()`, or exactly `localhost`.
- **Votes:** one per public host whatever its port, path, case or trailing dot, and one per loopback port.
- **Dialing:** the dialed URL is rebuilt from the parsed parts, and status keeps a `host:port` label.

**Negative control on the old parser:** `logs/endpoint-negative-control-2.log`, exit 101, **28 violations**,
including:
- `rpc.example:443/a + :8443/b` counted as two providers;
- `http://127.evil.example/` and `http://127.0.0.1.evil.example/` accepted as plain-http loopback;
- `127.1`, `127.0.0.256` and `127.0.0` accepted;
- userinfo, query, fragment, percent-escape, empty/0/`+` ports, bad labels, non-ASCII, backslash and an unclosed IPv6
  bracket all accepted.

**The cutover tool applies the same rule:** its quorum uses `network/rpc-identity.mjs` itself. The plan also refuses
any publisher RPC list that the publisher's stricter grammar would refuse, or that names one provider twice. The
production list is 3 distinct providers.

### 2.2 IPv6 `Host` header

The dialed IPv6 host is bare, and the header is now bracketed (`[::1]:port`). **Negative control:** with the old header
code, `logs/host-header-negative-control.log` exits 101 with `host: ::1:port`. IPv6 loopback is bindable on this host,
so the test really ran.

### 2.3 Kept

The chunked-body fix (`chunked_complete`); its regression tests pass.

## 3. Full-DAG availability (no root-only claim)

- **The defect:** the delegate tool `anchor-release.mjs` (base `7ce02e82…` → `bdb8dc5065ac4a0c…`) and the cutover's
  activation gate counted a gateway that served only the root block.
- **The fix:** a gateway counts only if its `?format=car` export verifies completely with site-release's
  `scripts/site-release/car.mjs` `readCar`, within a byte bound (512 MiB by default). Every block must hash to its CID
  and be reachable from the root, and every file must reassemble.
- **The test:** the fork test's mirror serves the **valid root block** but drops a child from its CAR. It blocks
  activation, and it makes the delegate tool exit 3.

**Production, read-only:**
- both the current IPNS CID `bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou` (CAR 35,127,042 bytes) and
  the newer apex CID `bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y` (the logos fix, CAR 39,856,744
  bytes) verify **completely** at `ipfs.enclave.host` only;
- ipfs.io, dweb.link, trustless-gateway.link, w3s.link and 4everland.io all failed;
- the plan therefore keeps activation **blocked** (1 of 2 complete replicas);
- the cutover preserves the current IPNS content initially. Nothing here switches content or publishes.

## 4. Tests on the new bytes (shared queue, actual exits)

| Run | Result | Exit | Peak / cap |
| --- | --- | --- | --- |
| endpoint policy, old parser (negative control) | 28 violations | 101 | 358 / 1024 |
| IPv6 Host header, old header (negative control) | `host: ::1:port` | 101 | 280 / 1024 |
| `cargo test`, fixed | **54/54** (51 + 3 new) | 0 | 368 / 1024 |
| wasm32-wasip2 release build | **`227876b8a02bf571008a2e6d703e6b0ce2c5f14b326ab598d6dfd1330f67699e`**, 1,422,629 bytes, catalog CID `bafybeiauhy7ydrb4dapvyoltj5ikr4myatrpmo4m2viwgbs66w23z4y4la` | 0 | 551 / 1024 |
| wasm probe, public Base, host sockets + loopback SOCKS5 front | publicnode and base.org reach the `eth_call` boundary; a wrong pin is refused; 15 ATYP-DOMAIN connects; drpc HTTP 429 | 0 | 96 / 768 |
| anchor e2e (anvil + kubo + this wasm) | **7/7** | 0 | 477 / 768 |
| Base-fork cutover (anvil fork, kubo, this wasm, the real 1.0.5 `59a1cec5…`) | **9/9**, including the root-valid/child-missing mirror, lost receipt, pin/revoke, duplicate key holder, rollback | 0 | 500 / 768 |
| book evaluation (read-only) | §1 | 0 | 78 / 512 |
| production read (read-only) | §3, §5 | 0 | 163 / 512 |
| production plan / status (read-only) | plan 0; status 20 (blocked) | 0 | 159 / 512 |

**Not re-run:** forge 16/16 (the contract source is unchanged at `50f9710f…`, artifact `f592eb23…`). Logs are in
`work/ipns-production-cutover/logs/`.

## 5. Production facts (read-only, Base block ~52856424)

- **The deployment:** `0xd9798e4c…` is active, but its lease is **expired**: `leaseUntil` 1792488541, against a read at
  ~1792502300. That is the gas shortage handled separately; nothing here tops it up or restarts it.
- **Unchanged:** the owner `0x0b2d…eE61` (nonce 1113, 0.0042 ETH), appRef index 5 (1.0.5), envelope `d59dc724…`.
- **The publisher's endpoint does not answer.** delegated-ipfs.dev still serves sequence **1026**, valid until
  2026-10-27 05:41 UTC, for the older CID above. The sequence floor is 1026, and higher hidden records are not ruled
  out.

## 6. The unsigned plan (option C only; `plan/production/`, block 52856530)

| File | sha256 |
| --- | --- |
| `plan.json` | `74a285fb…` |
| `publisher-config.json` | `91456ac8…` |
| `version-template.json` | `6e51d084…` |
| `anchor-deploy-calldata.hex` | `dc9ff976…` |

**The plan's values:**
- anchor `0xDE896c485d794361465121EEa8A1951AAfDdB310` (CREATE2), codeHash `0xd706b950…b0d8`;
- new envelope `dde23ebd…` (871 bytes), `sequenceOffset` 1,000,000, `authorityTtlSecs` 86400;
- every precondition is OK except the complete-DAG replicas (1 of 2).

**Status:**

| Step | State |
| --- | --- |
| publish-version | pending (CLI) |
| deploy-anchor | pending |
| set-delegate | waiting |
| fund-delegate | blocked: no delegate chosen |
| activate | waiting |
| verify | waiting |

The next transaction, unsigned, is `deploy-anchor` at owner nonce 1113, with gas 1,432,243 from simulations at 2
providers; drpc was rate-limited.

**Cost:**

| Item | Cost |
| --- | --- |
| owner total, at a 0.005 gwei base fee, fork-measured gas | ≈ 0.000156 ETH |
| of which: deploy | 0.0000120 ETH |
| of which: activate | 0.0000045 ETH |
| of which: delegate funding for 200 releases | 0.000138 ETH |
| each later release | ~0.0000007 ETH |

## 7. Patches for root (`work/ipns-production-cutover/patches/`)

**`enclave-apps.patch`** (`3329613e…`):
- base: enclave-apps HEAD `50f93d74…`; the `ipns-publisher` files are unchanged since `928646f`;
- files: Cargo.toml, Cargo.lock, README.md, src/main.rs, src/webreq.rs, and the new src/anchor.rs;
- other workers' dirty crates are not captured.

**`enclave.patch`** (`916689be…`):
- base: enclave HEAD `fd1cc627…` **plus the uncommitted site-release closure**: the hunk bases `deploy.yml`
  `0f6361b5…` and `site-release.md` `91df5693…`, and the dependency `scripts/site-release/car.mjs` `41ef4092…`. Commit
  that closure first;
- new: `tools/ipns-release-anchor/**` and `tools/ipns-cutover/**`;
- the hunks are kept in `patches/hunks/`. The CI step is gated on `vars.SITE_ANCHOR_CONTRACT`, uses full-DAG gating,
  and is marked optional;
- it also depends on `network/rpc-identity.mjs` `74cb965e…` and `sdk/storage/unixfs.mjs` `38cea972…`, both committed.

## 8. Owner actions, and what remains

**Option A (no new contract):** one `enclave config set` per release, with `value: /ipfs/<CID>`. Optionally first,
upgrade to the reviewed 1.0.6 component, which brings the chunked-body and RPC fixes; this needs the catalog publish
plus `setAppRef`.

**Option C (optional):**
1. publish 1.0.6;
2. deploy the anchor;
3. `setDelegate` with the chosen CI address;
4. fund it;
5. one activation multicall.

Before activation, a second complete replica of the initial CID is required.

**Both options:**
- restore the publisher's lease first (handled separately);
- add a fourth RPC provider (drpc's free tier rate-limits);
- migration away stays a config change, plus a reversible `setDelegate(0, 0)`.

**Residual trust, stated plainly:**
- the IPNS key (any holder can sign a higher sequence; the anchor binds only the measured publisher);
- the Enclave-operated fleet that runs the publisher;
- third-party routing (delegated-ipfs.dev, the DHT, cid.contact);
- the public RPC providers;
- the content's availability, currently complete only at Enclave's gateway.
