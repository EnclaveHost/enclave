# Recovery read route correction

After the expired-unused SDK was deployed, the actual browser read-only check failed to fetch from its hardcoded first public RPC. The normal funding context already reads sessions config and uses its configured RPC (currently https://api.enclave.host/rpc/base). This two-line change does the same in recovery, with the old public fallback when config is unavailable. No chain proof, SDK, signing, grant, budget or admin behavior changes; owner controls remain independent.

Copied additive builder changes only the exact page content hash pin. All other input hashes and config unchanged. Composite preserves all 1126 original files; five additions, 1131 total. Source old trees retained; exact two-root CAS at each edge. Live read-only result and per-edge HTTPS hashes are recorded separately. Operational helpers are single-use evidence, never automatic replay instructions.
