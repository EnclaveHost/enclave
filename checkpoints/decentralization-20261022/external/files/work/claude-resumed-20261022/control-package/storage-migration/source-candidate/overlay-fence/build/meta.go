package build

// ROLLOUT BUILD METADATA (+ enclave-small.patch 503e6fc9: the live v0.6.0-enclave2 sizing and app-API timeouts)
// (work/indexd-replica-rollout): upstream generates this file with 'go generate' from git; the
// frozen indexd-fence tree has no .git, so it is written deterministically: stock v0.6.0 commit plus the fencing patch.
const (
	commit    = "ddaf24b999800651af5aee7575a68ae543506fd9+indexd-fence.patch.3353bbf722f48580+enclave-small.patch.503e6fc9baf8bfc8"
	version   = "v0.6.0-fence.1-enclave"
	buildTime = 1790669669
)
