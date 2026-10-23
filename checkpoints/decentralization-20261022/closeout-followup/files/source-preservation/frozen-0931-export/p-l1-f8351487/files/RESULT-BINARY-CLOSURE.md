# L1 pair binary closure: verified Lighthouse, real-binary pairing, opt-in L1 broadcast (RESULT-BINARY-CLOSURE, 2026-10-23)

This builds on `RESULT.md` (baseline `1260cdc`, report `83805a1`, kept unchanged in history). Additive commits only.

**Status: SOURCE + OFFLINE REAL-BINARY TESTS.**
- **Not done:** no install, activation, sync, chain or snapshot download, allocation, SSH, wallet, signing of real funds,
  push or change to a running app.
- **The one exception:** the root-authorized download of the already-pinned Lighthouse artifact into the task workspace.
- **RAM:** the human RAM decision (D2) is still open, so nothing is deployed.

## 1. Lighthouse v8.3.2: download, trust, extraction, pin

| Step | Result | Run / evidence |
|---|---|---|
| Download | Into the task workspace (`bin-staging/`, gitignored): tarball 31,384,350 B, `.asc` 833 B, the key fetched BY FINGERPRINT from keys.openpgp.org and keyserver.ubuntu.com, plus metadata. Nothing installed | fetch-lh-1, fetch-lh-2; `evidence/lighthouse-binary-20261023T080144Z/` |
| Digests | Tarball `ea914e932462d6a93ad78c21377d70f995e05ac224248be0b58c2f4d6740439a` = the pinned GitHub asset digest. `.asc` `4c4ce326…` = pinned | verify-lh-3 |
| Fingerprint authority | The book page (`installation_binaries.md`) states NONE, and my first check correctly refused on that (verify-lh-1). `15E66D941F697E28F49381F426416DC3F30674B0` is stated by `sigp/lighthouse` @ `a376defa` in `.github/workflows/release.yml:195` (the template that writes every release body) and `SECURITY.md:10` (keybase link), and by the v8.3.2 release body (`release-v8.3.2-signing-statement.json`). **All three are ONE trust root: control of the sigp GitHub repository/account.** No web-of-trust path exists; gpg shows `[unknown]` validity. The key servers are transport only: the key was accepted because its primary fingerprint equals the stated one | verify-lh-3 |
| Signature | Throwaway keyring with exactly one primary key (`15E66D94…`, plus its encryption subkey `33679A09…`). `VALIDSIG … 15E66D941F697E28F49381F426416DC3F30674B0`, made by the primary key on 2026-10-22. (verify-lh-2 failed on MY check, which counted the subkey's fingerprint; fixed to compare primaries only) | verify-lh-3 |
| Archive inspection | Before extraction: exactly ONE member, `lighthouse`, a regular file (type `0`), mode 0755, 105,018,160 B, no link. Extracted with Python `tarfile`, using no archive paths, written `O_EXCL`. Any other member or type is refused | verify-lh-3 |
| **Binary pin** | **`11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96`**: ELF x86-64 PIE, dynamically linked against glibc/libstdc++/libz (`ldd` resolves on this host; glibc 2.44 ≥ the required 2.34) | lhelp-1 |
| Version / help | `Lighthouse v8.3.2`; `blst-portable`; `Specs: mainnet (true)`. `beacon_node --help` equals the pinned source `help_bn.md` except two build-feature lists (DB backends `redb`, `mdbx`). **Every rendered flag** is in the binary's own help for every mode (file/semi 18, file/super 18, extip 21, url 17; none missing) | lhelp-1 |

`PINS.json` now pins `consensus.binarySha256` and records the signature provenance. Effects:
- `validate` refuses any other Lighthouse binary;
- the example config is still refused, but now only for the checkpoint fields;
- RUNBOOK §1 has the exact recipe.

**Not done for reth:** its signature is not verified. Root authorized the Lighthouse artifact only, and reth's `.asc` was not
fetched. The reth tarball matches its GitHub digest, and the binary self-reports the tag commit.

## 2. Real-binary tests closing the source-only boundaries

All runs went through the queue (16 GiB floor; one large lane plus small 256 MiB lanes), offline in `unshare -rn` with
loopback up. All final runs are on launcher `l1pair.py` **`a25bd4ea`**.

| Run | What | Result | Peak RSS |
|---|---|---|---|
| **lh-3** | REAL Lighthouse under `run-cl` + REAL reth under `run-el`, mainnet config, empty datadirs | **PASS** | 614 MiB |
| **txb-4** | Two REAL reth peers, TEST NETWORK (chainId 1337), default vs opt-in broadcast + node-side gate probes | **PASS** | 817 MiB |
| **reth-5** | REAL reth mainnet: Base L1 methods, refusals, engine JWT, persisted prune config, gate closed | **PASS**, same values as reth-4 (ready 0.8 s; JWT 200/401/401/401; receipts distance 140000) | 385 MiB |
| unit-9 | Unit suite (adds txBroadcast and the never-render-test-flags assertions) | **20/20 OK** | 256 lane |
| mut-6 | 22 launcher mutants (adds `broadcast-default-on`, `local-propagation-on`) | **22/22 killed** | 256 lane |
| lhelp-1 / verify-lh-3 / fetch-lh-1,2 / fetch-6,7 | Binary help, verification, pinned sources | rc 0 | ≤ 128 MiB |

**lh-3: Lighthouse on mainnet config, offline.**

1. **Refusal through the launcher** (exact production argv, `resume` mode, empty DB): `CRIT Failed to start beacon node:
   "Syncing from genesis is insecure and incompatible with data availability checks. You should instead perform a
   checkpoint sync…"`.
   - The process exits 1 after 2.5 s and is never READY.
   - No hidden checkpoint URL is used: the run is offline and the log has no URL lines.
2. **Counter-control, wrong engine JWT:**
   - Lighthouse logs `Execution engine call failed … 401 Unauthorized` every 12 s;
   - `/eth/v1/node/syncing` keeps `el_offline: true` for the whole 60 s.
3. **Pairing, right JWT.** The test driver appends the TEST-ONLY flags `--allow-insecure-genesis-sync --ignore-ws-check`,
   so the node starts from the EMBEDDED mainnet genesis (slot 0, 2020). Production never renders either flag, and a unit
   test asserts that.
   - **Startup:**
     - READY 2.8 s after start (S's Supervisor with the beacon-API probe);
     - `el_offline: false` at the first poll: the engine API was paired over loopback with the shared JWT.
   - **APIs:**
     - version `Lighthouse/v8.3.2/x86_64-linux`;
     - `custody_group_count 64` (`--semi-supernode`);
     - genesis validators root `0x4b363db9…`;
     - spec: `DEPOSIT_CHAIN_ID 1`, `SECONDS_PER_SLOT 12`, `FULU_FORK_EPOCH 411392`, `GLOAS_FORK_EPOCH 2^64-1`,
       `MIN_EPOCHS_FOR_DATA_COLUMN_SIDECARS_REQUESTS 4096`.
   - **Blobs endpoint:** `/eth/v1/beacon/blobs/0` returns **400 "block is pre-Deneb and has no blobs"**. The endpoint is
     served; there is no data at genesis.
   - **Listeners:** the beacon API is on **127.0.0.1 only**; the only wildcard TCP listener is the configured P2P port.
   - **Data gate CLOSED for the right reasons:**
     - pass: `cl.genesis`, `cl.spec`, `cl.version`, `cl.custody`, `el.chainId`, `el.genesis`;
     - fail: `cl.syncing` (`is_syncing` true, distance 15,493,336 slots), `pair.head` (genesis has no execution payload),
       `cl.blobs`, `el.head`, `el.finalized`, `el.syncing`.
   - **Stop:** SIGTERM, exit 0 in 0.16 s, no leftover listener.
   - **First runs (lh-1):** without `--ignore-ws-check`, the REAL binary itself refused: "The current head state is
     outside the weak subjectivity period … susceptible to long range attacks". That is independent evidence that a stale
     anchor is rejected by Lighthouse, not only by the launcher's 14-day bound. **lh-2 was an accidental exact repeat of
     lh-1:** my test edit had not applied, and I only noticed after the run.

**What remains unproven** (it needs a live network or real data, and is not faked):
- checkpoint-FILE start from a fresh finalized mainnet state (a chain-state download, not authorized);
- forward or backfill sync;
- serving real blobs from `/eth/v1/beacon/blobs/{slot}`;
- data-column custody under load;
- finality;
- HDD throughput.

There is **no pinned public test fixture** offline that contains finalized blob-carrying blocks. Producing one would mean
running signing validators (keys) or tools outside the release tarball (`lcli`), so it was not done. Fresh-blob
availability is proven only by `ready … --need-blobs-from-slot` after activation.

## 3. Opt-in local L1 raw-transaction broadcast (for E)

**Config:** `execution.txBroadcast`, default `disabled`.
- **`disabled`** renders `--disable-tx-gossip --txpool.no-local-transactions-propagation`.
- **`local-raw-propagate`** (explicit opt-in) renders neither. That is standard reth gossip.
- **Both modes:**
  - `--txpool.disable-transactions-backup` (no persisted txs re-sent after a restart);
  - HTTP on loopback with `eth,net,web3`;
  - no `--rpc.forwarder`;
  - no keys, signing, funding or auto-send in the pair;
  - unknown values are refused, and an absent value means `disabled`.

**txb-4.**

*Setup:*
- a TEST NETWORK (chainId 1337), a throwaway genesis in the existing reth fixture format, funding only the PUBLIC
  Hardhat account 0;
- synthetic EIP-1559 transfers signed offline with that public key, using the already-installed viem 2.53.1;
- node A runs the launcher argv with only `--chain` replaced (test seam); node B is a normal peer via `--trusted-peers`;
- both get `forkchoiceUpdatedV3(genesis)` = VALID, then **one empty block** built by reth's own payload builder over
  the engine API (FCU with attributes → `getPayloadV4` → `newPayloadV4` + FCU on both), as a CL would.
- **Why that block is needed:** reth drops peers' tx announcements while "initially syncing" (`transactions/mod.rs:662`).
  That state clears only on a live canonical head (`launch/engine.rs:389`).
  - txb-2, without the block, saw **no propagation in EITHER mode**. Real behaviour: a still-syncing receiving peer drops
    gossip.

| Mode on A | Accepted into A's own pool | Reached peer B | Link | Included |
|---|---|---|---|---|
| `disabled` | yes: hash `0x88f6fc9f…` returned, and A's `eth_getTransactionByHash` finds it | **no**, 30 s | 1 peer each before and after | no (receipt `null`, heads at block 1) |
| `local-raw-propagate` | yes, same | **yes**, at the first poll | 1 peer each | no |

**The method is NOT refused in the default mode.** It admits into the local pool and returns a hash, but the tx never
leaves the node. That difference between admission and propagation is documented for callers. A returned hash is not
propagation, and peer receipt is not inclusion.

**Node-side gates, measured in both modes:**
- **Wrong chain ID** (EIP-155/typed): REFUSED, `invalid chain ID`.
- **Fee above `--rpc.txfeecap`** (default 1 ETH): REFUSED.
- **Replay-unprotected legacy tx:** **ACCEPTED**.
- **Recipient:** **no allowlist** (`0x…dEaD` accepted, and in opt-in mode propagated).

**The general eth API is therefore NOT a portal-only or chain-1-only allowlist.** E's requested gates must be enforced by
E's bounded sender before the bytes reach the port. Root composes E's checks with this standard node. No proxy framework
was added.

**Handoff:** `HANDOFF-TO-E-L1-TX-BROADCAST.md`. Root's note `ROOT-TRANSACTION-INTERFACE-FINAL.txt` and E's
`NOTE-FOR-P-L1-BROADCAST.md` were read. E's tree was not edited.

## 4. Cold bootstrap, weak subjectivity and blob coverage

Re-reviewed for the changes; the design is unchanged.
- **Hidden public defaults:** none in either rendered argv. The real Lighthouse used no URL offline: the genesis state is
  embedded and checkpoint URLs are never rendered by default. reth's NAT lookup is still forced off (`--nat none`).
- **Weak subjectivity:** now enforced in two independent layers, both observed:
  - the launcher's `check_checkpoint` (≤ 14 days, operational);
  - Lighthouse's own refusals: no anchor on an empty DB (lh-3 part 1), and a head outside the WS period (lh-1).
- **Blob coverage:** unchanged. A semi-supernode serves blobs only from its start, for ≤ 18 days. The endpoint path is
  confirmed live on the real binary (400 pre-Deneb). The data is proven only after activation via the gate.

## 5. Resources and native gaps

- **Offline footprint is not production sizing:**
  - reth ~280–310 MiB RSS and Lighthouse ~250 MiB at genesis;
  - reth's datadir is 4.3 GB apparent / 1.5–9.9 MB allocated (sparse MDBX).
- **Production envelope:** unchanged (RESULT.md §6) — 28 GiB of pair MemoryMax against ~24 GiB MemAvailable; D1
  (HDD vs SSD) and D2 (RAM) are still open.
- **Native gaps:** these need activation, not more offline tests:
  - real P2P peering;
  - sync time on HDD;
  - blob serving;
  - mainnet tx propagation through real peers;
  - inclusion.
- **Base on real reth (base-3):** not repeated. The rendered EL argv change only adds `--txpool.no-local-transactions-propagation`
  in the default mode, and Base reads nothing tx-related. reth-5 and lh-3 exercised the final EL argv on mainnet.

## 6. Pins and source

- **Source commits:** `47f4f42` (Lighthouse pin, txBroadcast, real-binary tests, handoff), then this report and the
  txb-4 probe commit (`git log`). Final launcher `l1pair/l1pair.py` `a25bd4ea620e8c8193fe409add6aa80569fce1a76a4ce4ed151bbf15f4a3299d`.
- **Binaries:**
  - reth v2.8.0 `8cdd1f35…` (tarball `809bfe0f…`);
  - Lighthouse v8.3.2 `11b7bca8…` (tarball `ea914e93…`, sig `15E66D94…`);
  - Base v1.5.1 `9c44836d…` (S, read-only).
- **Vendor:** S `959e56fd` byte-identical (`VENDOR.json` `a2bcc3aa…`).
- **Recipe:** `jobs/fetch-lighthouse.sh`, `jobs/verify-lighthouse.sh`, `jobs/lh-help.sh`; RUNBOOK §1.

**Gates added for root** (on top of RESULT.md G1–G7):
- **G8:** install the verified Lighthouse bytes (or re-run the recipe). `preflight` must pass its pin, version and flag
  checks on the installed path.
- **G9:** `execution.txBroadcast` stays `disabled` unless root explicitly approves `local-raw-propagate` for E's composed
  sender. E's sender enforces portal-only, chain-1, EIP-155-only, nonce and bounds before submission.

## 7. Scans and disclosures

- **scan-5:** gitleaks `generic-api-key` hit 5 times. Every hit was Sigma Prime's PUBLIC PGP fingerprint: on
  `release.yml:195` (trust evidence) and in log lines that echo it.
  - `.gitleaks.toml` now extends the default rules with ONE exact allowlisted value (`^15E66D94…74B0$`).
- **scan-6:** crypto-key scanner 0, gitleaks **no leaks** over all 11 commits and over `evidence/`.
- The public Hardhat test key in `test_tx_broadcast_offline.py` is on the project scanner's allowlist and was not
  flagged.
- **Process slips, disclosed:**
  - I ran one short read-only `gitleaks dir evidence` inspection DIRECTLY, not through the queue, while diagnosing scan-5.
  - lh-2 repeated lh-1 because my edit had silently not applied.
