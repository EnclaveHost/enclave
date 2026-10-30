# Scanner false positive: viem file digests in the capture-closure manifest (prepared; NOT run, staged or committed)

**The block:** `root-save-r7-results-0633` was refused by `.githooks/scan-crypto-keys.py`, with 21 `eth-key` findings, all in one staged file: `ops/rpc-finality-r7-development-20261026/stages/capture-closure/install/MANIFEST.json`.
- That file's staged blob has sha256 `e8dd76ffa7011647020d6c2034c9d345a9ee1ea33573a3a7345e074d36c5c636`, byte-identical to `production-capture-closure-stage/install/MANIFEST.json`.
- **The cause:** the manifest maps viem **file names** such as `_cjs/accounts/privateKeyToAccount.js` to their sha256 **content** digests. `KEYWORDED` reads `…PrivateKey…": "<64 hex>` as a key assignment.
- **What was left alone:** root's staged checkpoint was not unstaged, edited or committed, and no stage manifest was changed. The only modified file is `source/.githooks/scan-crypto-keys.py` (working tree, **unstaged**).

## Verification of every flagged digest (done before adding any exception)
- **How:** each finding was mapped to its manifest tree. All 21 are in the `viem` tree. Each digest was compared with sha256 of the **actual installed file** `source/node_modules/viem/<path>`, whose realpath is `work/enclave/node_modules/viem`.
- **Dependency provenance:** viem `2.53.1` (its `package.json`). Package content digest `e200d4d114ee5ddceb49a4a6c840fd9f2765332635a75bf92e0fc9586680636c` (`tree_rows`) equals the `a1_capture.py` DEPS pin.
- **Result: 21 of 21 VERIFIED.** No digest is a secret; each is the hash of a public library file. The values are logged because they are verified checksums. The scanner's own finding output stays redacted.

| Manifest line | Package | Path | sha256 (file content) | Check |
|---|---|---|---|---|
| 2490 | viem | `_cjs/accounts/generatePrivateKey.js` | `e2fbea1ddb4f726d77389949d56accabd9451dffc5ea0ac8999cdb7e7246db3c` | VERIFIED |
| 2491 | viem | `_cjs/accounts/generatePrivateKey.js.map` | `c807cadad214bcb58bddc6a3744c0551f91433aa92be591fb90a8d9898d5af8f` | VERIFIED |
| 2498 | viem | `_cjs/accounts/privateKeyToAccount.js` | `b057a40a26b6d4a831f6f336da835773abbfa5a5a2838f7ab8a54b573a3bd974` | VERIFIED |
| 2499 | viem | `_cjs/accounts/privateKeyToAccount.js.map` | `caf8daa9ba2e610771f6fab145725d29e3769f9558211b0dd2f40e5b24762bdb` | VERIFIED |
| 2506 | viem | `_cjs/accounts/utils/privateKeyToAddress.js` | `5fd7ef732dd6ee612f2f40474d487127e7df84d1c8c5360af3c140f440254f57` | VERIFIED |
| 2507 | viem | `_cjs/accounts/utils/privateKeyToAddress.js.map` | `18789e337b762a30549df1b4c4f100949ea005444f3071de87c87996134c43bd` | VERIFIED |
| 5235 | viem | `_esm/accounts/generatePrivateKey.js` | `0f2c44265a893e19b873236baa1d828965482af578ca49277ec7e96b04a178ab` | VERIFIED |
| 5236 | viem | `_esm/accounts/generatePrivateKey.js.map` | `f0de8a3a8a3466703245dc995db823cfc4fbfd50542a818dd75a73987a20dbda` | VERIFIED |
| 5243 | viem | `_esm/accounts/privateKeyToAccount.js` | `c056d3c2d9308e74476007cda3e93cd3547068778c2b6ce67809537e207e78e6` | VERIFIED |
| 5244 | viem | `_esm/accounts/privateKeyToAccount.js.map` | `ec5f8d6c920ab2dcbdf1145aa07d23c39bda1c626f78795889b689b1feff429b` | VERIFIED |
| 5251 | viem | `_esm/accounts/utils/privateKeyToAddress.js` | `67daee9447748cbb4c0caf6ad8cc45b083e32104ac0e6e23ab200a54814f0b0b` | VERIFIED |
| 5252 | viem | `_esm/accounts/utils/privateKeyToAddress.js.map` | `e070b4bd34caf00d87c0e67152ea521a916dade2ac2c97a6df0bc8e42cd843a3` | VERIFIED |
| 7982 | viem | `_types/accounts/generatePrivateKey.d.ts` | `9af19972a61e526a6482144a4a0e0fc8f86c5eacf98e58661b693cbecb552d1a` | VERIFIED |
| 7983 | viem | `_types/accounts/generatePrivateKey.d.ts.map` | `4efa5af808011f7ce6fb540ff641a5735a20721626b274c3ce3b23d1f9161f94` | VERIFIED |
| 7990 | viem | `_types/accounts/privateKeyToAccount.d.ts` | `d1373008514c235db793c7e0981daef4461b957335b0618ad5c767dbf6026bfa` | VERIFIED |
| 7991 | viem | `_types/accounts/privateKeyToAccount.d.ts.map` | `085516461cd3a24582a5cf9a78181ace68e593f9233ce42669d46ed38859293b` | VERIFIED |
| 7998 | viem | `_types/accounts/utils/privateKeyToAddress.d.ts` | `816fd3edc7b03bf8b6e47f2815dd8c5a4ed6eb1372718a762e458e5ef0e2bab4` | VERIFIED |
| 7999 | viem | `_types/accounts/utils/privateKeyToAddress.d.ts.map` | `980c370bb07365c0e3a02f025b492ac5b179bfabfe0088ba16a30d119c875a33` | VERIFIED |
| 10688 | viem | `accounts/generatePrivateKey.ts` | `0915e2c0b7fc500a8a5d26a709696ce8153a3ba4541e39f1af680c3bdf45bce2` | VERIFIED |
| 10693 | viem | `accounts/privateKeyToAccount.ts` | `d6827e2718013415cd307baef5f622614b15b218f7bb1f0eb7358133a656c733` | VERIFIED |
| 10697 | viem | `accounts/utils/privateKeyToAddress.ts` | `ab9173b7a82e03a3409239e2ffb04ee13cc97a85e8e86a168f4165fa7b27e8b5` | VERIFIED |

