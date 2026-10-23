# RESULT: production build and receipt-drop checks for the wallet route (E, 2026-10-23)

**Scope.** This finishes the two release checks left unrun in `work/rpc-wallet-dependency-20261023`:
1. the actual `scripts/build-site.mjs` production path;
2. the modified `waitReceipt` dropped-wallet branch.

**Nothing is deployed, published, uploaded or integrated.** Root owns activation.

**Preserved and untouched:**
- the earlier source, report and D export: `dc2e5d740`, report `ec2be53`, `rpc-wallet-dependency-20261023/exports`;
- S, F, P and A active trees;
- wallet settings, keys, funds, contracts, VMs, toolchains and Wine.

Read `work/effective-goal-requirements.txt`. Its latest item, the NucBox 96 GB request awaiting the restart reply, is
unchanged and out of scope.

## Final source

- **Commit:** `ae00cd9659e46e3dffe5407bdf34442416a9e69a`
- **Location:** branch `rpc-wallet-production-build`, in `work/rpc-wallet-production-build-20261023/repo`.
- **Identity:** SteveDeFacto (author and committer).

| Commit | What |
| --- | --- |
| `6ab298f19`, `dc2e5d740` | the wallet route as root reviewed it (unchanged) |
| `e078490da` | `--no-ff` merge of main **`68b82926968c99503d38ae78dbcb04694cc2c56c`** (3 docs-only commits on 7752a4239). `PRODUCT.md` and `docs/security/nucbox-custom-vm-verifier.md` are byte-identical to main. `README.md` has every main hunk, plus this lineage's earlier site-release wording (`6f2c7da46`). No conflict. No pre-rewrite "tinfoil" literal anywhere in `site/` or in the built `dist/` (0 files). |
| `ae00cd965` | tests only, plus the rig's `siteDir` option and a `swallow-raw` origin mode; **no `site/` change** |

## Build: actual `scripts/build-site.mjs`, unchanged (`logs/build1.out`, queue cap 1536, peak 413 MiB)

**What the script does was read first:**
- It writes only `site/dist/` and two tracked generated files (`site/css/site.css`, `site/js/gen/contract-artifacts.js`).
- It runs `npx @tailwindcss/cli` (installed locally) and compiles the contracts with the local solc-js.
- It never deploys or uploads; `site/deploy.sh` is separate and was not run.

**How it was run:**
- In a clean detached worktree `build-tree/` at `ae00cd965`, using the copied locked `node_modules` (`package-lock.json`
  sha256 `9ada1611…`).
- Under `unshare -r -n`, i.e. **no network**: nothing could be downloaded or uploaded.
- With npm cache and logs inside the workspace.

**Inputs:**

| Input | Value |
| --- | --- |
| `package-lock.json` | `9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20` |
| `build-site.mjs` | `0664477d…a420` |
| `build-contract-artifacts.mjs` | `01854177…1d82d1e` |
| `site-built-in-profile.mjs` | `abd423f1…9df8` |
| Tool versions | esbuild 0.28.1; @tailwindcss/cli and tailwindcss 4.3.2; solc 0.8.35; viem 2.53.1 |
| Git trees | `site/` `ab28986e71f7489ce4ad4952dc3c706a410b403b`; `contracts/` `df8466e8ad4bc25ad5850acb0b35bf6c80c1905c` |
| Built-in profile | none (hosted defaults; a saved browser profile still applies) |

**Outputs:**

| Output | Value |
| --- | --- |
| `build-tree/site/dist/` | 238 files, 28.6 MB |
| Manifest | `outputs/dist-manifest.sha256`; the manifest's own sha256 is `9904f5e0a44e00ed4d7e621b9a318e10256c055699683fa859799dd6df3b8ba8` (re-checked unchanged at test time) |
| Deterministic tar | `outputs/site-dist-ae00cd96.tar`, sha256 `7d6a1d330593ef33947539541235e02a043da142e74dcbd142cdfe0859afac5f` |
| `csp-script-src.txt` | `b2373096…4a98` (6 inline-script hashes) |
| `dashboard.html` | `9f787273…77b1` |
| `js/boot.js` | `3f98ea60…c633` |

