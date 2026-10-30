# Browser / site read authority: opt-in own read authority (PREPARED; NOT run, NOT built, NOT deployed)

- **Base:** `relay-consumer-source` `bf77da364373a9c7d881489af5b760207a03997c`, read only via `git show`/`git archive`.
- **Private tree:** `tree/` is a `git archive` of that commit plus the overlay below, with a `node_modules` symlink. It
  is not a git worktree, and no checkout was edited.
- **Patch:** `browser-read-authority.patch`, 9 files: 5 modified, 4 new.

## Change (minimal; legacy behaviour is the default)
| file | change |
|---|---|
| `site/js/core/read-authority.js` (new) | `READ_AUTHORITY_TEXT = null` (the one build-replaceable declaration); `parseReadAuthority`; `resolveReadAuthority`; `fallbackUsesPool`; `sessionsRpc` |
| `site/js/core/config.js` | `READ_AUTHORITY = resolveReadAuthority(...)`; hosted `APP_CATALOG_RPCS` = its pool. Legacy pool and dev-override rules are byte-for-byte the old ones |
| `site/js/core/chain.js` | `baseRpc` with an empty pool and no independent profile now says the release read authority is invalid (it refuses; it never contacts anyone) |
| `site/js/core/wallet.js` | `fallbackRead` uses the read pool under a release authority (legacy hosted: unchanged `mainnet.base.org`). `addChainRpcs`/`rpcMap` (wallet signing) untouched |
| `site/js/core/sessions.js` | hosted `rpcFor` via `sessionsRpc`: legacy unchanged (relay config rpc, else pool[0]); own-rpc uses only the pool; invalid refuses |
| `scripts/site-read-authority.mjs` (new) + `scripts/build-site.mjs` | `--read-authority FILE --read-authority-digest sha256:` follows the same reviewed-file/digest/esbuild-onLoad pattern as `--built-in-profile`. The two flags are mutually exclusive |
| `docs/network/browser-read-authority.md` (new) | operator doc: the trust statement and the activation gate |
| `test/browser-read-authority.test.mjs` (new) | see below |

## Trust (must not be overstated)
- **"own-rpc" is a TRUSTED SELF-HOSTED TRANSPORT:** HTTPS JSON-RPC to the operator's own Base node. It removes the
  third-party providers.
- **The browser does NOT verify proofs or finality**, exactly like the legacy pool. It is not the local verifier and
  not an attested route.
- **Production activation** must be gated by root on a qualifying backend: the own node synced, HTTPS with CORS for
  the site origin, and cross-checked against independent sources.

## Tests (written; NOT run)
`test/browser-read-authority.test.mjs`:
- **Pure:** legacy default and dev override unchanged; own-rpc uses only own endpoints with the dev override not mixed
  in; 20 invalid or mislabelled authorities, each giving an empty pool (no public fallback); precedence of the
  independent profile; the wallet fallback truth table; the sessions RPC (a relay rpc is ignored under own-rpc, invalid
  refuses).
- **Build seam:** flag pairing; digest; third-party refusal; exactly one declaration.
- **INTEGRATION:** the REAL `config.js` and `chain.js` `baseRpc` from a per-scenario copy of `site/js`, transformed by
  the plugin's own function, with a `fetch` spy:
  - own-rpc reads go only to own URLs; WalletConnect is unchanged;
  - an own outage is bounded to own URLs, then errors;
  - invalid gives zero fetches and a refusal;
  - legacy: the existing pool, and a planted override is ignored on the production origin.
- **Credit contract:** `createQuorumReader` refuses one origin or quorum 1.

**Regression (unchanged suites):** `config-dev-overrides`, `site-built-in-profile`, `site-independent-{bundle,profile,
identity,live-reads,management-unit}`, `admin-console`, `admin-metrics`, `api-base-binding`, `catalog-version`,
`featured`, `pay`, `reviews`, `publish-cid-verify`.

## Root command
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/browser-authority-stage
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $S/logs/root-browser-tests.guard -- unshare -rn bash $S/jobs/root-browser-tests.sh
```
- **What it does:** `lo` up, `MANIFEST.sha256`, `verify_tree.py` pre-check (reused byte-identical from
  consumer-remaining-stage), 16 suites each with TAP and zero skips, then a post-check.
- **Exit codes:** 1 if any suite fails, 2 on a harness error.