Also stored as `scanner-fp-fix-stage/verified-digests.json`.

## The change (`source/.githooks/scan-crypto-keys.py`, 101 insertions / 1 deletion; patch `scanner-fp-fix-stage/scan-crypto-keys-verified-manifest-digests.patch`)
- **`VERIFIED_MANIFEST_DIGESTS`:** an immutable `frozenset` of exactly these 21 `(path, digest)` pairs. A comment records the manifest sha, the viem version and package digest, the verification date and this report.
- **`verified_manifest_digest(path, line, h)`** is true only if ALL of the following hold:
  - the scanned file path matches `(^|/)install/MANIFEST\.json$`;
  - the line is **exactly one** JSON entry, `^\s*"<path>"\s*:\s*"<64 lowercase hex>",?\s*$`;
  - the matched digest is the flagged value;
  - the `(path, digest)` pair is listed.
- **Scope:** used only in the `KEYWORDED` loop, after the existing Hardhat, low-entropy and NOISE skips. The known-address (`eth-known`), env-line, constructor (`CALL`), WIF, xprv, BIP39 mnemonic and keystore checks are **unchanged** and still run on the same lines.
- **Not done:** no generic 64-hex, path or file-name allowance, no re-encoding, no `--no-verify`. The known-address list and mnemonic logic are untouched.

## Regression cases (added to the scanner's own `--selftest`)
**13 path-aware cases plus 1 known-key case plus 1 list-integrity check.**
- **Pass** (the real listed entry, with or without a trailing comma, in `…/install/MANIFEST.json`): 2 cases.
- **Still found:**
  - the same entry in `install/OTHER.json`, and in `notes/MANIFEST.json` (not an install manifest);
  - a **changed digest** under the same path;
  - an **altered file name**, and another path with the verified digest;
  - the **verified digest used as an actual key** (`"privateKey": "<digest>"` and `privateKey = "0x<digest>"`);
  - an exact entry followed by another keyed value on the same line;
  - an **ordinary** `"privateKey": "0x<random>"` and `PRIVATE_KEY=0x<random>` inside the manifest;
  - a mnemonic after an exact entry (`mnemonic`).
- **Known key:** a project-wallet key is still `eth-known`, even when that `(path, key)` pair is temporarily listed as "verified" at an exact entry. The list is restored afterwards.
- **Integrity:** the list must still hold exactly 21 pairs, without the test key.

**Expected:** `selftest: 44/44 cases ok` (29 existing + 14 + 1). The existing 29 cases are unchanged.

## Root test commands (UNRUN)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh scanner-fp-1 256 bash -c 'cd source && python3 .githooks/scan-crypto-keys.py --selftest && python3 .githooks/scan-crypto-keys.py --files ops/rpc-finality-r7-development-20261026/stages/capture-closure/install/MANIFEST.json && python3 .githooks/scan-crypto-keys.py --staged && python3 .githooks/gitleaks-selftest.py && python3 .githooks/hook-selftest.py'
```
**Expected:**
- the selftest prints `44/44` and exits 0;
- the manifest `--files` scan exits 0 (21 to 0 findings);
- `--staged` exits 0, if nothing else in the checkpoint is flagged;
- `gitleaks-selftest.py` and `hook-selftest.py` (which copies `scan-crypto-keys.py` into its test repos; it needs gitleaks) pass as before.

**Then root stages** `.githooks/scan-crypto-keys.py` with its checkpoint and retries the normal hook. **Never `--no-verify`.**

## Hashes
| File | sha256 |
|---|---|
| scanner before (HEAD `8f20ed6f`) | `515d23e58a2b10e3706019b7d8ee456d48a374b0ccefb2aea664a238ff5a3ebf` |
| scanner after | `b04f08257de5b2cd58d0632c8f4728a31220d3ca06a3ffdc342904de9a76304a` |
| patch | `4146d978cfb23533ae942831c1ef10e151363e75cb26a8c93a33c31f82078413` |

## Limits
- **Fixed scope:** the exception covers only these 21 verified viem entries in install manifests. A future manifest with other dependency files whose names contain key words needs its own verification and listing.
- **Not run:** nothing was executed (selftest, hooks, gitleaks).
