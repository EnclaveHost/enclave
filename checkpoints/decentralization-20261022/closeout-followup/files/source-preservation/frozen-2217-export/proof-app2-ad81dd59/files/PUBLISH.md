# custody-canary-proof: catalog publication request (prepared, NOT executed)

Root task ROOT-PUBLISH-PREPARE (2026-10-23). This is the exact request for the admin `0x0b2d009c0c9Af05b12100D77F3c815fea822eE61`
to publish the reviewed component (source e84a1af) as a NEW, dedicated, free catalog listing.

**Nothing was uploaded, signed or written.** No wallet page or server, no key, no SSH, no hardware. The frozen
component and its build are unchanged: sha256 `7ce32918…ee883`, CID `bafkreid44murq…xiqm`.

## 1. The actual deployed contracts

Confirmed live at block 53001440 by both reviewed RPCs, with 12 read-only requests (`publish/evidence/live-readonly.json`).

| contract | address | identity |
|---|---|---|
| address book | `0xab214342d5a490150a4a977063a2f88e21f80907` | codeHash `0xe4f570e9…c152`. Rebuilt offline from Projects/enclave 6c1135b0f: the deployed original, single-step owner, no `pendingOwner`. Owner is `0x0b2d…` (book-abi-readcheck.json). |
| catalog = book `appCatalog` | `0x18419ca2b502d423a8de6269aeee171a378626e3` | codeHash `0x3f3c4cc028abd3e117465362e196243cafaaffa7508dc6297d78a6b709dcc79f`. Rebuilt offline from `contracts/EnclaveAppCatalog.sol` blob 018e4bff (f2e9a71d0, schema 9), solc 0.8.35 viaIR runs 200; 22733 bytes, exact, no immutables. |
| ledger = book `deployments` | `0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b` | EnclaveDeployments rev 16d, codeHash `0x71d50076…6682` (source-verification-base.json). Not called by the publish; pinned for the later deployment. |

**Not used:** the work/enclave defaults, and the CLI's baked `APP_CATALOG_ADDRESS`. On this checkout the latter is the
retired `0xAc5270…`, which the CLI uses silently if its book lookup times out (§6).

## 2. The exact call

`EnclaveAppCatalog.publishVersion(string slug, string name, string description, string version, string cid, uint32[4] res, string ports, string config, uint256 feePerSec6) returns (bytes32 appId, uint256 index)`
- Selector `0x47910c23`. The function is non-payable: value 0, no publish fee.
- From `0x0b2d009c…ee61`, to `0x18419ca2…26e3`, chain 8453.

| arg | value |
|---|---|
| slug | `custody-canary-proof` (new: `numVersions` = 0 live; nothing existing is replaced or added to) |
| name | `Custody canary proof` |
| description | `Custody canary use ONLY: answers HMAC-SHA256 proofs for dedicated CANARY_ test markers (32 fresh CSPRNG bytes each). Never stage real or user secrets.` |
| version | `0.1.0` |
| cid | `bafkreid44murqsilsg4hy772jt3jo2ogo223qnokchkvsbfrkeppspxiqm` (unlisted live) |
| res | `[vramMb 0, gpuGflops 0, memMb 128, cpuGflops 10]` |
| ports | `""` (a declared `http:N` port would switch the derivation to bundle/2, which is wrong for a wasi:http proxy) |
| config | `{"wasi":"0.2"}`: exactly what `enclave publish` stamps for these bytes. Its own classifier, run on the binary in the tests, gives wasip2 with no threads, set or mem64 markers. |
| feePerSec6 | `0` (free) |

- **Calldata:** `publish/evidence/request.json`, sha256 `13e5a6f4f960bf615c502f90810fabd18a148206bf7600daee8041a68bdea312`.
- **Expected catalog app id:** `keccak256(admin ‖ slug)` = `0x85c5ed4ce282f8c1f434dd600d902d8738a6d8a54b71497dfaa95a1f635813a0`,
  at index 0. A transfer redirect is ruled out at prepare.
