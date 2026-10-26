# consumer-package-inputs-stage

A package-mode root qualification of the real consumer release, with a corrected dependency harness. PREPARED; Claude ran no build, test or queue job.

- `patches/root-final-consumer.orig.sh` is the frozen job, byte-identical: `final-consumer-composition-stage/jobs/root-final-consumer.sh` 3692b655.
- `patches/root-final-consumer.package-inputs.patch` is the only change.
  - It mounts the real `node_modules`, `network/node_modules` and `relay/node_modules` as **read-only bind mounts** onto real directories inside each exported side (private mount namespace) instead of `ln -s`.
  - It adds a runtime-bundle in-tree input check.
  - It changes the verdict to require actual success: the runtime pin e12c on both sides; the pristine host-packages, mcp and platform-api checks PASS; final checks PASS, or are genuinely stale and regenerated + `--check` PASS, listed under `reviewRequired`.
  - Outputs go to `runs/` here.
- `patches/root-final-consumer.package-inputs.sh` is the patched result (4ad09d4d).
- `jobs/root-package-inputs.sh` is the root entrypoint. It verifies the frozen stage and job, applies the patch privately, requires the derivative hash, checks for a private mount namespace, and runs `package`.

The full analysis is in `logs/claude-consumer-package-inputs.md`.
