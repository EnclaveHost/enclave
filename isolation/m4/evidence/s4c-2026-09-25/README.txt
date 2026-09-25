4c: the node image with the next supervisor (enclave-63's rollout, enclave-5d's code, enclave-d1's review). 4c LIVE since 2026-09-25 22:16Z (run-4c/); 4c-c-a LIVE, 4c-c-b run 1 ROLLED BACK by its own check (run-4cc/), cc-v2 prepared.

IMAGE v2 (build-v2/): metal/dist-iso-b3109929, built from b3109929 = b18f8989 (5d's candidate: the floor merge's supervisor
half, d1's row-6 cert check 811db2b6+059fdec5, the launch-spec guard; the 8 overlay files byte-identical to b18f8989's) +
metal/build-image.mjs's -ffile-prefix-map. S2's exact command (supervisor ...@2f8e84f8, wasm ...@46024085, min-tcb
fe90824f, AmdSev OVMF 142589cc). PREDICTION (4 vCPU) 8ab7a1590fad444c53e8bec7a08ea44452e78ed68a30de2283d599879b69feb84cb7fd0bc1cc3aa903514ab7443c30bf
= the hand sev-snp-measure. REPRODUCED from THREE checkout paths: enclave-63's /home/steven/Projects/enclave-build-b3109929
and /home/steven/enclave-bench/s4c-20260925/another/checkout/path/src (byte-identical dists), and enclave-d1's own path
(initramfs 0036b029..., the same prediction).

IMAGE v1 (build/, SUPERSEDED, never allowlisted): dist-iso-b18f8989, e6b02e41...: its measurement depended on the CHECKOUT
PATH (enclave-d1): build-image.mjs compiled wasm/ggml-shielded from absolute paths, and a __FILE__ landed in
libggml-shielded.so's .rodata; the two v1 builds agreed only because both ran from the same directory. The live S2 image
(10622d98) has the same property: it is reproducible ONLY from /home/steven/Projects/enclave-build-c42612c0.

DESIGN DEPENDENCY (enclave-d1): supervisor.js releases EVERY held lease on SIGTERM/SIGINT (releaseClaimsOnShutdown). A node
restart is safe only because enclave-metal.mjs SIGTERMs QEMU, a hard stop with no ACPI shutdown, so the in-guest supervisor
never sees the signal (S2's journal: 3 adopted, 0 released). A future graceful guest shutdown would release all the canaries'
leases on every node restart; 4c-b's journal gate counts any release line.

COMPATIBILITY (read-only): b18f8989's supervisor (= b3109929's overlay) resumes the 3 canaries against the live 4d guestd
(GUEST_POOL_SELFTEST viaHealth: verdict null for each, the held guest found, the floor verdict {16384, true}).

ROLLOUT (scripts/, v2 = scripts-v2.sha256): s4c-run.sh a (4c-a: the allowlist + one api-relay restart; the predictor KAT and
accept.sh again), then s4c-run.sh b (4c-b: dist + the node CVM restart; the attested measurement + overlay, 3 adopted
resumes and 0 releases, availability with the floor verdict), then observe.sh 4c. Rollback: s4cb-rollback.sh, then
s4ca-rollback.sh. Both detached-only, one-time token. Waits for d1's PASS of the image and Codex's go.

4c RUN (run-4c/, 2026-09-25): 4c-a (s4ca-apply-20260925T221404Z, rc 0: the allowlist gains 8ab7a159, one api-relay
restart, the KAT and ADMIT=79c5ecf2 accept.sh pass), then 4c-b (s4cb-apply-20260925T221614Z, rc 0: dist-iso-b3109929, the
node attests 8ab7a159 / overlay b3109929, 3 adopted resumes and 0 releases), then observe.sh 4c GATE PASSED (6 rounds over
615 s, 22:18-22:28Z). The node journal excerpt keeps only the launch, isolation-tier, adoption and release lines.

4c-c RUN 1 (run-4cc/): 4c-c-a (s4cca-apply-20260925T224039Z, rc 0: the allowlist gains 02f6e313, kept). 4c-c-b
(s4ccb-apply-20260925T224240Z, rc 20 = its own check failed and the automatic rollback PASSED): the node attested
02f6e313 / overlay f6cbd75a and adopted 3 with 0 releases, but gsup logged "attested release off". ROOT CAUSE: the HOST
launcher metal/enclave-metal.mjs (0181bce3, run from ~/enclave-prod/iso-03be27d6) built fw_cfg's isolation object as
{managerUrl, dataAddr, pairingKey} and never forwarded isolation.release; 87e881a2 changed only the guest half (gsup).
Rolled back 22:47:01Z to 8ab7a159 / b3109929, no release key; 395bed3e missed probes for ~1 min during the reboot.

cc-v2 (scripts/, scripts-cc-v2.sha256; diffs diff-cc-v2-*.diff): enclave-5d's host fix 578be084 (on 0181bce3; launcher
blob 4620da5d...; isoRuntimeOf forwards release:true for a boolean true only and REFUSES any non-boolean; the
launcher logs its own "attested release OPTED IN" line; test/metal-launcher-isolation.test.mjs drives the real launcher
with a fake QEMU), APPROVED by enclave-d1. Landing (enclave-d1's plan): s4ccl-worktree.sh makes the inert detached
worktree ~/enclave-prod/metal-578be084; 4c-c-b adds the user drop-in enclave-metal-iso.service.d/10-launcher.conf
(WorkingDirectory only, ExecStart unchanged) in the SAME node restart; iso-03be27d6 is untouched (guestd's
-legacy-isolation reads its isolation/). New checks (enclave-d1's a/b/c): the edited config read with node
(release === true, dist f6cbd75a) before the restart; the node's /proc cwd, argv and launcher sha after it; BOTH opt-in
lines, each anchored to its own prefix ([enclave-metal] then [gsup]). The rollback removes the drop-in only if it is
exactly 4c-c-b's. The launcher is unmeasured host code, so 02f6e313 and the 4c-c-a allowlist stand.
