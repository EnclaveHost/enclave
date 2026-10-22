RETIRED (round 3, 2026-10-20). Kept only as history; nothing here is current, buildable or a plan to sign.
- patches/design-b-*.patch, patches/app-lease-gas.patch: round-2 hunks against main. They call the REMOVED client API
  (status/buildLease/signLease/submitToRelays), fall back silently when relays are missing, and predate the reviewed
  deployment record + RPC quorum. Superseded by patches/current-*.hunk.patch (generated from CURRENT main by
  scripts/rebase-linux-supervisor.py and scripts/rebase-windows-host.py) and patches/lease-gas-cli-dispatch.hunk.patch.
- plans/ten-app-enrollment.json: round-2 ILLUSTRATIVE plan with a hard-coded 0.003 ETH per app and obsolete host
  env/patch paths. Superseded by the owner CLI's no-default budget workflow (`enclave --independent … lease-gas plan
  --inventory … (--per-app-eth X | --per-app-wei N | --days N)`), shown for the exact ten inventory IDs in
  plans/ten-app-cli-plan.* (Base-fork run, scripts/fork-ten-app-plan.mjs).
Byte-identical originals with their hashes: snapshots/round2/MANIFEST.sha256.
- test/supervisor-lease-executor.test.mjs, test/windows-chain-lease-gas.test.mjs: round-2 rigs of the retired hunks
  (old client API). Superseded by test/supervisor-current-runtime.test.mjs (actual Linux supervisor candidate) and
  test/windows-current-runtime.test.mjs + test/windows-lease-closure.test.mjs (actual Windows chain module + bundle).
