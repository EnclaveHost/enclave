CRON / NUCBOX HOST REPAIR: RELEASE SOURCE PACKAGE (claude 9d6a7d6f; assembled 2026-10-21 ~15:05Z, date -u)
Copies only. No canonical copy (work/enclave, reconciled-candidate) was edited; nothing was built, pushed, tested or
probed for this package. Every byte is pinned in SHA256SUMS.

STATUS
  Root deployed on minipc (nucbox) on 2026-10-21:
    15:00:15  node-config.local.cmd edbef6dc -> 85698d20     the cron id appended; private backup; ACL kept
    15:00:25  host-admission.bundle.mjs 7ce23a55 -> 66c6e15a
    15:00:30  host.mjs 2500c650 -> c4629529
    15:01:03  ONE node-agent restart (51.1 s ingress pause): new agent 8644, run-node cmd 23976
  Verify receipt: no pin mismatch; respawn inspect is noop.
  Restart receipt: manager unchanged, other tasks unchanged, vmSetUnchanged FALSE (root's diagnostic, pending).
  Public health: being monitored by root. NOT claimed healthy here.

LAYOUT
  deployed/windows/node/host.mjs                   c4629529  exact deployed source = live 2500c650 + single-flight tick
  deployed/windows/node/host-admission.bundle.mjs  66c6e15a  exact deployed Windows bundle
  rollback-reference/                              2500c650 host.mjs and 7ce23a55 bundle (the pre-fix deployed bytes)
  source/network/                                  the 3 final network sources the bundle is built from:
      host-admission-runtime.mjs   f9e009da   429 budget opt-in (10 s) for the host-admission reader only, diagnostics
      lease-reader.mjs             907ba85d   rateLimitRetryMs option (default 0 = original behaviour), in-microtask gate,
                                              allSettled head step
      platform-host-policy-config.mjs 8ec507e0  PRODUCTION_MIRRORS = Object.freeze([])  (the deployed value)
  source/network-main-base/                        the canonical bases they replace (b0d4d2ab, d885b303, 6422d065)
  source/windows/node/host.mjs.deployed-c4629529   the deployed host.mjs (host.mjs is not bundled)
  patches/
      network-final-vs-main.patch                       e0e8d4ef  the 3 network files, against canonical
      platform-host-policy-mirrors-empty.patch          13cbd689  the [] constant alone (6422d065 -> 8ec507e0)
      host-tick-single-flight.live-2500c650.patch       a4d124fc  DEPLOYED base: 2500c650 -> c4629529
      host-tick-single-flight.main-d4b5d417.patch       715a949d  MAIN base, kept SEPARATE: d4b5d417 -> e41122d7
  tests/      admission-retry.test.mjs a7233ea3; windows-node-tick-single-flight.test.mjs d8ceb1af;
              test-respawn.py (Windows helpers, minipc fixtures)
  evidence/
      job-final.sh / job-final.out   provenance: canonical + [] == 7ce23a55 byte for byte; final == 66c6e15a;
                                     37 existing + new tests
      host-tick.RESULT.txt + *.tap   single-flight 6/6 (control 4/6); existing tick-path 16/16, live and main bases
      root-combined.tap              DEPLOYED closure (host c4629529 + bundle 66c6e15a + chain.mjs 75381…): 22/22
      respawn-test.out               Windows helpers 44/44
      CRON-STARTUP-RESULT.txt        the startup diagnosis
  activation/  root-activate-fix.py ac9a4368, root-approved-fix.json bf1f8591, activate.py c6da79b8,
               cron-respawn.ps1 bb96884f, node-restart.ps1 beac40d9, bundle-swap.ps1 21d85c69, receipts/
               (root's stage / preflight / config / bundle / host / restart / verify receipts)
  build/reproduce-bundle.sh   rebuilds 66c6e15a from canonical + source/network with the EXISTING build script, in a
                              scratch copy. Already proven by evidence/job-final.out (steps 1 and 3); not re-run here.

CAUSAL STATEMENTS (what is proven and what is not)
  - QUEUED cause (minipc logs; proven):
      - a manager restart storm (11:28-11:52Z, before root's 12:13 repair);
      - the fresh partition died in early guest boot at 11:55:52Z: same bundle AppID; it died before egress, secrets or
        the app;
      - the node's give-up default (no respawn) then left the lease to lapse at 12:09:01Z.
  - Contributor (proven by logs): "host wallet policy unavailable (chain quorum unavailable)" made the node RETIRE running
    VMs (11:39:38, 14:05:30Z, repeated later). Overlapping ticks plausibly amplified it: identical retire timestamps; the
    single-flight test proves the overlap is removed. The duplicate-renewal race was NOT reproduced by a test.
  - Quorum cause: drpc HTTP 429 was OBSERVED. Broad rate limiting of ALL configured RPCs is NOT proven. The new bundle's
    per-RPC diagnostics (label, step, HTTP status) must show it before that is claimed.
  - The screenshot's "WASM … exited i32 status 1, stderr [cron]" (VSOCK export): its ORIGIN IS UNCERTAIN. It is stale or
    from another host attempt; nothing on minipc in the window shows it.
      - cron 0.1.3 exits 1 with "[cron]" ONLY on a configuration-load failure; reproduced: missing secret, short secret,
        unknown field, bad URL, no config.
      - Every minipc launch had its 6 secrets delivered first.

CANONICAL INTEGRATION: DONE 15:09-15:11Z per root decision (canonical DO mirror list KEPT). See
  ../canonical-integration/CANONICAL-INTEGRATION.txt. The proposal below is kept as written before that decision.
CANONICAL INTEGRATION PROPOSAL (as proposed)
  work/enclave (e762a9c5, dirty, old history) and the reconciled candidate (tree 7990461e) have IDENTICAL bases for every
  touched path:
    windows/node/host.mjs                    d4b5d417   (!= live 2500c650: main carries unrelated features; production
                                                         stays the explicit live overlay c4629529)
    windows/node/host-admission.bundle.mjs   e83515fc   (main build: CONTAINS the 4 DO /platform-policy URLs, != deployed)
    network/host-admission-runtime.mjs       b0d4d2ab
    network/lease-reader.mjs                 d885b303
    network/platform-host-policy-config.mjs  6422d065   (untracked in work/enclave git: "??")
    metal/guest/host-policy.bundle.mjs       8b2dfbc6   (also has the DO URLs)
    scripts/build-host-admission.mjs         63cc1377   (unchanged, used as is)
  Proposed, each step CAS on the base hash above:
    1. network/*: apply patches/network-final-vs-main.patch.
       -> f9e009da / 907ba85d / 8ec507e0
    2. DECISION FIRST: PRODUCTION_MIRRORS [] in main.
       - It changes every bundle built from that constant: the Windows host-admission, metal host-policy, mcp-server and
         platform-api bundles.
       - Tests that reference the constant need updating: hosted-policy-cold-start and lease-relay-host-policy (they
         assert PRODUCTION_MIRRORS[0] was tried) and site-host-policy (its vendored list must equal it).
       - If root keeps main's DO URLs, integrate ONLY the two reader/runtime files. The Windows deployment then remains an
         explicit overlay ([] + 66c6e15a), recorded as such; it must not be silently "re-synced" to main's bundle.
    3. windows/node/host.mjs: apply patches/host-tick-single-flight.main-d4b5d417.patch (d4b5d417 -> e41122d7). That is
       the main base, separate from the deployed patch.
    4. Rebuild ONLY windows/node/host-admission.bundle.mjs with scripts/build-host-admission.mjs:
         - with step 2 = []: expect 66c6e15a (== deployed);
         - otherwise: a main-flavoured bundle that is NOT the deployed one.
       metal/guest/host-policy.bundle.mjs changes too (acfa1b00 with []): it is not deployed to nucbox; deploy separately.
    5. Add tests/admission-retry.test.mjs and tests/windows-node-tick-single-flight.test.mjs to test/.
    6. Apply the same to the candidate through its refresh method (reconciliation/refresh.py), not by hand.
  Do NOT: reset or rewrite history, rebuild unrelated packages, push, or touch production from integration.

ROLLBACK (root only; root-activate-fix.py with root-approved-fix.json; every step through the queue; ORDER MATTERS:
the wrapper's pins follow the live code at each step)
  1. python3 root-activate-fix.py verify
       NEW-code pins (host c4629529 + bundle 66c6e15a): confirms what is live before anything is undone. Do NOT start
       with `preflight`: it expects the OLD code and refuses now.
  2. python3 root-activate-fix.py rollback-host   --execute
       host.mjs c4629529 -> 2500c650 (private backup, CAS, ACL restored)
  3. python3 root-activate-fix.py rollback-bundle --execute
       bundle 66c6e15a -> 7ce23a55
  4. python3 root-activate-fix.py rollback-config --execute --expect-local 85698d20b4f8fb494c8620aeb80d5b4fbd2ec637ef40c7fa02693ba41ee2aa73
       node-config.local.cmd -> edbef6dc (backup in C:\ProgramData\Enclave\.cron-respawn)
  5. python3 root-activate-fix.py preflight
       OLD-code pins again: confirms the restored files and returns the CURRENT agent / run-node cmd identity
  6. python3 root-activate-fix.py rollback-restart --execute --expect-agent-pid <from 5> --expect-agent-start <from 5> \
          --expect-cmd-pid <from 5> --expect-cmd-start <from 5>
       ONE node-agent restart onto the restored files.
  Identity at 15:01Z, for reference only (any agent restart changes it):
    agent 8644 @ 2026-10-21T15:01:03.6706520Z; cmd 23976 @ 2026-10-21T15:01:03.5932460Z.
  The manager must still be 35464 @ 2026-10-21T12:13:07.5552110Z (the manifest pin). If the manager restarted, root
  updates the manifest first.
