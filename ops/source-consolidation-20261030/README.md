# October 30 source consolidation

`main` is the maintained source tree. Production activation is separate from a
source merge. The project objective remains decentralized, censorship-resistant
hosting; independent authority, owner consent and verified identity are retained.

The starting main was `5ca9e61ddacd7d5887c02cacef80408d82605c5f` (October 25 UTC).
Work had accumulated in feature branches, installed overlays and dated snapshots.
This was an integration failure, not an absence of commits. The host copy and
search buttons were PRs 6 and 7 awaiting integration. The reported missing Shield
scheduler error had two causes: CI fetched shallow history, and the October 24
history rewrite changed commit identities while tests retained old pins. Unit CI
now fetches full history. The Shield pin is restored to
`e7ee6e34fc92bbc3d4da232c3078bee4486aa2ee`, whose extracted scheduler rule has
the exact original SHA-256 (the expected hash is unchanged). GPU-price and
custody counterexamples use the rewritten parents of their original fix commits.
The deployed registry fixture restores its original brand spelling and hostname,
recovering the exact SHA-256 and Git blob recorded in the deployment manifest.

## Maintained source reconciled

- Host command copying and deployment search clearing (PRs 6 and 7).
- Deployment lifecycle and confirmed lease-expiry reconciliation (PR 5), retaining
  current renewal authorization and confirmed-stop boundaries.
- Session funding and RPC gateway (PRs 2 and 3), current wallet-release controller,
  view/store/chain/promote modules, migration and self-host funding flows.
- Independent authority selection, host management, owner-committed startup,
  native desktop guest, bridge, broker UID check and the five unpushed native fixes.
- Shield pad spill, spare-CPU governor, keyed host bank, Z-Image model storage and
  init. Compact weights retain the newer allocation/layout work and exact arithmetic.
- Pad storage reserve/reaper, fleet ownership reporting and Windows update window.
- Shield benchmark evidence (PR 1), graph reservation and fixture repairs.
- Standalone Android pVM host, portable client, runner and associated source/tests.
- Ledger 16d owner-approved delegates, preserving owner-only deployment transfer,
  and legacy Windows app slot/epoch isolation. These source changes do not execute
  a ledger migration or enable the legacy engine.
- RPC preparation and live-adoption evidence through `e1ee422d3`; further runtime
  activation remains owned by the Decentralize enclave.host workstream.

Full-branch merges were unsuitable where earlier composed histories held stale
vault, CLI, runtime pins or transport code. Those changes were reconciled by path
and commit. Native commits before the 31-commit desktop range are represented by
`6f2c7da46` and later composition; the current custody vault retains `c46652197`.
The native desktop range and five local fixes were replayed with semantic conflict
resolution. The Shield integration retains current CUDA worker and launch guards.

## Preserved candidates and historical records

`candidate-manifest.json` records exact source bytes, bases, hashes and disposition.
Patches in `candidates/` are inert records, not another maintained source tree.
Apply them only after reconciling with main and satisfying their listed gates.
The owner checkouts were not modified or deleted.

The native recover/retire expansion and eight router modules have no verified
qualification record for these exact bytes. The historical 88-pass/2-fail run is
not qualification. Dedicated memory partitioning also needs its service-user,
manifest, migration and contention checks. These are explicit candidates, not
silently promoted production capabilities.

The connectivity-v2 naming patch changes contract selectors and explicitly requires
a new contract; deployed v1 calls would revert. Its source is preserved here while
maintained callers retain v1 compatibility. No financial or contract action occurs.
The TUNA conversion draft is historical because that transport was removed by
`a352286f4`. The public-web recovery snapshot has a later maintained implementation.

Other retained branch records include dated deployment/qualification evidence,
older publication and image pins, and lab-only Windows tools. The custom VBS branch
explicitly kept lab tooling off main (`8e850d31e`); its maintained launcher and the
missing fleet fixes are reconciled. The checkpoint branch holds frozen exports,
not the authority for current source. Old experimental image workflows must not
replace current release pins or start publishing on a source merge.

`branch-inventory.json` preserves the original audit inventory (108 maximal remote
tips), including exact source references and trial-merge differences. A difference
or non-ancestor count alone is not evidence that code remains missing: composed
and cherry-picked histories deliberately retain newer implementation. Conversely,
this inventory must not be used to claim every historical experiment is qualified.

## Validation and completion

PR 8 is the integration record. CI checks the complete root/network/wallet unit
suite in four shards, contracts, browser flows, native manager/guest source and
full site build. Scanner checks remain enabled. `security-review.json` records
reviewed false positives: public source identifiers, protocol strings, run IDs,
loopback test data and dependency-file digests independently rehashed from their
installed packages. Historical exceptions require the exact commit, path, rule and line fingerprint;
changed or future source remains scanned.

The compact-weight fixture passed ASan/UBSan and the focused Shield/config/pad
checks passed. A bounded required-cache compilation hit its memory cap; SD
calibration/activation-noise tooling requires an external header. Those checks are
not reported as passing. Source integration does not qualify a new production
image, runtime budget, Android install or contract deployment.

A completed implementation is committed, pushed, checked and integrated into main;
a local branch or dated deployment snapshot is not completion. See root AGENTS.md.

## Test boundaries

`npm test` runs checkout-local source tests, including wallet and network tests.
Thirteen native RPC qualification files are listed explicitly in
`test/helpers/rpc-qualification-files.mjs`. Run them with
`npm run test:rpc-qualification` inside an offline network namespace with the
pinned binaries and captured Base fixture directories described by each test
and `scripts/rpc-runtime/closure.json`. The qualification command fails on
missing inputs; source CI does not claim to qualify those external artifacts.
