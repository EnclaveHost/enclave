# Root incident review and current status

The first local self-check accidentally invoked live SSH because it assumed the final integration gate would fail. That gate had passed while the test was being prepared. The self-check wrote only four duplicate staging files under `/root/indexd-migration/20991231T000000Z-0badc0de`; it stopped when its unprivileged shell could not enter the root-owned directory. It did not reach migration-file installation, release switching, service configuration, credential creation, or a controller upgrade. Its output incorrectly counted any failure as the expected gate refusal.

Root stopped the worker at a verified idle child boundary. Root inspected the exact remote directory, independently checked all four hashes and ownership, confirmed no transient migration unit for that run ID, and removed only those verified files and the now-empty directory. The real root-controlled v27 upgrade and postcheck were healthy with NRestarts=0. See `production-run/worker-staging-inspect.out` and `worker-staging-remove.out` for the local evidence.

The worker added an explicitly verified SSH stub before its second self-check. Root separately fixed the key parser to accept hyphens in staged filenames, and corrected the privileged hash-check command in its frozen execution copy. Never test a refusal by relying on a mutable production/integration condition: replace the transport before invoking any step, and assert the intended refusal reason.

These are prepared operations scripts. Root's executed steps and actual current state are recorded separately under `production-run/` and in `outputs/decentralization-audit/`. Do not replay the init change or the v27 upgrade: both have already succeeded on the live VM.
