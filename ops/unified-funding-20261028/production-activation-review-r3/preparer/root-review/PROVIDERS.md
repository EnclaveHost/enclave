# Observation endpoints (read-only)

The independent observation collector allows exact PublicNode, Blast and https://mainnet.base.org URLs, chooses two distinct hosts and requires Base chain 8453 plus a common canonical block. Base documents mainnet.base.org for reads at https://docs.base.org/get-started/connect-to-base (verified October 28, 2026); the recovery peer also previously obtained a matching three-provider observation including this endpoint. Public endpoints are not assumed healthy or independent state reconstruction. Read method allowlist, response identity/size/time bounds and pacing apply to all.

The signed deployment helper, its source hashes, old two-provider allowlist, completed journal and grants are unchanged. This collector cannot send transactions. PublicNode429 is preserved; no retry loop or alternate identity for that endpoint. New fee observations choose Base+Blast directly and require agreement; no result is an approval.