**What the bundle contains:**
- The new module is a real chunk of the dashboard graph: `js/chunks/profile-broadcast-3WV7XJKR.js`.
- The route, refusal and receipt strings are in the built js.
- The only esbuild warning comes from the existing `site/js/lib/qr.js`.

**Pre-existing staleness, not caused by this change.** The build rewrote the two tracked generated files exactly as it
did for S at `349318a06`. The rewritten bytes are identical to S's `bundle-349318a`: site.css `ff2fef20…`, artifacts
`a7d54dd4…`.
- The committed `contract-artifacts.js` (last regenerated `87d6bbd0f`, 2026-10-05) has stale **EnclaveRegistry** and
  **EnclaveProofOfTime** deploy bytecode relative to `contracts/` at HEAD. That is admin-console deploy data.
- The committed `site.css` lacks 2 `.enc-pool .ap-badge` rules.
- The built `dist` uses the fresh outputs, which is correct for a release build. Whether to commit the refreshed files is
  root's decision; they were left uncommitted in `build-tree/` only.

## Tests (every one through `work/claude-test-queue.py`, unmodified)

| Job | Cap / peak | Test | Result |
| --- | --- | --- | --- |
| `r1` | 256 / 175 MiB | `site-wallet-receipt-drop` (new): the actual `wallet.js` sendTx, `profile-broadcast.js` and `chain.js` waitReceipt, on loopback origins in front of `anvil --no-mining` | **4/4** |
| `bm1` | 1536 / 830 MiB | `site-built-wallet-route` (new) against `build-tree/site/dist` built from the same HEAD | **1/1** (92 s) |
| `bm1` | (same job) | mutants of the drop check in `chain.js` | **2/2 killed**; file restored clean |

**`r1`, the four `waitReceipt` cases:**
1. **Wallet route, normal drop behaviour preserved.** A wallet that returned a hash it never relayed is refused with the
   existing "never relayed it" message, at poll 21 exactly. Its RPC is asked once.
2. **Wallet route, transaction pending.** The wallet's RPC reports it as pending, so the wait continues, and the receipt
   comes through the profile at poll 25.
3. **Profile route, accepted.** The wallet is never asked. Its RPC never had the bytes and answers null, so asking it would
   have been a false "dropped". The receipt comes through the profile at poll 30. One broadcast, one signature, nothing
   resent; nonce +1.
4. **Profile route, outcome unknown and the transaction exists nowhere** (both origins drop the connection without
   forwarding). The wallet is never asked. The wait ends with the ordinary "timed out waiting for confirmation" after 30
   profile polls, not "dropped by your wallet". Nothing is sent while waiting; nonce unchanged.

**Controlled clock (`r1` only).** Only waitReceipt's 2-s pause is shortened to 1 ms. The code path is unchanged, and the
classification still depends on the intended time: the wallet is consulted only after `DROP_AFTER` = 20 absent polls,
which is ~40 s of real polling.

**`bm1`, the built dashboard in Chromium** (served from `dist/`; the test checks there is no `js/core` source tree in
it):
1. The popover's Broadcast choice is clicked in the built page.
2. The built chunks' own `sendTx` and `waitReceipt` are imported at the URLs the page loaded, located by their unique
   refusal strings.
3. **Profile route:** the wallet's RPC sees only `eth_signTransaction`; the origins get one `eth_sendRawTransaction`; the
   receipt comes through the profile.
4. **Profile route, accepted by origins that lose it (`swallow-raw`), on the REAL clock:** 45 polls over more than 45 s,
   past the 40-s drop check. The wallet is never asked `eth_getTransactionByHash`; there is one broadcast and nothing
   resent; the transaction is absent on chain; the ordinary timeout is reported.
5. **Back to the wallet route** (clicked): the wallet broadcasts (`eth_sendTransaction`) as before.

No public origin was attempted, and no page errors were logged.

**Mutants:**
- **D1, a profile-sent transaction not exempt:** kills cases 3 and 4.
- **D2, the wallet never consulted:** kills cases 1 and 2.

