public-config-read-fallback r2 - verified multi-gateway read for pinned configs (fetchConfigCid)
Status: source patch ready for root review; not built, not deployed. Receipts: RESULT.json.

APPLY (root, after the accepted media patch 04836638)
  cd <candidate copy with media-fallback.patch applied> && patch -p1 < patch/config-read-fallback.patch   # f5b6df1a; 3 files

WHAT
  * fetchConfigCid reads from the preferred gateway, then the accepted media fallbacks (same list, no new providers).
  * Text is returned ONLY if its bytes reproduce the CID - from every gateway, the preferred one included.
  * CID strings are decoded semantically (unixfs.js parseCid). Accepted: CIDv0, CIDv1 base32/base58btc, sha2-256, raw or dag-pb,
    canonical spellings only. raw = sha2-256 of the bytes; dag-pb = artifactIdentity root under the pin profile.
  * Bounds: 10 s and 1 MiB per attempt, 30 s and <= 4 gateways per round.
  * Concurrent callers share one round. A failure is held 30 s, then the next use retries. Only verified text is cached.

NOT SOLVED (honest compatibility)
  * dag-pb configs of other layouts - including Kubo cid-version=0 defaults, i.e. any Qm of a file <= 256 KiB - now read as
    unreadable in the dashboard and publish prefill. They were previously shown unverified. The runtime still runs them.
  * On-chain config CIDs were not enumerated (no network in scope). Root should classify them with configCidForm() before release.
  * Full parity for those forms needs a browser CAR verifier. multiformats is not installed for the site build, so it was not used.

TESTS (queue only)
  tools/run-unit.sh <tag> src                                         # 32/32
  tools/run-unit.sh <tag> base|mut-* test/config-read-fallback.test.mjs   # intended failures
