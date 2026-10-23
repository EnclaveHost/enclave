# RESULT: browser wallet and passkey/bundler dependencies under independent profiles (E, 2026-10-23)

**Source.**
- Location: `work/rpc-wallet-dependency-20261023/repo`, branch `rpc-wallet-dependency`.
- Two commits on S's immutable `349318a0600917bad8f391ad628fa0c7f134b3f6`: **`6ab298f19`** (the change) and
  **`dc2e5d740`** (the retry wording and test, after root's review). Final head: `dc2e5d7402327bdd376cf3b90cfa23a551a37ba8`.
- Author and committer: SteveDeFacto.
- Not integrated and not deployed. Root reviews it first and owns activation.

**Root inputs received during the run:** `ROOT-BROADCAST-RETRY-REVIEW.txt` (wording aligned; policy kept; test added)
and `ROOT-BUNDLER-IMPLEMENTATION-OWNER.txt` (P owns Alto; the recipe now cites root's primary-source review).

**Earlier work preserved unchanged:** `rpc-transaction-independence` (`c08331e9`, `e917c526`, `9c5e0eef`).

**What was read.** `work/effective-goal-requirements.txt`. There are no AGENTS.md or CLAUDE.md files in the tree.

**What was not touched:** the A, B, F and S trees, contracts, wallet settings, SSH, live RPC, funds and packages.

## 1. Trace: what each real flow depends on (current source, not the earlier NOTE)

| Flow | Signing | Broadcast / submission | Fees and estimates | Receipt / outcome | External dependency left |
| --- | --- | --- | --- | --- | --- |
| EOA / MetaMask, `wallet.js sendTx` (every page and admin action: apps, deploy, grant, sessions, admin console, account-ui "connected wallet pays") | wallet | **wallet's own RPC** (`eth_sendTransaction`) | profile `baseRpc` (`eth_estimateGas`; `eth_call` if that fails) | profile `waitReceipt` | the wallet's Base RPC. The page cannot see or change it; EIP-3085 is only an offer, and the wallet decides. |
| WalletConnect wallet | wallet app, over the **WalletConnect relay** (`projectId`) | the wallet's own RPC | profile | profile; `rpcMap` = the profile's first RPC | the WC relay, plus the wallet's RPC |
| Passkey account, "the account pays its own gas" (`account-transport.js sendAsAccount`) | passkeys, under each passkey's RP domain | **owner-named bundlers only**, in order (`eth_sendUserOperation`); no default, no Enclave-only set, no public fallback | tip from the bundler (`eth_maxPriorityFeePerGas`, capped at 2 gwei); limits from `eth_estimateUserOperationGas`, raised by margins and floored by the profile's own `estimateGas`; base fee from an agreed block | EntryPoint `UserOperationEvent`, read through the profile quorum; never the bundler's word | **a real bundler service** (none exists); optionally an owner-named ERC-7677 paymaster |
| Passkey account, "connected wallet pays" | passkeys (inside the calldata) | wallet (as EOA) | profile | profile | as EOA |
| Passkey account, "Copy calldata for any submitter" | passkeys | anyone (including an L1 portal deposit) | n/a | n/a | the submitter |
| `/credit/` page | passkey | `walletTransport` (wallet RPC) **or** owner-chosen `relayTransport` → `/v1/credit-vault/submit` | profile reader | chain reconcile | the relay route is supplied by the existing host service `network/host-services/credit-vault-submitter.mjs` (A owns parity) |
| Admin console migrator | derived key in the page | **profile** `baseRpc eth_sendRawTransaction` (already) | profile | profile | none beyond the profile |

**Public defaults in independent mode.** After the S closure, none remain on these paths. `fallbackRead` and
WalletConnect use `mainnet.base.org` only when the profile is `off`, which is the existing hosted default. These tests
refuse and record every non-loopback origin; none was attempted.

## 2. What changed (smallest integration)

### A. A new, explicit EOA route: "the network profile broadcasts; my wallet only signs"

New file `site/js/core/profile-broadcast.js`, with hooks in `wallet.js`, `chain.js` and the popover.

- **Default unchanged:** the wallet broadcasts. The route exists only in independent `on` mode, and only after the
  owner's explicit click under **Broadcast** in the wallet menu.
- **Sequence:**
  1. `sendTx` measures gas through the profile.
  2. Nonce (`pending`) and tip come from the profile, and the base fee from an agreed block.
  3. The page asks the wallet for **`eth_signTransaction`**.
  4. It strictly decodes the EIP-1559 bytes. They must equal the request exactly (chain, nonce, fees, gas, to, value,
     data, no access list).
  5. The signer is recovered by the **chain's ecrecover precompile at an agreed (quorum) block**, so no new crypto code
     and no new package. It must be the connected address.
  6. The page re-checks the profile tab guard.
  7. It sends the bytes to the profile endpoints in order (`eth_sendRawTransaction`). The same bytes move to the next
     endpoint only after a refusal, no answer or a different hash.
- **Outcomes:**
  - accepted (the hash matches, or "already known");
  - **refused** (every endpoint refused; it was sent nowhere else);
  - **unknown**: an endpoint may have it. The same signed bytes are offered to every remaining profile endpoint (no new
    signature or nonce); after that nothing more is sent, and the owner checks the hash before creating another
    transaction. Root review `ROOT-BROADCAST-RETRY-REVIEW.txt`: wording aligned, policy kept.
  - `waitReceipt` does not ask the wallet's RPC about a transaction the wallet never had.
- **Wallets without `eth_signTransaction` (MetaMask is one)** are refused by name: "Nothing was signed or sent". The page
  points the owner to the explicit "my wallet broadcasts" route. There is **no silent fallback**.
- **No signing key** enters the page, no generic method allowlist, no new package. Admin actions use `sendTx` and work on
  either route.

### B. Truthful capability text

- The passkey account's capability list said "No Enclave account, relay, RP, bundler or paymaster is involved" even when
  the owner chose an `enclave.host` RP, bundler or paymaster service. It now names those, and keeps the old line
  otherwise.
- Two stale comments were corrected: "Nothing sends user ops yet", and "paymaster refused here". The truth: the Safe
  path sends; a Coinbase transport is validated, but nothing sends one; a named paymaster is used under checks.
- The popover also states that WalletConnect signing crosses the WalletConnect relay.

### C. Already supported, proven through the actual path rather than duplicated

Passkey bundler and paymaster selection: owner-only, ordered, no default, not all-Enclave, loopback or https, EntryPoint
v0.7 only.

**The missing component is a host service:** a real ERC-4337 bundler (and optionally a paymaster contract plus service).
See `RECIPE-SELFHOSTED-BUNDLER.md`: EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, Safe 4337 module
v0.3.0, a funded executor EOA, a Base node RPC (tracer support UNKNOWN), and the sequencer or L1-deposit route.

## 3. Tests: provenance and results (all through `work/claude-test-queue.py`, unmodified)

| Job | Cap | What | Result |
| --- | --- | --- | --- |
| `n1` (first) | 256 | the new `site-wallet-profile-broadcast` (6), the new `site-account-bundler-route` (4), `walletconnect-independent-rpc` (wrapper, 6 leaves), `site-independent-passkey-account` (8), `site-independent-account-transport` (9) | **25/28.** The 3 failures were all in my new bundler-route test: both loopback stand-ins on `127.0.0.1` violated the transport's distinct-hosts rule, and a stored gas choice leaked into the no-transport check. Kept in `logs/n1.out`. Peak 218 MiB. |
| `n2` | 256 | `site-account-bundler-route` after the test fix (stand-ins on 127.0.0.1 / localhost; storage cleared) | **4/4**, peak 142 MiB |
| `b1` | 1536 | `site-browser-rpc-closure` (10, including the e820 CONTROL) + `site-browser-rpc-routes` (Chromium rig; extended with the popover route choice, a signing-only broadcast through the profile, and its receipt) | **11/11**, peak 839 MiB |
| `e1` | 256 | esbuild bundle of the dashboard graph (as `build-site.mjs`, without templates, tailwind or artifacts) | `profile-broadcast.js` in the graph; the new strings are in the chunks; the only warning comes from the existing `qr.js` |
| `n3` | 256 | `site-wallet-profile-broadcast` after the retry-wording fix (`dc2e5d740`): asserts that the dropped-reply case sends identical bytes once to each origin, with one signature, and nothing more while waiting | **6/6**, peak 164 MiB |
| `m1` | 512 | 4 mutants of `profile-broadcast.js` against `site-wallet-profile-broadcast` | **4/4 killed**: M1 no field check, M2 falling back to the wallet broadcast, M3 no signer check, M4 unknown reported as refused. The file was restored clean. Peak 195 MiB. Ran on `6ab298f19`; `dc2e5d740` changes only comments and the unknown-outcome text, not the mutated lines, so it was not rerun. |

**Test provenance.**
- The chain is a local **anvil** (`--chain-id 8453`), a test chain. The wallets are in-test EIP-1193 objects whose own
  RPC is anvil, which signs for its unlocked dev account (a signing-only wallet), or which refuse `eth_signTransaction`
  with EIP-1193 4200. The keys are anvil dev keys.
- **The bundlers are scripted loopback stand-ins**: no ERC-4337 validation, no EntryPoint, and the outcome event is
  scripted.
- **Acceptance by anvil or by a fixture proves nothing about Base mainnet inclusion.**
- The browser rig reuses S's Foundry subset outputs, copied from `browser-rpc-closure/repo`. Their SHA-256 values match
  S's `forge1.out` (same contract sources, same commit).

**Scans (`s1`, 256):**
- Source `349318a06..dc2e5d740`: crypto-key scanner clean; gitleaks found no leaks.
- Report repo: crypto-key scanner clean.
- Report repo gitleaks: the first run used the default config and flagged 1 item, the public anvil dev key #2 in the
  exported test patch (kept: `logs/s1-first-default-config.out`). The rerun used the source repo's own
  `.gitleaks.toml`, which allowlists anvil's public keys: no leaks.

**Not run:**
- `site-independent-account-first` and `site-independent-passkey-aa`: both fork Base from a public RPC.
- A full `build-site.mjs`: it rewrites tracked files, and the e1 graph check stands in for it.
- The 40-second drop check of `waitReceipt` for a profile-sent hash: its guard is a one-line Set lookup, covered by
  reading the code and not by a test.

**Process deviation (reported):** one ~1-second `node` import probe of `wallet.js` ran directly, outside the queue,
before the tests were written. Everything else went through the queue.

## 4. Supported / deployed / not started

| Item | Status |
| --- | --- |
| EOA route "the profile broadcasts, the wallet signs only" | **source supported** (`6ab298f19`), tested on loopback/anvil and Chromium; **not deployed** |
| MetaMask (no `eth_signTransaction`) broadcast independence | **not possible from the page**. The wallet's own RPC remains; the remedies are the owner's own wallet RPC setting, a signing-only wallet, or a passkey account with their own bundler |
| WalletConnect signing without the WC relay | **not supported** (an outside relay; disclosed) |
| Passkey account → owner's own bundlers / paymaster | **source supported** (pre-existing, re-proven over real HTTP); **no self-hosted bundler exists: NOT STARTED** |
| Self-hosted bundler and paymaster service | **NOT STARTED here.** P owns a pinned Alto service with safe mode on (`work/rpc-bundler-service-20261023`). The browser-side prerequisites, endpoint and funding dependencies are in `RECIPE-SELFHOSTED-BUNDLER.md`: a funded executor (a spend), tracer compatibility (P's test), and for a paymaster a new contract (excluded) |
| Credit page relay route | supported by the existing host service `credit-vault-submitter` (deployment status per A/F, not verified here) |
| Profile endpoints accepting `eth_sendRawTransaction` from browsers | S's ingress decision: `HANDOFF-S-F-WALLET-ROUTES.md` |

Deliverables: this file, `RECIPE-SELFHOSTED-BUNDLER.md`, `HANDOFF-S-F-WALLET-ROUTES.md`, `exports/` (source-only export
for D, 349318a06..dc2e5d740), `jobs/`, `logs/`.
