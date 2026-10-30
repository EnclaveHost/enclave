# base-bytecode-check receipt v2: PREPARED source (first native test attempt incomplete, release NOT built)

**Source only.** This publication contains no build tree, cargo cache, target or binaries; bounded test failure receipts are included.

| Item | State |
|---|---|
| Native test job (23 tests + 17 exact controls) | **INCOMPLETE: cgroup memory limit stopped attempt 1.** Compilation passed; 20 test cases reported success before termination, with no aggregate verdict and no controls run. Exit 143; the kernel reported oom-kill at 22:51:55 UTC. The fixture read a default 4 GiB MDBX file into memory. A bounded fixture recovery is in preparation; the product scan streams rows. |
| Release binary | **NOT built.** The release-only runner is prepared (`release/`) and requires a complete passing test receipt and root pins; the original 2249 attempt failed, so this runner currently refuses and needs reviewed recovery receipt integration. |
| A2 | `BYTECODE_CHECKER_V2_SHA256` **stays `None`**. The `bytecodes-content-unverified` gap stays open. |
| v1 | `bytecode-native-validation` and its release `42d692d4…` are unchanged (`validation/frozen-v1-sources.sha256`). |

## Contents

- **`validation/`:** a byte-identical copy of `finality-stage/bytecode-v2-validation`:
  - crate, jobs, controls and inputs;
  - `STAGE-SHA256SUMS` `051e8fcc…`, which verifies 13/13 here, with `README.md` renamed to `STAGE-README-as-prepared.md`.
- **`release/`:** a copy of `finality-stage/bytecode-v2-release`: `root-release.sh`, `check_test_receipt.py`, `RELEASE-README.md` and `inputs/RELEASE-STAGE-SHA256SUMS` (3/3).
- **To be added only from root's actual results (never assumed):**
  - `evidence/` (test receipts);
  - `release-evidence/` (the release manifest).

## Receipt v2 digests: framed keccak-256 (NOT sha256)

The A2 proposal text (`a2-bytecode-integration/NATIVE-V2-PROPOSAL.md`, frozen) said *sha256*. **The implementation uses keccak-256** (`alloy_primitives::Keccak256`, already a dependency), so no `sha2` dependency, lock change or closure change is needed. The stable v2 definition:

```
digest = keccak256( domain || item_1 || ... || item_n || u64be(n) )
item   = for each part: u32be(len(part)) || part

rowsDigest       domain = "base-bytecode-check/v2/bytecodes-rows\0"
                 one item per Bytecodes row, MDBX cursor (key) order, parts [raw key, raw value]
codeHashesDigest domain = "base-bytecode-check/v2/code-hash-refs\0"
                 one item per HashedAccounts row whose bytecode_hash is Some(h), h != KECCAK256_EMPTY,
                 cursor (hashed-address) order, parts [hashed address (32 B), h (32 B)]
encoding         64 lowercase hex characters, no 0x
```

- Any change to this definition is a new receipt version.
- The A2 gate accepts any 64 lowercase hex, so no A2 code change is needed.

**Other v2 fields**, read in the same MDBX read transaction:
- `mdbxTxnId`;
- `bytecodesEntries` and `hashedAccountsEntries` (the table's own entry counts, not derived from the walk);
- `accountsScanned`;
- `checkpoints` {headers, bodies, execution, merkle-execute, finish};
- `datadir`.

The key set is exactly A2's 21 `BYTECODE_V2_KEYS`.

## Limits (honest)

- **The checker compiled** (test binary `29df9018ae3128bc8e07ede84dc343cd6b30308cef1549b01a25c789355169f5`); the full suite did not finish. The row, decoder, padding (including DUPN) and completeness rules are byte-identical to the tested v1.
- **The new rules are covered by** 10 new tests and 12 new exact controls. Their expected failing sets are predictions until root's run.
- **The release runner's receipt and artifact parsers have not been executed.**
- **A live run on the real datadir** (stopped, at N, after A2–A4) under root review is still required before any A2 pin.