- **Approval is automatic.** In the deployed source, `v.approval = msg.sender == owner ? APPROVED : PENDING` (L440), and
  the same transaction emits `VersionApprovalSet(appId, 0, 1)` (L451). The catalog owner is the admin, so no
  `setApproval` call is needed. The local test executes the prepared transaction against the exact deployed runtime and
  checks this: approval 1, CID, config, memMb 128, cpuGflops 10, and `versionFee` 0.
- **Fee rate:** `feePerSec6 = 0`. The catalog cap `maxFeePerSec6` is 1389 (≈ $5/h) by default; the helper reports the
  live value.
- **Contract limits the request satisfies:** slug ≤ 40 bytes (CLI charset), name 1..80, description ≤ 500, version
  1..32, CID ≤ 100, ports ≤ 96, inline config ≤ 4096, memMb 1..1048576.

## 3. Upload normalization and the actual CID

The component must be uploaded before the transaction, because the call embeds its CID.

- **Path:** CLI `pinBytes` (cli/enclave.mjs:2192-2206).
  1. The admin wallet signs `enclave-upload:<sha256>:<expiry>`, with expiry = now + 300 s.
  2. The CLI sends `/v1/apps/upload-token` (relay/api-relay.js:1737-1757). The token is an HMAC over wallet ‖ sha256 ‖
     expiry, reusable until expiry.
  3. The CLI POSTs the raw bytes to `https://ipfs.enclave.host/add-wasm`.
- **No normalization:** the gateway (scripts/ipfs-add-gateway.py) checks the magic and that the layer is 1 (a
  component), then runs `wasm-tools validate` only if `WASM_TOOLS` is set. It strips nothing and rewrites nothing, then
  calls Kubo `/api/v0/add?cid-version=1&pin=true` with defaults.
- **Actual CID:** with cid-version 1, Kubo defaults to raw leaves and 256 KiB chunks. 101,222 bytes is one raw block, so
  the CID is CIDv1 raw sha2-256(bytes) = `bafkreid44murq…xiqm`. `ipfs add --only-hash` (kubo 0.42.0) and an independent
  computation agree.
  - The same path gave hello-world v4 (72,989 bytes) `bafkreibjbefi…`.
- **Caveat:** the CLI does NOT compare the returned CID with a local one. The admin must check that the gateway's `cid`
  equals `bafkreid44murqsilsg4hy772jt3jo2ogo223qnokchkvsbfrkeppspxiqm` before any publish transaction. If it differs, STOP:
  the helper pins the CID and refuses anything else.
- **UNKNOWN:** the gateway revision deployed on nan, whether `WASM_TOOLS` is set there, the production Kubo `Import.*`
  config, and the Caddy size cap.

## 4. Resource footprint on release 16c2999d (pinned, offline)

| item | value |
|---|---|
| on-chain res | vram 0, gpu 0, **memMb 128**, cpuGflops 10 |
| policy (enclave-isolation-policy/1) | cpuPercent 100, memMiB max(128, memMb) = 128, vcpus 1. The same shape as hello-world v4. The CLI default `--mem 256` would change the AppID and measurement. |
| guest | RAM max(1024, 128 + 384) = 1024 MiB, 1 vCPU, 100 % quota. Host reservation 1024 + 768 = 1792 MiB. |
| bundle | enclave-catalog-bundle/1, 101,461 bytes |
| **AppID** | `4f700c921576c417da0e1c7b98a6ef0ae5726f86d096c7f25ea278d4e4116a17` |
| **runtimeId** | `297b6c2c0aee68c38ed612972afd11b12865e21ee39c01f4336e8721b3ef02f8` (wasmtime 49.0.0, jit, cache none) |
| **measurement** | `e5febd103f8cabbad0a439e4daac47aa1caef213867026c442d04976df0a350777d198668c8f0add4f8f141b024cff12` |

