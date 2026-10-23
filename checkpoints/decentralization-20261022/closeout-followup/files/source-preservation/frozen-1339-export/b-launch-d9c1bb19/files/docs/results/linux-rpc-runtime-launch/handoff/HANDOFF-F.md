# Handoff to F (Windows final baseline): what linux-rpc-runtime-launch changed in shared files

Written 2026-10-23 from linux-rpc-runtime-launch. It is read-only for F: nothing here was written into F's tree, and
F's work is not overwritten. The patches are byte-exact exports (`git format-patch --full-index --no-renames
--no-signature 5d2d2c3c9..673601e54`), and their sha256s are in `PATCHES.sha256` beside this file.

## Lineage (different from F's)

- **This tree:** Linux lineage fad657bc5626166bde1bde4454ec4f73d23dde47 (linux-carrier-closure; it descends from D's
  image commit fec43a6a), then A 25c051a95..e820e2405, P 9fdc1418c..9e838ba75 and B dc8adb8e1..c31e975a4 as patches.
  - That gives 5d2d2c3c9 (tree c4d4e732).
  - Then my 7 commits give **673601e54**.
- **F's candidate** (`windows-final-baseline-compose/candidate`, read only) is on the host-service lineage 14d1e495.
  - It has none of `network/rpc-runtime*.mjs` or `network/runtime-lock.mjs`.
  - Its `metal/guest/gsup.mjs`, `metal/enclave-metal.mjs`, `metal/overlay-control-image.py` and the host-admission bundle
    are different blobs from this lineage's.
  - So **none of these patches applies to F's tree, and F does not need to take any of them** for the Windows baseline.

## Shared files touched here, and what F should do

| file | change here | for F |
|---|---|---|
| `network/rpc-runtime.mjs`, `network/rpc-runtime-main.mjs` (patch 0001) | adds the optional `glibcRuntime` (pinned 4-file set) and `binaryStaging: 'verify-in-place'`. Both are absent by default, so the default `copy` behaviour is unchanged | Nothing, unless F composes the verifier runtime later. Then take 0001 on top of c31e975a's runtime, not a copy of the file |
| `windows/node/host-admission.bundle.mjs` (patch 0003) | a **generated** file, rebuilt with `scripts/build-host-admission.mjs` because A's `network/lease-reader.mjs` change (b7f88a862 here) entered this lineage: 2dba0ceb → **efaf6fdb** | **Never copy these bytes.** F's bundle must come from F's own sources via the same builder plus `--check`. If F corrects `network/lease-reader.mjs` or any other bundle input, the Linux image's bundle must also be rebuilt in this lineage, which means a new image measurement |
| `metal/*` (patches 0002, 0004, 0006, 0007) | Linux guest only: the opt-in checker `metal/guest/chain-verifier.mjs`, the gsup service, the launcher pass-through, the image pin record, both image builders | Nothing (Linux guest) |
| `docs/network/local-chain-verifier.md` (0007) | a new section, "Inside the Linux metal guest" | Nothing |
| tests (0002, 0004, 0005, 0006, 0007) | new guest tests, plus text pins updated for the new gsup line and helper lists | Nothing |

## Not composed here (F's scope)

- **A df8fbafa** (A's Windows verifier baseline): not applied. Its Windows host-admission bundle does not apply onto
  fad657bc's rebuilt bundles, and it is F's Windows baseline.
- **`test/windows-verifier.e2e.test.mjs`** (from my c31e975a): excluded when B's range was applied, for the same reason.
  It belongs with df8fbafa in F's composition.
- **The other bundles whose `--check` already failed at fad657bc** (Windows lease runtime, MCP and platform API guest
  bundles, host-service packages; see 714aa0dcd's message): untouched here.
  - This also explains `test/mcp-hosted-control.test.mjs` #26 failing (a stale MCP bundle), on the 5d2d2c3c9 baseline
    and on HEAD alike.

## If F changes a shared network module

Send the commit, and this tree (or its successor) re-applies it on the Linux lineage, rebuilds the host-admission bundle
and reruns the guest tests. The verifier runtime's own files (`network/rpc-runtime*.mjs`, `runtime-lock.mjs`,
`witness-*.mjs`, `gossip-head-source.mjs`, `s3-witness-cache.mjs`) are B's; their source pin is c31e975a + 0001.
