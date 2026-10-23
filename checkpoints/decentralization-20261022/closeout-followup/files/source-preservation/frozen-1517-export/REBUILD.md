# frozen-1517 export: how to rebuild

"1517" is this batch's identifier: its actual start, 2026-10-23T15:17Z (`date -u`). It is not a publication time.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- a merge is ONE diff against its first parent (`NNNN-merge-*.diff`, with a `#` header naming both parents);
- a commit that touches only excluded paths has no patch (`emptyAfterExclusion`);
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it. The
  truncated context line otherwise cut the public, allowlisted Anvil dev key into a fragment that gitleaks flags.

Each changed file is also stored at its head blob under `files/`. `INVENTORY.json` records, per commit, its hash, parents, tree,
author and committer (all SteveDeFacto / noreply), its time and its subject.

## Exact trees

| Side | Base (already in pushed 4aaba75b) | Head |
|---|---|---|
| e-prod | dc2e5d74 (frozen-1339 e-wallet) | e078490d (merge of published main 68b82926) → ae00cd96 (tree 51591856) |
| m-cancel | 4c059b99 (frozen-1339 s-role, 2nd commit) | 1c386e23, 808f36c5 → 3746e4fc |
| s-iface | 36919aaf (frozen-1339 s-role) | 4f7632d7 (tree b246ba51) |
| t-compose | a9f0155c (frozen-1339 t-hdd) | 29c6de87 … 4bb72315 |
| ts-compose | 92b71784 (frozen-1118 s-compose) | 97758444 → fb9ce4a7 |
| root-api-mcp | empty tree (root commit) | 95ee73dc |

`git read-tree` the base, then `git apply --cached` each patch or merge diff in order; `git write-tree` must equal each recorded
tree. `verify-frozen-1517-export.py` does this offline from 4aaba75b's stored patches, and its output is in `REPRODUCE-CHECK.txt`.

## Source-only derivatives

- **a-receipts** (A, 554a251c → eab4cfac; original head tree e0e07f21).
  - **Base:** continues frozen-1339 a-gaps, so `metal/guest/mcp-server.bundle.mjs` and its manifest are held at their
    e32dd607 bytes.
  - **Omitted:** the 5,064,161-byte compiled bundle at eab4cfac (sha256 17cfb64f…) and its manifest. The manifest's npm-name
    and hash pairs trip the unchanged gitleaks rules, so it is published as `converted/*.sha256sums` plus `*.meta.json`, with
    the exact Python rebuild in INVENTORY `convertedManifest.rebuild` (asserted by the export).
  - **Restore:** restore the manifest, then run `node scripts/build-mcp-guest-bundle.mjs` with A-receipts' own node_modules
    links. The build uses `preserveSymlinks`; the dependency roots are the manifest's input prefixes `.`, `relay/` and
    `sdk/sessions/`.
  - **Validated:** `frozen-1517-a-bundle-check.sh`, log `frozen-1517-a-bundle-check.out` (queue EXIT 0, 15:22Z). `--check`
    rc 0: 5,064,161 B, sha256 17cfb64f…, 3032 inputs. The export refuses unless that log shows it.
- **tp-compose** (P within T's compose, f8c999ed → ed814e58).
  - **Base:** frozen-1118 p-compose's derivative tree.
  - **Omitted:** the same 5 paths as frozen-0931 p-l1, with identical blobs. Its `omittedRecipe` and `omittedFingerprintFiles`
    apply.
- **e-prod-report** (E's report repo, root → 4beedc5b).
  - **Omitted:** `exports/` (a binary git bundle, and patches duplicating e-prod's objects). Each is recorded by blob and
    sha256.

- **f-runtime-gap** (F, 1f19ad15 → 896c5d49 … 0de09415 → dda47a35 → 0ed6b6d9; original trees 5cbdb670 and dfb63eaf).
  - **Omitted:** one file, `test/service-index.test.mjs`. A new test argument on its line 90 trips gitleaks generic-api-key, so
    it is held at its 1f19ad15 bytes.
  - **Restore:** from F's repository (blob in `omittedAtHead`).
- **c-shard** (C, root → 5c317531; original tree 436f191f).
  - **Omitted:** five vendored upstream sia-sdk-rs files: `sia_core/src/seed.rs`, `sia_core/src/types/spendpolicy.rs`,
    `sia_core/src/types/v1.rs`, `sia_core/src/types/v2.rs` and `sia_storage/src/builder.rs`. Their public test vectors and
    upstream BIP39 TEST mnemonics trip gitleaks and the pre-commit `scan-crypto-keys` hook, neither of which is weakened.
  - **Restore:** from upstream sia-sdk-rs e1d1ebe0 (the exported `UPSTREAM` file); each git blob must equal `omittedAtHead`.
    This was NOT verified against upstream (offline).
- **s-iface-report** (S's report repo, root → a32d209e).
  - **Omitted:** S's own copy of its patch, `patch/public-rpc-consumer-interface-36919..4f7632d7.patch`. It duplicates s-iface,
    and its hunk context truncates the dev key.
- **t-report** (T's report repo, root → be3392d2).
  - **Omitted:** `receipts/run4/journal.txt`, a guest kernel boot log with a build-key fingerprint line. It is kept in T's
    repository.

## Not archived (hashes and recipes in INVENTORY)

- **E:** `dist` / build-tree and its compiled tar. `outputs/dist-manifest.sha256` (committed in e-prod-report) has sha256
  9904f5e0…. The recipe is in E's RESULT-PRODUCTION-BUILD.md. Two generated build-tree files are stale (root), and the source
  is not accepted as final production.
- **F:** `node-closure.tar` (binary). Its `.sha256`, the deploy-file lists and F's own `verify-closure.sh` are captured. D did not run that script and makes no rebuild claim.
- **C:** `artifacts/*.wasm`, including `candidate-55888a41.wasm` (4,556,225 B). The deployed old artifact still has the bug.
- **S:** untracked `network/host-services/packages/` (`public-rpc.package.json` = 78f06b5b).
- **A:** patch 0021, the bundle rebuild diff.
