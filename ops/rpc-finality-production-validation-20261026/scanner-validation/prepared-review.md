# gitleaks default `coinbase-access-token` false positive on viem *Coinbase* file digests (prepared; UNRUN; NOT committed)

## Actual finding (root-scanner-r3, `logs/gitleaks-r3-findings.json`, read path + line only)
- **39 findings, all rule `coinbase-access-token`**: 13 distinct lines, each repeated in 3 staged files:
  - `ops/rpc-finality-production-validation-20261026/stages/r9/bundle-origin.json`
  - `…/stages/r9/install/MANIFEST.json`
  - `ops/rpc-finality-r7-development-20261026/stages/capture-closure/install/MANIFEST.json`
- **None in the config itself.**
- **The default rule** (read from the installed gitleaks **8.30.1** binary's embedded default config): `(?i)[\w.-]{0,50}?(?:coinbase)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|…|:|…)[\x60'"\s=]{0,5}([a-z0-9_-]{64})…`. A viem **file name** containing "Coinbase", followed by `": "` and its 64-hex **content digest**, matches it.

## Verification before any change: 13/13
Each line was read from the staged blob; each pair maps to the `viem` tree and **equals the sha256 of the installed file** `source/node_modules/viem/<path>` (realpath `work/enclave/node_modules/viem`, viem **2.53.1**). Recorded in `scanner-fp-fix-stage/coinbase-verified-digests.json`. The files:
- `{_cjs,_esm}/account-abstraction/accounts/implementations/toCoinbaseSmartAccount.js(.map)`
- `_types/…/toCoinbaseSmartAccount.d.ts`
- `account-abstraction/…/toCoinbaseSmartAccount.ts`
- `{_cjs,_esm}/actions/test/setCoinbase.js(.map)`
- `_types/actions/test/setCoinbase.d.ts(.map)`
- `actions/test/setCoinbase.ts`

## Change (r4, updated after root review; 2 files in `source/`, working tree, unstaged; the scanner stays `613a0e11…`)
Hashes:
```
2c2f111607bf4775…  source/.gitleaks.toml
8a869b7bc392a7a4…  source/.githooks/gitleaks-selftest.py
94e579cedaa75bee…  scanner-fp-fix-stage/r4/gitleaks-coinbase-allowlist.patch
ce5419200dfe6dc0…  scanner-fp-fix-stage/r4/root-scanner-gitleaks-r4.sh
```
**`.gitleaks.toml`: ONE stable checksum exception, not a per-copy whitelist.** It is one global `[[allowlists]]` with:
- `condition = "AND"`;
- `targetRules = ["coinbase-access-token"]`;
- `paths = (^|/)(?:install/MANIFEST|bundle-origin)\.json$`, the **same file-name constraint** as the scanner's ethereum exception and the labelled-rule allowlist;
- `regexTarget = "line"`;
- **13 anchored exact-line regexes** `^\s*"<escaped viem path>"\s*:\s*"<full digest>",?\s*$`.

**What `targetRules` restricts:** per the config's own comments and `gitleaks-selftest.py`'s structural rule, this is **not a global crypto allowance**. It applies only to the default `coinbase-access-token` rule; the crypto rules (ethereum-*, WIF, xprv, BIP39, keystore) and every other default rule are unaffected.

**Why it is not an arbitrary allowance:** it names verified public file **contents** (path plus digest), never a location. So completed snapshot stages (r10, the final composition) can preserve the same manifests and bundle origins without config churn. Any other digest, file name, extra content or real token still fires.

**Not used:** the default rule is not redefined, and no same-id merge semantics are relied on.

**Static emulation** (Python of the default rule plus applicable allowlists; gitleaks NOT run):
- all staged files: **39 matches, 0 left**;
- all 8 new Coinbase positives still match the rule and are not allowed;
- the Coinbase-relevant negatives are clean.

**`.githooks/gitleaks-selftest.py`:**
- **Unchanged from the earlier r4:** the 13 pairs are read from the config at run time (no 64-hex literal), and gitleaks scans with repo-relative paths (`cwd=tmp`, target `.`).
- **Tolerated (negative):**
  - the 13 exact lines in the 3 real staged files;
  - **a later snapshot's** `ops/a-later-snapshot-stage/r10/install/MANIFEST.json` (now allowed by design).
- **Found by `coinbase-access-token` (8 positive):**
  - the exact line in `install/OTHER.json`;
  - in a non-install `notes/MANIFEST.json`;
  - in the look-alike names `my-bundle-origin.json` and `bundle-origin.json.bak`;
  - a **changed digest**;
  - **another listed file's digest**;
  - a **genuine-looking `"coinbaseApiSecret": "<64 [a-z0-9]>"`**;
  - an exact line **plus extra** `"coinbase_token"` content.
- **Integrity:** a missing allowlist fails the selftest.
- **Removed:** the earlier per-path extra scans (not needed with a file-name constraint).
- **All earlier cases are kept.** Expected: `gitleaks-selftest: 26 generated secrets found by their rules, 14 look-alikes tolerated, …`.

**Pair verification is unchanged:** 13/13 equal the installed viem 2.53.1 files (`scanner-fp-fix-stage/coinbase-verified-digests.json`).

## Root job (UNRUN): stage `.gitleaks.toml` and `.githooks/gitleaks-selftest.py`
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh scanner-final-r4-1 256 bash scanner-fp-fix-stage/r4/root-scanner-gitleaks-r4.sh
```
**Expected:**
- scanner `57/57`;
- scanner `--staged` passes;
- the negative control holds;
- gitleaks-selftest prints `26 … found, 14 … tolerated`;
- **`gitleaks git --pre-commit --staged`: no leaks**;
- hook-selftest passes;
- `## scanner-final-r4 rc=0`.

Then root commits normally with hooks.

## Not done / limits
- **Not run:** no test, job or gitleaks run. Nothing committed; main and other checkouts untouched; manifests unchanged.
- **Narrow coverage:** the allowlist covers exactly these 13 verified pairs, in files named `install/MANIFEST.json` or `bundle-origin.json`. Another Coinbase-named dependency file, or another viem version, needs its own verification.
