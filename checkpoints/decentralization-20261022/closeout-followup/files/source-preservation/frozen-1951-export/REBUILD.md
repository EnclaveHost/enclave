# frozen-1951 export: how to rebuild

"1951" is this batch's identifier: its actual start, 2026-10-23T19:51Z (`date -u`). It is not a publication time.

SOURCE + EVIDENCE only. This capture merges, images, activates or deploys nothing.
- **CPU:** the production activation records are root's. Per root: all 9 apps run on exact coupled shares, with strict CA/hostname
  HTTPS 200 on all 18 routes at 19:41Z.
- **Custody v2:** image e012 is proven quote-only on hardware. It is superseded for activation by a5eae96c, which is source only.
  Neither is activated. The existing custody is the original single-seat bootstrap, not decentralized custody.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

Ignored and untracked files are never read: binaries, node_modules, raw quotes, sealed state, private config, and canary run directories and logs.

## Trees

| Side | Base (pushed in 45bf6552) | Head (tree) |
|---|---|---|
| cpu-activation | empty | 3451c90 → **785f77af** (d8d44a53) |
| sched-manager | ea6717d2 (frozen-1726 cpu-enforce) | ab2ed9a2, 2cea9ead → **1bda7b79** (5aa32ffb) |
| sched-guest (derivative) | empty | f7b6ff55 … **f6d5fbed** (orig b424a5c4; derived tree in INVENTORY) |
| custody-release | empty | **44bf8f4f** (afec64f0) |
| dashboard | ff13ebe0 (frozen-1639 e-gen) | 2cf89ae2 … **4acad4a7** (cfaa8d49) |
| custody-live2 | a90f8339 (frozen-1852 custody-live) | **70019fdf** (bb19b19a) |
| root-native2 | 8afbf879 (frozen-1852 root-cpu-quota) | **e859355e** (3b445521) |
| durability2 | 415483ff (frozen-1852 m-durability, touched files only) | 3ccd4333, 0a6b108e, c95dcd3a → **a5eae96c** (d8afe7ff, NOT reproduced) |

- **To rebuild:** `git read-tree` the base, then `git apply --cached` each patch in order; `git write-tree` must equal each recorded tree.
  `verify-frozen-1951-export.py` rebuilds every base offline from the stored patch chains in 45bf6552, and writes `REPRODUCE-CHECK.txt`.
- **durability2:** its base tree cannot be published (frozen-1852: it descends from pre-rewrite c635fd68). `base-files/` stores the
  415483ff blobs of the touched files. The export asserts these equal the frozen-1852 head blobs, and the verifier checks every
  touched path's blob at every commit. The full trees are not claimed.

## Omitted after review of the actual gitleaks findings (export-1; not allowlisted, .gitleaks.toml unchanged)

- **sched-guest: `isolation/m3/hv-accept-check-2026-09-25.txt`.** This is a local QEMU/KVM fixture log (not Hyper-V). Its
  `launcherKey` is the launcher's PUBLIC report verification key: 32 bytes, base64, the key `hvlab-accept.mjs` judges reports with.
  It is not a secret, but it trips generic-api-key. sched-guest is therefore a SOURCE-ONLY DERIVATIVE without that file. Restore it
  from the guest repository at f6d5fbed; the blob is in `omittedAtHead`.
- **durability2: `test/helpers/original-vault-rig.mjs`** (new in 0a6b108e). It trips generic-api-key on contract identifiers
  (a quoted Solidity source name followed by its quoted contract name, for the V2 vault contract). It is excluded from the patches and from the touched-path check. Restore it
  from M's repository at a5eae96c; the blob is in `omittedAtHead`.
- **INVENTORY:** `touchedBlobs` is a list of `{path, blob}`. The earlier mapping form put the blob SHA-1 after
  `secret-custody-v2.md":`, which also tripped generic-api-key.
