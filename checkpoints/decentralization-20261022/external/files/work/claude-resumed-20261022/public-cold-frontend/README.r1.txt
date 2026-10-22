public-cold-frontend - site media fallback for CID-backed logos/banners/dashboard chips
Status: source patch ready for root review; not built, not deployed. Full receipts: RESULT.json.

WHAT / WHY
  Root's r3 cold browser (fleet blocked) showed 8 cards with only ipfs.enclave.host image requests: the site has a single
  image gateway painted as CSS background-image (no error event) -> empty bands = the disappearing-logo complaint.
  No existing fallback was bypassed; none existed. Patch adds one shared bounded path in catalog.js and wires the three
  media surfaces (app card, app detail banner, dashboard chips) to it. Alternates are the gateways the product already uses
  (IPFS_GATEWAY ipfs.io; dweb.link = CLI/supervisor default) or, in independent mode, the operator's STORAGE_PLAN replicas.
  Transport fallback only: a second URL is not a second copy.

APPLY (root)
  cd <reconciled-candidate copy> && patch -p1 < patch/media-fallback.patch     # sha256 c09c4430...; reproduces src/ exactly
  Does NOT apply cleanly to main 7752a423 (older config.js/catalog.js) - ship on the candidate.
  Build/package: node scripts/build-site.mjs; site/deploy.sh prepare --out DIR --base <current release>.

RE-RUN TESTS (queue only)
  tools/run-unit.sh <tag> src        # 7/7 ; ref = negative control 0/7
  tools/run-browser.sh <tag> src alt-ok | src all-down | ref alt-ok

STILL UNAVAILABLE / FOR ROOT
  * The 8 media CIDs have 0 providers (delegated-ipfs.dev) and no IPNI record; only ipfs.enclave.host serves them (verified).
    Prerequisite: pin + announce them on a holder outside the fleet; re-run probe/live-media-probe.py to prove it.
  * ipfs.io/dweb.link returned 429 from this egress.
  * fetchConfigCid (dashboard Config text) still single-gateway; publish previews unchanged.
  * RPC: ~154 publicnode calls match the unbatched per-app design (no bug on this path, no change); batching is an option.
