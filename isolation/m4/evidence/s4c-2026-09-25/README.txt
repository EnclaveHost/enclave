4c: the node image with the next supervisor (enclave-63's rollout, enclave-5d's code, enclave-d1's review). NOT RUN yet.

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
