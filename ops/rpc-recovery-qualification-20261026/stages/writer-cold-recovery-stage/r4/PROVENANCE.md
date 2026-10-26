# writer-cold-recovery-stage/r4 provenance (prepared; NOT run by Claude)

**Base:** r4 = the frozen cold-recovery r3 (`SHA256SUMS` `320b80b8cadaeaa622717da96522d64460ea1dee0d5372e793fb525088ac280e`, tree `a4dd62c303e2742dadc2b5fdf9d6d0023e5cd91a`)
+ `patches/writer-cold-recovery-r4-vs-r3.patch` (sha256 `d73f127d0b19ead245ee024d2cf3328ca006832be3ad708e839c8d7c8aa977c0`, `--full-index`) = tree **`571b5c84a8ffe3e6bc9c21ca4184a5b4a7ebb1af`**.

**What it repairs** (`inputs/claude-history-r3-review-1592.md`):
- **M1:** per-method boundedRpc byte caps, and one scan-wide call/byte budget over every own-node call;
- **M2:** a batch aborts its other calls on the first failure and settles them before the scan rejects;
- **L1:** cache statistics count only committed chunks.

**Reproduction:** in the private scratch `/tmp/w8`, the r3 tree `a4dd62c3` was rebuilt from `/tmp/w6` (`git diff --cached` read-only + apply); reading the r3 tree into a fresh index and applying this patch with `git apply --cached` gives `571b5c84` exactly. `/tmp/w6` and `/tmp/w7` were not modified.

**Not done:** no tests, builds, `node` runs, network, USB or live actions. **Executed:** `bash -n` on the job, sha256 sums and scratch git trees only.

## Touched paths (r3 → r4, sha256)
| path | r3 | r4 |
|---|---|---|
| network/derived-reader/backward-history.mjs | 789d67c9d3e307d15b225c5ab206c73886841239d7ab0edffdb2e8bf389e883b | 49e834d555d4cf199589ea1900ff5d088f918846ff1d2b6de3e30789f492cd7d |
| network/derived-reader/provider.mjs | dcf0f177433a1af378fd00166b46eb517c58a5330fa1b0c32e6108896fd7fcb6 | 1cf1da3453f6ff2f9674ba22e1db296f8b4ee501228cebeac6bd91f6f5549351 |
| test/derived-reader/backward-history.test.mjs | 33236d5cafd969aabfe34ca614764188dd25a78216a05b8921f3033cdce497e6 | 21334a25266002f44893760986cec90aaf350e964de8b2cd881961aac02d0b20 |

**Untouched:**
- `network/derived-reader/rpc.mjs` (boundedRpc is used as is);
- the writer authority, coverage-store, lifecycle, `op-receipts-root.mjs`, `vendor/anchor-bootstrap.mjs`.

## Expected counts
| suite | tests |
|---|---|
| backward-history | **16** (r3's 13 + 3) |
| writer-history | 9 (unchanged) |
| everything else | unchanged from r3 |

## Merge into an integrated stage (root coordinates)
1. Apply with `git apply --index` on any tree whose three paths equal the r3 blobs (`023eefdc…`, `fde14516…`, `84e20475…`); otherwise use `git apply --3way`.
2. The `provider.mjs` hunk is one `historyRequest:` line plus one import line; **producer placement** in the integrated stage must keep `historyTransport(maxBytes => boundedRpc(baseUrl, { maxBytes, timeoutMs: 60000 }))` wherever the history transport is constructed.
