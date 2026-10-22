public-cold-frontend r2 - site media fallback for CID-backed logos/banners/dashboard chips
Status: source patch ready for root review; not built, not deployed. Receipts: RESULT.json (r1 files kept as *.r1.*).

WHAT / WHY
  Root's r3 cold browser (fleet blocked) showed 8 cards with only ipfs.enclave.host image requests. The site has a single
  image gateway painted as CSS background-image (no error event), so cards get empty bands - the disappearing-logo complaint.
  No existing fallback was bypassed; none existed. The patch adds one shared bounded path in catalog.js and wires the app card,
  the app-detail banner and the dashboard chips to it. Alternates are gateways the product already uses (ipfs.io = IPFS_GATEWAY;
  dweb.link = CLI/supervisor default) or, in independent mode, the operator's STORAGE_PLAN replicas.
  This is transport fallback only: a second URL is not a second copy.

r2 CHANGES (root's corrections)
  * Answers expire: a gateway hit is fresh for 10 min, a miss for 60 s. Inside that window, renders repaint with no request.
    The first render after expiry re-checks the ordered list once (shared by all callers) while the last answer stays painted.
    So an outage heals, a dead chosen gateway is replaced, and the preferred gateway wins back when it recovers.
    There are no timers of its own: at most <= 4 attempts per CID per window, and only when that CID is rendered.
  * The synchronous applyMedia path honours expiry. The stale-element guard is kept. The banner hides and unhides via onResult(shown).
  * Availability wording: holding/retrieval outside the fleet is UNVERIFIED. The 429s, 526s and timeouts returned no content,
    and one routing service returning nothing is not proof of absence.

APPLY (root)
  cd <copy of reconciled candidate> && patch -p1 < patch/media-fallback.patch   # sha256 04836638...; reproduces src/ exactly
  This does not apply to main 7752a423 - ship it on the candidate.
  Build:   node scripts/build-site.mjs
  Package: site/deploy.sh prepare --out DIR --base <current release>

RE-RUN TESTS (through the queue only)
  tools/run-unit.sh <tag> src      9/9. Negative controls: mut1 -> 2 fail (intended); the r1 patch -> 3 fail (intended)
  tools/run-browser.sh <tag> src recover|alt-ok|all-down

STILL OPEN / FOR ROOT
  * Verified non-fleet retrieval of the 8 media CIDs. If no non-fleet holder exists, they must be pinned and announced on
    authorized non-DO infrastructure. Acceptance = sha256-verified bytes from a recorded non-fleet holder with the fleet blocked.
  * ipfs.io and dweb.link returned 429 from this egress.
  * fetchConfigCid (dashboard Config text) is still single-gateway. Publish previews are unchanged.
  * RPC: ~154 publicnode calls match the unbatched per-app design. Not on the media path; no change made.
