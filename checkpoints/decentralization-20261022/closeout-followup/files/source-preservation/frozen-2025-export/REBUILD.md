# frozen-2025 export: how to rebuild

"2025" is this batch's identifier: its actual start, 2026-10-23T20:25Z (`date -u`). It is not a publication time and not a year.

SOURCE + EVIDENCE only. This capture signs, sends, funds, serves, merges, images, activates or deploys nothing.
- **Custody v2:** the corrected custodian r2 (built from ab589bf8, measurement 70aadff5) is reproducibly built. It has quote-only SNP
  startup and outage-recovery evidence. It is NOT activated.
- **Existing custody:** the original single-seat bootstrap (one seat, threshold 1), NOT decentralized custody.
- **metal0 handoff (7b49cd99):** its plain-transfer fund stage refuses the EIP-7702-delegated operator and is not usable. Its
  acceptOwner stage is source only.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

Ignored and untracked files are never read: images, binaries, node_modules, raw quotes, guest console logs, sealed state, private
config, keys, canary run directories, and worker task prompts and progress files.

## Trees

| Side | Base (pushed in dc551728) | Head (tree) |
|---|---|---|
| durability3 | a5eae96c (frozen-1951 durability2, touched files only) | **ab589bf8** (0a1f82e1, NOT reproduced) |
| custody-release2 | 44bf8f4f (frozen-1951 custody-release) | da6e3496 → **23f7e51a** (62adfd03) |
| dashboard2 | 4acad4a7 (frozen-1951 dashboard) | 10cea38b, 7f0320a4, dd6cf94a → **e24a47fb** (413e76ec) |
| custody-live3 | 70019fdf (frozen-1951 custody-live2) | 574fdc97 → **3fd6e8ff** (b7857703) |
| wallet-handoff | empty | **7b49cd99** (da50e554) |
| operator-proposal | empty | f2a7b81e → **1ac9ad2c** (e6a98714) |
| snp-harness | empty | e9b9709a → **7c4844a1** (0fb8af49) |
| direct-route | empty | **fc7bff94** (474c9922) |

- **To rebuild:** `git read-tree` the base, then `git apply --cached` each patch in order; `git write-tree` must equal each recorded tree.
  `verify-frozen-2025-export.py` rebuilds every base offline from the stored patch chains in dc551728, and writes
  `REPRODUCE-CHECK.txt`. The dashboard base needs 26 stored patches; custody-live needs 2 and custody-release 1.
- **durability3:** this continues frozen-1951 durability2 and frozen-1852 m-durability, whose base descends from the unpublishable
  pre-rewrite c635fd68. Both touched paths are new, so `base-files/` is empty. The verifier checks both touched paths' blobs at
  ab589bf8; the full trees are not claimed.

## Scanner review

The checkpoint's own gitleaks config and `scan-crypto-keys --files` found nothing in this export, the frozen 1951 receipt, the dated
snapshots (root's journal and the living custody-v2-live-verification record, whose earlier bytes 23c9aeba stay stored unchanged) or
the root SNP startup-recovery receipt. Nothing was omitted, sanitized or allowlisted, and `.gitleaks.toml` is unchanged.

Some repositories commit their own scanner reviews of public values; those reviews are preserved unchanged as evidence:
- the release `SCAN-REVIEW.txt`: the public SHA256 of the image's `snpkey` executable, and the disposable canary's public X25519
  encryption key;
- the SNP harness `SCAN-REVIEW.md`: the disposable custodian's public `encKey`;
- custody-live `SCAN-REVIEW.txt`: public source-file SHA256 values.
