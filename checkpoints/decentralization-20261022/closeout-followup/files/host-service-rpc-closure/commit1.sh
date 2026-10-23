#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure/candidate
[ "$(git rev-parse HEAD)" = 4106c3114dd13f39692195c182d3152efa5e212c ]
git add network/host-services/policy-mirror.mjs test/policy-mirror-sync-race.test.mjs
[ "$(git diff --cached --name-only | tr '\n' ' ')" = "network/host-services/policy-mirror.mjs test/policy-mirror-sync-race.test.mjs " ]
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F - <<'MSG'
policy-mirror: a sync judges only the documents it captured

The race (hosted-policy-cold-start t2 on 4106c311):
- sync() verified a snapshot of the store;
- it then dropped every key of the CURRENT store that the verification did not cover.

So a document the admin POSTed while that verification was awaited was dropped as "not signed by the address book's
current owner at block N". A ban published only to that carrier was lost from it: enforcement was delayed to the gate's
grace, not bypassed.

The fix:
- capture (digest, entry) pairs before verifying;
- drop only an entry that is still the exact captured object, so a document published or re-published meanwhile keeps
  its own, fresher verification.

Unchanged: the owner signature, the book/registry/ownership binding, the anchor fill from carriers, and the prune.

test/policy-mirror-sync-race.test.mjs runs the real module over a real quorum snapshot of the loopback policy world. One
verification is held deterministically:
- the race case: 2/2 here, and FAILS on 4106c311 ("the ban published during the sync is still carried");
- the checks case (foreign-signed document refused on POST and dropped from disk; anchored document filled from
  importDir) passes on both.
MSG
git log -1 --format='%H %an <%ae> / %cn <%ce>'
