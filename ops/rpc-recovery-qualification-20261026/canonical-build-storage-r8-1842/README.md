# Canonical verifier build storage correction: actual preliminary test results

The new r8 wrapper keeps build scratch, temporary files, logs and final binaries inside the guarded /vm run. It requires all265 recovery parts independently confirmed and preserves the disk and memory reservations. Rust verifier and existing disk guard bytes are unchanged.

Actual tests passed:10 disk-guard tests,6 mount identity tests,11 new gate/capture/storage-placement tests and4 private-namespace tests. No warnings, skipped tests or stderr failure markers. The unit job measured79MiB peak RSS and24373MiB minimum available host memory. The short namespace job finished between memory samples; its zero reported peak is not a measured zero-memory claim. Both used the existing256MiB lane retaining the full4096MiB concurrent-work reservation and16GiB host floor.

Namespace tests bound only temporary test directories inside a private namespace, verified read-only rejection and private propagation, and exited. No production build, production part reads, USB writes, downloads or RPC VM startup occurred. Source review is still pending; these tests alone do not qualify production activation. The canonical Rust helper remains uncompiled, and production state integrity and chain anchoring remain unverified.
