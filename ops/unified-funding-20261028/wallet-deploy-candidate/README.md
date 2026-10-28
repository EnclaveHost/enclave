# Additive funding deployment wallet review

Default-off local review server. Run `node server.mjs --check` offline; `--dry-run` performs read-only two-provider checks. Run `node root-test.mjs` through the shared memory queue. The four reviewed deployment artifacts must exist in adjacent packages. No production signing occurred. See ROOT-REVIEW.md and retained failures.

`--serve` without an authorization artifact is review-only. Keep the random capability URL private. Never enable until the exact bundle, source hashes, nonce, limits and current prerequisites have been reviewed. No session key export, grant upgrade, migration, app ownership transfer or USDC approval is performed.
