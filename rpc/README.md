# Alchemy RPC gateway

`gateway.mjs` is a dependency-free loopback HTTP service. Publish only
`/rpc/base`, `/rpc/base-sepolia`, and (when enabled) `/rpc/ethereum` through
Enclave's existing TLS front. `/health` is loopback-only at the TLS layer.

The JSON config contains `upstreams: { base: [ALCHEMY_URL, PUBLIC_URL, ...] }`.
Never commit that file. The service unit uses systemd LoadCredential to read
`/etc/enclave-rpc/config.json` (root, mode 0600); it binds port 8190.

Every cache miss starts with the first upstream. Transient errors fall back in
order; deterministic errors are returned without public-provider retries.
Successful reads share a bounded 16 MiB / 4096-entry cache and concurrent
identical reads share one request. Current state expires after one second;
chain IDs after one hour. Pending state, nonce reads, gas estimation, errors,
null results and signed transaction submissions are never cached. Ambiguous
transaction submissions are never automatically retried. Requests and replies
are size-limited; upstream concurrency and request rate are bounded. No
credential-bearing URL is logged or returned to clients.

Clients use `https://api.enclave.host/rpc/base`; services on the gateway host
use `http://127.0.0.1:8190/rpc/base`. Set BASE_RPC, SESSIONS_RPC and
SESSIONS_PUBLIC_RPC accordingly. Session clients receive the public URL in
`/v1/sessions/config`. Public client pools remain emergency fallbacks.

Security readers that require independent provider agreement must retain
independent witnesses. Do not point multiple quorum slots at this gateway:
that would count one provider repeatedly and remove the security check.

Test with `node --test test/rpc-gateway.test.mjs`. Verify live primary/fallback
counts and cache hits via loopback `/health`, without reading credentials.
Rollback: restore the previous TLS/site root and remove the dedicated
`zz-alchemy-rpc.conf` service overrides, daemon-reload and restart those services.
