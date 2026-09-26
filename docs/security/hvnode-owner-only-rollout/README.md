# B rollout: owner-only serving on the NucBox hv-node row

This is enclave-87's order, 2026-09-26. bf reviews this package together with B.

- **B:** origin/relay/hvnode-owner-only-v2 @ 9df50309, two commits on main 68e96b11. It is pinned in `lib.sh` (BASE, BC,
  and the sha256 of each relay file).
- **Run from:** warden-host.
- **When:** in a window 63 opens, not during a relaunch.
- **Prerequisite:** b4's node change (v2 attach, delegations, and has-secrets via /v1/secrets/exists) is on main first.

Each step is its script followed by `b-accept.sh <step>`. Stop on the first unhealthy step and roll back THAT step only. To
unwind the whole rollout, go in reverse order: 3, 2, 1b, 1.

| step | script | what changes | rollback |
|---|---|---|---|
| 1 | `b-1-push.sh` | B is fast-forwarded onto main. The Deploy run must be detect + relay + site, all success. The relay job deploys nan (api relay) and nan-relay. | `b-rollback-code.sh` (a revert pushed to main) |
| 1b | `b-1b-uswest.sh` | us-west, manually (U7 step 4's shape): back up relay.js + fleet.mjs, copy fleet.mjs then relay.js, restart enclave-tcp-relay only. It needs Steven's us-west ssh master (`ssh -O check us-west`); without it this step is HELD and steps 2 and 3 proceed. | `b-rollback-uswest.sh` |
| 2 | `b-2-hvops.sh on` | nan's api-relay.env gets `RELAY_HVNODE_OPERATORS=0x389c…`: one line and one restart (`env-line-remote.sh`). | `b-2-hvops.sh off` |
| 3 | `b-3-reverify.sh on` | nan's api-relay.env gets `RELAY_REVERIFY=enforce`: one line and one restart. | `b-3-reverify.sh off` |

## `env-line-remote.sh` (steps 2 and 3, on nan as root)
- **What it accepts:** exactly the two reviewed lines, nothing else.
- **Before it writes:** the relay files must be B's, by hash. The file must be 0600 root and end with a newline.
- **On:** the key must be absent before the edit. Two independent edits (cp+append and awk) must agree.
- **Off:** exactly one reviewed line must be present.
- **TRUSTED_OPERATORS:** its line is recorded as a digest before and after. It must not change. The wrapper re-checks this
  from outside.
- **Restart:** one restart, after which the relay must stay up 30 s. If it does not, the pre-edit copy goes back at once.
- It prints no env value.

## `b-accept.sh` (read-only)
Every step runs `health.sh` first:
- the known-answer test PASS in the CURRENT invocation;
- the 3 canaries 200/0, each on the key its guest printed at boot (guestd serial);
- us-west listed at 5.78.85.108 with labels;
- release ON for exactly the 3 canaries;

and the checks common to every step:
- metal-iso0 eligible;
- nucbox-k11 an hv-node row, not eligible, not serving;
- nucbox-k11 never in /v1/relays.

Then each step's own checks:
- **1:**
  - a new api-relay invocation;
  - nan's and nan-relay's relay files are B's;
  - nucbox-k11 is NOT owner-only yet;
  - the site loads and every executable inline script's hash is in the live CSP (`csp-check.py`; JSON-LD excluded;
    negative controls tested);
  - B's pricing.js run on the LIVE rows: nucbox-k11 is never a `tee-gpu`.
- **1b:** us-west's relay.js/fleet.mjs are B's; the canaries return 200 via DNS.
- **2:**
  - if the node attached with v2: owner-only, with operator = 0x389c…. Otherwise it reports "NOT EXERCISED";
  - a stranger's deployment (a canary) on the nucbox splice path gets 503;
  - test 1 (0x31136008): its served-list membership and its hostname status are reported.
- **3:** `aggregate.reverify.mode` is `enforce`, and there are 0 dialed rows. Every tunnel row's verdict is as before:
  metal-iso0 eligible, us-west a relay, nucbox-k11 not eligible.

The TRUSTED_OPERATORS digest before and after each step is in the evidence directory (~/enclave-bench/b-rollout-20260926).

## Step 1b, re-checked 09-26 07:55Z for enclave-87 (HELD until Steven opens the us-west master; runs only on 87's word)

- **Still applies unchanged.** Main c6347dd2's relay.js (68cd3b93) and fleet.mjs (0441e47d) are byte-identical to B's (407f0936).
  us-west still runs the pre-B pair (e0cb218f / 384a1ef1 = 2144fcb3), and 1b refuses anything else.
- **Nothing beyond relay.js + fleet.mjs.** Their import closure is relay.js, fleet.mjs, connlog.mjs and net-guard.mjs, plus
  node:*, ws and viem. It is the same at pre-B, B and main, and connlog.mjs and net-guard.mjs are unchanged since pre-B, so they
  are already on us-west. pacing, rs-11, rs-12, rpc-bounded and owner-grace change secrets-release.mjs, api-relay.js, tunnel.js
  and env lines: none of them is in us-west's closure.
- **New in b-1b-uswest.sh:** before any copy, us-west's connlog.mjs and net-guard.mjs must equal the pins (a refusal otherwise).
  After the copy, all four closure files are verified.
- **New in b-accept.sh 1b.** On top of B's relay.js/fleet.mjs + the closure on us-west and the canaries 200 via DNS:
  - test 1 (0x31136008) on its PUBLIC hostname answers 200 on the partition's key: sha256 of the SPKI DER = TEST1_SPKI, pinned
    at run time from d1's current value, since the key changes at the v42 reboot. An unpinned TEST1_SPKI FAILS the accept.
  - the attestation document on that hostname binds the public handshake (transportKey = the handshake SPKI);
  - an unleased listed deployment's hostname (at us-west) is refused.
- **b-1b-dry.sh (no us-west access), 17/17 at 07:55Z:**
  - the pins and closure;
  - node --check;
  - fleet 17/17, owner-only-fleet 3/3 and custom-domain-routing 6/6 at main;
  - the closure refusal against fixtures;
  - live public reads: test 1 refused today (pre-1b); a canary 200 on its key with its document bound; the stranger probe
    (a69dcbba, unleased, at us-west) refused.
- **Rollback:** b-rollback-uswest.sh (unchanged): the *.pre-b files back, restart enclave-tcp-relay, the canaries 200 via DNS.