- **Tools:** the platform's own derivation (`derive_reference.py`, blob 6c5f0568) and `expected-measurement.sh --pin
  16c2999d7715…` from the release lineage custody/front-prod 837c0061d, run offline with `sev-snp-measure`
  (`publish/derive/appid.sh`, `measure.sh`).
- **Cross-check, same run:** hello-world v4's bundle reproduces exactly what the canary rules already admit: AppID
  `9c3d10f1…0d45`, runtimeId `297b6c2c…02f8`, measurement `9709716c…d230`.
- **What sets the AppID and measurement:** only memMb (via the policy floor) and ports. cpuGflops, fee, config, slug and
  version do not. The evidence is in `publish/evidence/derive.json`.

## 5. The read-only fee and gas helper (root may run it)

`publish/lib/publish.mjs`, CLI `publish/bin/publish-prepare.mjs`, viem 2.53.1 as in the reviewed repos.

- **`--print`:** offline. Prints the exact call above.
- **`--prepare`:** live, read-only, two RPCs (`mainnet.base.org`, `base.public.blockpi.network`) at one agreed block
  (lower head − 2). The read path is fixed at 54 JSON-RPC requests; read pacing and bounded retries (below) add at
  most 26 attempts. It refuses (exit 3, with a code)
  unless all of the following hold:
  - **book:** its code hash matches, and its `appCatalog`/`deployments` entries are the pinned catalog and ledger;
  - **ledger** and **catalog:** code hashes match;
  - **authority:** catalog `owner()` = admin and `pendingOwner()` = 0, so the publish is approved on publish;
  - **catalog:** schema is 9;
  - **listing:** the slug is new (`appIdOf` with no redirect, `numVersions` = 0) and the CID is unlisted;
  - **nonce:** the admin's nonce is settled (agreed = latest = pending on both RPCs);
  - **simulation:** `eth_call` of the exact calldata from the admin returns (expected appId, 0);
  - **rpc_disagree:** both RPCs agree on every fact.
- **Gas:** the larger estimate + 25 %.
- **Fees:** priority = the larger `eth_maxPriorityFeePerGas`; maxFeePerGas = 2 × base + priority.
  - The L1 data fee is `GasPriceOracle.getL1FeeUpperBound(max(unsigned, signedMax − 68))`, sized from the exact
    transaction with the admin's real nonce.
  - The operator fee is `getOperatorFee(gas limit)` when `isIsthmus()`. Otherwise it is undetermined and the helper
    refuses.
  - `totalAtBlockWei` = L2 cap + L1 bound + operator bound, at the agreed block's parameters. This is not a guarantee
    against later changes.
- **Caps:** gas ≤ 1,500,000; maxFeePerGas ≤ 0.1 gwei; total ≤ 50,000,000,000,000 wei (0.00005 ETH).
  - On the local chain the estimate was 609,159 and the prepared gas 761,449.
  - Every refusal in the "refuses unless" list above aborts before anything is written; the admin's balance is only
    reported (`balanceSufficient`, `fundingNeededWei`).
- **Read pacing and retries (ROOT-READ-PACING, after root's live prepare died on `mainnet.base.org`
  `eth_maxPriorityFeePerGas` HTTP 429).** All reads of one prepare share one paced transport (lib `PACING`):
  - **Pacing:** at most one request starts per provider every 250 ms; the two providers are paced independently.
  - **Retries:** only HTTP 429 is retried, at most 3 times per request.
    - A `Retry-After` of ≤ 5 s (delta seconds or HTTP date) is honoured; a longer one refuses at once.
    - Without one, the waits are 0.5, 1 and 2 s.
    - Nothing else is retried: other HTTP statuses, JSON-RPC errors (no transient class is documented for them here,
      including -32005), timeouts and network errors fail at once (exit 1, `FAILED (not retried)`).
  - **Budgets:** at most 80 attempts (54 reads + 26 retries) and 60 s per prepare. A wait that would cross the deadline
    is not started (`rpc_budget`); exhausted 429 retries refuse with `rpc_rate_limited`, never relabelled as a fee
    finding.
  - **Freshness:** the agreed block may be at most 60 s old (measured from its selection) when the plan is written,
    otherwise `stale`. The time budget can never exceed the freshness window: that is refused at construction and never
    relaxed.
  - **Unchanged guards:** the two-RPC same-block agreement and every guard listed under `--prepare` above. The plan
    records `transport` (requests, 429 retries, waited, elapsed, block age, pacing).
  - **Not changed here:** the one-off 12-request live probe (`publish/probe/live-readonly.mjs`) still sends single
    attempts, unpaced.
- **Output:** a public plan `publish/prepared/<sha256>.json` holding the unsigned EIP-1559 transaction and every
  observation. There is no send, sign or upload code; a test greps the source for those.

## 6. Signing and publication sequence (root and the admin decide; nothing here performs it)

1. **Pre-flight:** run `node publish/bin/publish-prepare.mjs --prepare`. Every check must pass, and `balanceSufficient`
   must be true.
2. **Signature 1, upload:** the admin signs `enclave-upload:7ce32918490b91b87c7ffa4cf69769c676b5b835ca11d55904b1511ef93ee883:<expiry>`.
   Upload `out/custody_canary_proof.wasm` (sha256 checked first) and compare the returned CID to §3.
3. **Re-prepare:** run `--prepare` again right before signing, then compare `unsignedTx.data` with `request.json`
   (sha256 `13e5a6f4…`).
4. **Signature 2, the transaction:** the admin signs exactly `unsignedTx` from the current plan, with the same nonce, gas
   and fee fields.
5. **Post-checks (read-only):**
   - the receipt status is 1 and carries `VersionApprovalSet(0x85c5ed4c…13a0, 0, 1)`;
   - `getVersion(0x85c5…, 0)` returns the CID, approval 1, config `{"wasi":"0.2"}`, memMb 128 and cpuGflops 10;
   - `versionFee` is 0.

**If the admin uses `enclave publish` instead** (it uploads and publishes in one run), pass exactly:
`enclave publish out/custody_canary_proof.wasm --slug custody-canary-proof --name "Custody canary proof" --desc "<the description above>" --version 0.1.0 --mem 128 --cpu-gflops 10`
- Use no `--ports`, `--config` or `--fee`.
- Hazards:
  - The CLI's own RPCs and fees bypass this helper's caps.
  - It does not check the returned CID.
  - Its confirm line must read `res=[vram 0MB, gpu 0Gf, mem 128MB, cpu 10Gf]`.
  - On a checkout whose baked catalog is the retired `0xAc5270…`, a book-lookup timeout sends the publish there. Use a
    tree that bakes `0x18419…` (for example work/history-checkpoint-transport/tree/cli), or confirm the resolved address.

## 7. After publication: what the canary rules change to (root review)

The canary deploys `catalog://0x85c5ed4ce282f8c1f434dd600d902d8738a6d8a54b71497dfaa95a1f635813a0/0` and admits AppID
`4f700c92…6a17`, measurement `e5febd10…ff12`, runtimeId `297b6c2c…02f8` instead of hello-world's. Re-derive with
`expected-measurement.sh --pin` before copying. Staged secrets are the driver's markers only: at most 8 CANARY_ names,
each `CANARY_<run>_<set>_<64 hex>` from `randomBytes(32)`.

