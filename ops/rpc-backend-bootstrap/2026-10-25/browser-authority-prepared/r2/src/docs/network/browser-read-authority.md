# Hosted site read authority (release-time, opt-in)

The hosted site (`site/`) reads Base through one pool: `APP_CATALOG_RPCS` in `site/js/core/config.js`, used by
`site/js/core/chain.js` `baseRpc`.
- **Readers:** catalog, deployments ledger, featured, reviews, payments, address book, the network page, sessions and
  the wallet's read fallback.
- **Default (unchanged):** the legacy pool of third-party public RPCs.

## Choosing an own read authority for a release

```
node scripts/build-site.mjs --read-authority authority.json --read-authority-digest sha256:<sha256 of the file as reviewed>
```

`authority.json`:
```json
{ "version": 1, "mode": "own-rpc", "trust": "self-hosted-transport",
  "rpcs": ["https://<the operator's own Base node RPC origin>"], "note": "optional, short" }
```

**What the build checks:**
- **The file:** it must hash to the reviewed digest, be UTF-8 JSON with unique keys and no unknown key, and be 4 KiB or
  less.
- **Endpoints:** 1–4 https endpoints, each a distinct origin, with no credentials, query or fragment, and none on a
  known third-party provider domain.
- **Exclusive:** it cannot be combined with `--built-in-profile`.

**Embedding:** the build embeds the exact text in `read-authority.js` (`READ_AUTHORITY_TEXT`); the source tree is never
edited.

**Runtime behaviour in that release:**
- **Pool:** hosted reads go **only** to those endpoints. There is no public pool and no loopback dev override.
- **Wallet read fallback:** it uses the same pool.
- **Outage:** the existing bounded rotation stays on those endpoints, and the read then fails with an error.
- **Invalid authority:** an embedded authority that is invalid makes the pool empty, so every read refuses.
- **Never** does a read fall back to a public provider.

## What it is, and what it is not
- **It is a trusted self-hosted transport:** HTTPS JSON-RPC to the operator's own node. **The browser does not verify
  proofs or finality** of those answers; neither does the legacy pool.
- **It is not** the local proof verifier (`network/chain-authority.mjs`, loopback-only on hosts) and **not** an attested
  route. Do not label it either.
- **Activation:** gate it on a qualifying backend under root review. The node must be synced, served over HTTPS with
  CORS for the site origin, and checked against independent sources before the release is published.

## Unchanged
- **User's independent profile:** a saved or built-in independent profile still takes precedence (the user's explicit
  choice, with its own quorum).
- **Wallet signing:** the wallet's RPC, WalletConnect `rpcMap` and `wallet_addEthereumChain` RPCs are untouched.
- **Credit page** (`site/credit/`): it keeps its own `credit-config.json` quorum (at least 2 origins, quorum at least
  2). An own-authority credit release needs two own endpoints in that file; no single-endpoint shortcut exists.
