# Handoff to P (work/rpc-l1-source-package): canonical shared NVMe cache budget + final storage fixes

From: S (work/fresh-witness-supply). This is a file note. P's code was not edited, and its queued tests were not
touched.

**Updated 2026-10-23 (rounding fix):** the pins below are now `959e56f` (budget v2). `2681e8a`'s `budget.py`
(`a82192bc…`) under-counted real allocation (root's 1-byte probe: charged 1, 8192 B allocated, accepted). It **must not
be activated**. See RESULT-CACHE-BUDGET §0 and the separate note `rpc-l1-source-package/NOTE-FROM-S-CACHE-BUDGET-ROUNDING.md`.

## 1. Immutable source to vendor (replaces P's 08f2efe / 823aa8 pins, and the earlier 2681e8a pins)

The source commit is `959e56fd7ea191bfcc7eb94b26a20d4795856bd3`. Read it with `git show 959e56f:<path>`; do not use the
working tree.

| file | sha256 | what changed for P |
|---|---|---|
| `holder/holder.py` | `c73a435116e2bd70ec0bfcf2717ed8eb7292be2a7d5b9b1cb3b71a3adbad9a42` | `validate_storage`: drops `otherNvmeCacheAllocations` and `nvmeInventoryPath` (both now refused as unknown fields). New `storage.nvmeBudget {ledgerPath, reservationId}`, required for `dm-cache` and refused for `none`. It imports `budget.py` from its own directory. Since 959e56f the reservation also carries `blockBytes` 4096, `metadataBytes` must be 4096-aligned, and the slack must be ≥ the required headroom |
| `holder/budget.py` | `529e155f74e9bc63e1bb3a3b18dda34baa79c09d016103f11c0e02b21216ad24` | **NEW**, vendor next to `holder.py` (v2: charges ACTUAL allocation) |
| `holder/holder-storage.sh.in` | `eb6a209d020703185090645cfcdc74390b242e31250ea49d625db246cecaeb00` | includes root's `b1b6f184` (validate before unmount) and `c3efff41` (unwind stops at the first failed cleanup), plus the budget calls. Constants: `PY BUDGET_TOOL LEDGER RESERVATION` replace `INVENTORY CAP SLACK` |
| `holder/FLAGS.json` | `7b2b87a4…e499e59` | unchanged |
| `holder/BINARY.json` | `b05bb8d8…f8521d00` | unchanged |
| `holder/holder.example.json` | `8f6922c5…cfe835a` | example config now uses `nvmeBudget` |

## 2. Canonical shared budget identity: one identity for every package and host

- **Path:** `/etc/enclave-rpc-cache/nvme-cache-budget.json`.
  - root-owned regular file, not group/other writable;
  - format `enclave-rpc-nvme-cache-budget/v2` (v1 is refused);
  - lock file is its sibling `nvme-cache-budget.json.lock`, used only for this budget.
- **Replaces:** both inventory paths (`/etc/enclave-rpc-cache/nvme-cache-inventory.tsv` and
  `/etc/enclave-base-holder/nvme-cache-inventory.tsv`). Neither inventory TSV is used any more.
- **Cap:** `capBytes` is exactly 250,000,000,000; `targetBytes` is 200,000,000,000.
- **Hosts:** keyed by `/etc/machine-id`. Each host's `shareBytes` is fixed, and the shares of all hosts must sum to
  ≤ cap. No host gets an implicit 250 GB.
- **Reservations:**
  - fields: `{id, host, owner, kind: "preallocated-files", blockBytes, maxBytes = Σ files.bytes + slackBytes, slackBytes, files: [{path, bytes}]}`;
  - file sizes must be multiples of `blockBytes` (the real filesystem block; only ext4/tmpfs), and `slackBytes` must be
    ≥ `budget.required_headroom(r)`;
  - each one is **charged at maxBytes even before its files exist**, and its ACTUAL allocation (files + markers +
    one entry block per file) is held ≤ maxBytes;
  - every listed host is also charged `BOOKKEEPING_BYTES` (77,824 B) for the ledger and lock;
  - directory entries are refused;
  - a host's reservations must fit its share.
- **Allocation:** only through `budget.py allocate LEDGER ID`. It takes the lock, writes O_EXCL ownership markers
  (`<file>.enclave-budget-owner`), and runs `posix_fallocate`. An interrupted create is adopted, never re-granted.
- **Assemble and `verify-cap`:** use `budget.py verify LEDGER ID`. It refuses a missing own file, a sparse, grown or
  foreign file, and share or cap overflow.

## 3. Minimal change P needs (P's default stays cache = none)

1. **Re-vendor** the files in §1 at their sha256 values; `budget.py` must sit beside `holder.py`.
2. **`l1pair.validate_storage`:**
   - remove the `otherNvmeCacheAllocations` / `nvmeInventoryPath` fields and the
     "must be declared explicitly" check (`l1pair.py:269-283`);
   - accept the optional `nvmeBudget` and pass it through to `H.validate_storage`;
   - for `cache: none`, send no `nvmeBudget`.
3. **`l1pair.storage_script`** (`l1pair.py:417-431`), constants for the new template:
   - add `'PY': '/usr/bin/python3'`, `'BUDGET_TOOL': <installed budget.py path>`,
     `'LEDGER': (s.get('nvmeBudget') or {}).get('ledgerPath', '')` and
     `'RESERVATION': (s.get('nvmeBudget') or {}).get('reservationId', '')`;
   - drop `INVENTORY`, `CAP` and `SLACK`;
   - keep P's own `NAME`.
4. **`l1pair.example.json`:**
   - delete `otherNvmeCacheAllocations` and `nvmeInventoryPath`;
   - with `cache: none`, P reserves **nothing**. The Base holder's reservation (199,140,835,328 B) lives only in the
     shared ledger, so it is never double-counted per package.
5. **If P ever enables a cache:** root adds a separate ledger reservation for it, so the host's sum stays within its
   share and the 200 GB target. P names that reservation in `nvmeBudget`.

## 4. Fixed budget example (one host; values from S's example config)

```json
{"format": "enclave-rpc-nvme-cache-budget/v2", "capBytes": 250000000000, "targetBytes": 200000000000,
 "hosts": [{"machineId": "<workstation /etc/machine-id>", "label": "workstation", "shareBytes": 200000000000}],
 "reservations": [{"id": "base-holder-dm-cache", "host": "<workstation /etc/machine-id>", "owner": "enclave-base-holder",
   "kind": "preallocated-files", "blockBytes": 4096, "maxBytes": 199140835328, "slackBytes": 67108864,
   "files": [{"path": "/vm/enclave-base-holder-cache/cache-data.img", "bytes": 197999984640},
             {"path": "/vm/enclave-base-holder-cache/cache-meta.img", "bytes": 1073741824}]}]}
```

- **Required headroom** of this reservation: 286,720 B, inside its 67,108,864 B slack.
- **Remaining headroom:** 859,086,848 B of the host share (200 GB target), after 77,824 B of bookkeeping. The 50 GB between target and cap is
  unassigned: no host share covers it.
- **Any other cache** (for example a Sia cache) needs its own root-approved reservation of a fixed-size kind, with a share
  that fits.
