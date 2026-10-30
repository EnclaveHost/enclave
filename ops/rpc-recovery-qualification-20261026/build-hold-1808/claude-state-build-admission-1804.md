# ⛔ DO NOT RUN — REJECTED, UNEXECUTED PROPOSAL; SUPERSEDED BY ROOT'S RESOURCE REVIEW ⛔
**Status: UNQUALIFIED and archived only.**
- **Root's decision:** after reviewing 1804, root rejected activation. Compilation is **deferred until preservation completes**.
- **Do not activate, extend or build on this proposal.** Any future build needs a new, separately reviewed design that meets the RAID owner's requirements below.
- **Never run:** `jobs/root-state-build-admission-1804.py` (sha256 `81055c03b397abe79b768c62b8f16db548fec68cdab6b9587d27588de0cf3c2a`). It is preserved **unchanged** as a rejected proposal; no admission record exists in `logs/`.
- **Unchanged and not run:** `base-state-readonly-stage/r7` (SUMS `7d4ccc8f…`, `sha256sum -c` OK).

## Why it was rejected: RAID owner requirements it does NOT meet
1. **Ongoing full-remaining reservation protection.** The admission checked free space against the full remaining multipart allocation **once, at admission**. Nothing enforces that reservation **during** the build.
2. **≤ 1 GiB TOTAL root output**, including logs, temp files and binaries. Nothing enforces any bound on root-filesystem writes.
3. **A controlled TMPDIR.** The r7 build runs `env -i` with no TMPDIR, so rustc/linker temp files go to the default `/tmp`. That is uncontrolled and unaccounted.
4. **Terminal accounting.** There is no end-of-run accounting of all bytes written on each filesystem (scratch, outputs, temp) with a verdict against the limits.

## Corrections to statements in the earlier version of this report (they were wrong or misleading)
**C1. "The guard's 40 GiB `/vm` floor contains overshoot and protects the multipart allocation" was WRONG.**
- **What the floor does:** `disk_guard.py` stops the build only when `/vm` free space falls below an **absolute 40 GiB**.
- **Why that does not protect the reservation:** the multipart reservation is about **622 GB of still-unfilled, unallocated part space** (622,770,257,920 B of not-yet-committed vm parts). The floor knows nothing about it.
- **The failure case:** with roughly 706 GB free at start, the build could consume about 666 GB before the floor trips. Everything between the 24 GiB reserve and that point **eats the unfilled preservation reservation** without any stop.
- **What would actually protect it:** only a live guard whose threshold is `remaining multipart bytes + floor` (recomputed or fixed at admission). The 20 GiB scratch cap, sampled every 15 s with unbounded overshoot, is not a substitute.

**C2. "2 GiB final-copy allowance" was NOT an enforced bound.** It was only an admission-time arithmetic term. Nothing measures or limits what `build-inner.sh` writes to `r7/runs/build-*` on the root filesystem: binaries, `build.log`, `Cargo.lock.resolved`, toolchain and lock-check outputs. Temp files in `/tmp` are not counted at all.

**C3. The "`unchanged`" check on the cached crate store and rustup home is a POST-CHECK, not read-only enforcement.**
- **What it does:** `env.sh` `unchanged()` compares a manifest of the cached store and the rustup home **after** the build, and fails the run if they changed.
- **What it does not do:** the build process can still write to them while it runs. Nothing (a read-only bind mount, permissions, a namespace) prevents a mutation; it is only detected afterwards.
- **What it uses:** the build's fresh `CARGO_HOME` links into the cached store by **symlinks**, so writes through those links would reach the real cache.

**C4. "The 4 GiB cushion covers the overshoot" was an unmeasured assumption.** The overshoot is peak write rate × (15 s + the tree walk). Faster writes exceed 4 GiB, and per C1 the floor does not bound the damage to the reservation.

**C5. "Safe" in the earlier text covered process cancellation only.** Cancelling via SIGTERM to `disk_guard.py` ends its own group cleanly (rc 73). That does **not** undo or bound what was already written, and the kept scratch remains allocated against the reservation until root removes it.

## What the archived proposal does (factual, for the record only)
**The sequence:** admission → `execv` of the unchanged r7 `jobs/build.sh`.

**Admission checks:**
- the r7 SUMS and the `build.sh` hash;
- the 4096 MiB cgroup and the 16 GiB memory floor;
- `unshare -Urn` isolation;
- a ONE-TIME capacity snapshot using pinned runner 1773's metadata logic (records + lstat only, no part bytes): remaining + 40 GiB + 24 GiB on vm, and remaining + 40 GiB + 8 GiB + 2 GiB on root.

**Point-in-time only:** per C1–C4, none of its terms is enforced after admission.

## Process notes that remain true
- **Exclusivity:** a 4096 MiB job would hold the exclusive main lane and pause the preservation driver's next job. Do not stop the driver or signal queue groups.
- **No build, test, mount, data read, code change or deletion** was performed for 1804 or for this correction.
