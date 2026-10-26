# Guarded validation build preparation, 2026-10-26 22:04 UTC

The NVMe build guard passed all10 actual tests, including bounded dummy writers, space refusal, quota threshold, timeout and cancellation. The exact-Reth validation build is queued behind the live read-only original-database probe. No successful compilation or state-validation result is claimed.

The guard uses a private new scratch directory on the pinned T710 filesystem, admits only with64GiB free, stops its own build group below40GiB free or above20GiB scratch allocation, and keeps scratch for review. The shared4096MiB memory guard and16GiB host floor remain in force. These disk thresholds are sampled stop conditions, not filesystem quotas. It never changes production disks or stops other processes.

Observed recovery-probe interval: about133.7MiB through fuse2fs in698.7seconds. This is not a full-scan ETA, but it makes the current HDD/FUSE path unattractive for fast recovery. The probe remains bounded; no full-run acceptance or recovery claim.

A source review is separately checking whether the helper can reuse cached trie hashes without independently authenticating all recovered hashed values. The helper must not be used as complete integrity evidence until that review and meaningful positive/negative fixtures pass. Canonical-chain anchoring remains separate and required.