**Provenance.**
- anvil `--chain-id 8453` is a test chain; the wallets are in-test EIP-1193 objects; the keys are anvil's public dev
  keys.
- Acceptance by anvil or by a scripted origin says **nothing about Base mainnet inclusion**.
- The rig's Foundry subset outputs were copied (hashes match S's `forge1`).

**Not rerun:**
- the unchanged earlier suites (`n1`–`n3`, `b1`, `m1` of `dc2e5d740`): no `site/` source changed since then;
- the base-forking passkey tests: they fork Base from a public RPC.

No test was skipped to look green: the built-site test can only skip when `BUILT_SITE_DIR` is unset, and it ran.

**Root input received during the run:** `ROOT-F-ACCOUNT-STARTUP-OWNER.txt`. F owns the
`site-independent-account-startup` prepareOnly/catalog fixture diagnosis; root reads it as a fixture moderation mismatch,
not a wallet regression. This work did not touch or duplicate it. Root says to await F's result before integration.

**Scans (`s1`, 256):**
- Crypto-key scanner and gitleaks (the source repo's policy) over `dc2e5d740..ae00cd965`: no leaks.
- The report repo: no leaks.
- `git am` of patches 0001–0004 on `dc2e5d740` gives tree `5159185616aa0600be92cb9d3308645ad59b4cf3`, which **matches**
  `ae00cd965`.
- The bundle verifies.

## Not claimed

- **MetaMask** broadcasts through the RPC configured in the wallet. The page cannot override it; EIP-3085 is only an offer.
  At cutover, a **human must configure the wallet's Base RPC to a verified live endpoint**. That is a wallet setting no
  one here changed.
- **WalletConnect** signing crosses the WalletConnect relay, an outside service. It stays optional; injected wallets and
  passkey accounts remain.
- **Bundlers:** P owns the actual Alto service, with safe mode retained. No self-hosted paymaster was added.
- **Public RPC methods:** S receives them as a file handoff only, `HANDOFF-S-PROFILE-RPC-METHODS.md`. S's tree was not
  edited.

## Export for D (source only)

`exports/`: patches 0001–0004 = `git format-patch --no-merges dc2e5d740..ae00cd965` (main's 3 docs commits plus the test
commit), the bundle `349318a06..rpc-wallet-production-build`, `NOTE-FOR-D.txt` and `SHA256SUMS`. The patch-apply tree
check is in `logs/s1.out`.

## Root activation steps (not performed)

1. **Review** `6ab298f19`, `dc2e5d740` and `ae00cd965`, and accept or reject the merge `e078490da` of main `68b82926`.
2. **Decide on the stale generated files:** commit the refreshed `site/js/gen/contract-artifacts.js` and
   `site/css/site.css` (the release build regenerates them anyway), or leave them.
3. **Rebuild on the release machine** from the accepted commit with the same locked tooling, offline (`jobs/build-site.sh`
   shows the exact commands). Compare the `dist` manifest sha256 with `9904f5e0…`. The footer stamp embeds the commit and
   the date; the manifest includes them, so a rebuild on another date differs in the HTML stamp only.
4. **Before offering the profile route, S's ingress** must admit `eth_sendRawTransaction` by name, plus
   `eth_getTransactionCount`, `eth_maxPriorityFeePerGas` and the ecrecover `eth_call`, with CORS (handoff file). Until
   then, a profile-route send is refused by every endpoint and nothing is sent elsewhere.
5. **Publish** through the reviewed site-release path (`site/deploy.sh prepare`/`deliver` with the owner's approval).
   Not done here. Old policy text must not be republished; this build carries main `68b82926`'s docs wording.
6. **At cutover, a human sets MetaMask's Base RPC** to a verified live endpoint, if MetaMask users are expected to avoid
   public RPCs. Signing-only wallets can choose "the network profile broadcasts" in the wallet menu instead.
7. **Rollback:** re-publish the previous release CID. The route is opt-in per browser (localStorage
   `enclave_broadcast_route:v1`), and the default wallet route is unchanged, so no state migration is needed.
