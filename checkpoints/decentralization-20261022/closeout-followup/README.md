# Latest closeout work checkpoint

This package supplements `closeout-drafts` with newly authored or changed sources at the capture time in `MANIFEST.json`. Unchanged files are referenced there rather than duplicated. It preserves work in progress and is not a deployment approval.

- **Controller command bounds:** production/fixture candidates, derivation and validation code, and the backup-runner foreground-timeout correction. Validation was still running at capture; this package does not claim the final integration has passed.
- **PostgreSQL process reaping:** a proposed `--init` service change, exact rollback unit, and read-only probe. Production has not been changed by this checkpoint.
- **Measured control-image composition:** source overlays, build tools, patches, and the worker's completed report. Repeated bundle builds and focused checks are recorded. The report also records failing supervisor image-closure checks (two omitted owner-nomination modules) and stale custody output. The image has not been built, measured, or activated. These failures remain open.

The earlier verified storage-controller fix and lease-cost correction remain in their separate checkpoint packages. Credentials, private runtime configuration, production backups, generated images, and raw agent conversations are excluded. Preserve future source changes in subsequent commits as development continues.
