# Loader cache-advice candidate

Opt-in measured marker `/rt/shield-model-drop-cache.enabled` advises the already copied source range DONTNEED after each4MiB private copy and hash update. The whole private model copy, pinned digest, size check, source/destination paths, no-overwrite behavior and chmod-after-verification are retained. No app configuration enables it. Default still uses the old copy path. Advice failure is non-fatal and counted; integrity verification remains mandatory.

Nine Go tests pass with no skips, including corrupt/truncated/wrong-pin rejection, chunk ordering and source-only advice, default behavior, advice failures and real syscall behavior on test-owned files/pipes. Test service peak163.4MiB, zero swap. This does not establish actual page reclamation on the production virtio block device. `advised_bytes` is not RAM saved. No production binary/marker is installed.

Reproduce in this directory on Linux amd64: `GO111MODULE=off CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOMAXPROCS=1 go test -count=1 -timeout 120s -v .`. Use the shared queue and bounded cgroup. The helper is amd64-specific, matching the production guest build.

Next: isolated loader-only SNP A/B boots with no network/GPU/wallet, readonly public model, pinned existing kernel/firmware, timestamped guest cache/private-memory and host cgroup high-water measurements. Full inference performance/security qualification still follows before any production rollout.