The format check is syntactic only. Confidentiality depends entirely on that CSPRNG generation (README §2).

## 8. Checks (unchanged queue, 256/512 lanes)

| check | lane | result |
|---|---|---|
| catalog + book offline rebuild = deployed code hashes | 512 | exact, peak 302 MiB |
| AppID derivation + hello-world cross-check | 256 | 4f700c92… / 9c3d10f1… reproduced |
| expected measurement (hello cross-check + canary) | 512 | 9709716c… reproduced / e5febd10…, peak 111 MiB |
| helper tests on anvil (real catalog + book runtimes, mock oracle, fake clock) | 512 | 10/10 (incl. 429→success, exhausted 429, Retry-After over cap, non-429 fail, stale, time budget), 0.85 s, peak 177 MiB |
| paced transport unit tests (discrete-event fake clock, no real sleeps) | 256 | 8/8 (429→success, Retry-After both forms, cap, exhaustion, 5 non-429 kinds, pacing timing, budgets, bounds) |
| helper mutants (owner, handoff, listing, CID, book, catalog and ledger hashes, operator fee, not-Isthmus, L1 size, RPC agreement, nonce, fee cap, chain; non-429 retried, no pacing, unbounded 429, Retry-After cap or value ignored, request or time budget unchecked, stale accepted, budget > freshness) | 512 | 23/23 killed |
| live read-only probe | 256 | 12 requests, all agree, ok |

The frozen component's sha256 was re-verified in the tests. Root's activation was holding the large lane; no job here
needed it, and no exit 98 was bypassed.
