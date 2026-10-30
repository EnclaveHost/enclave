# Production loader rollout, October 28

The user explicitly authorized deployment to the existing EyesOff instance. The loader-only candidate changes exactly template/shieldmodel and adds the measured source-cache-advice marker. Packed24 and experimental firmware are excluded. CPU/GPU shares, RAM allocation, app version/config, controller, administrator controls and admission floors remain unchanged.

Original release: 5cab66e478a78adf69c5bb6f058117fcd91cddfb72ca3f6c5d47c109cc47ba17.
New release: af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae.
App bundle: 5bac47ac3b99d9999314ac3f5ee7c2749defdde98b2a52212302d05da13d58eb.
Prediction: 66ba9f551f25158faf428b82a93dc073751b194c7b76b1e83ffad1ce9c0eae8d521b080d3a39603b1ab2272c67a69217.

Both independent public-bundle reconstruction and the live catalog-derived relay prediction agree. The relay retained every prior release entry, including the rollback release; its two known-answer tests passed. New release files were independently verified on both machines.

## Reviewed tooling

Claude prepared the release composer (30 offline tests) and manager switch helper. Root corrected actual-system integration: absent EnvironmentFiles property, real normal-startup adoption summaries versus adopt-check output, no dependency on historical adoption logs, drop-in ordering, preservation of the actively written pad inode, and a systemd pre-exec argument race. Final switch suite: 43 passing tests, including watchdog release, parent death, rollback, environment drift and the pre-exec race. Tests do not replace actual runtime checks.

The first switch refused before mutation because the live pad mtime changed. The second installed then automatically rolled back because it compared the new process argv before exec completed. Its rollback checker had the same race; subsequent direct inspection confirmed exact original argv, old guest unchanged, original manager adoption, owned drop-in removed and controller resumed. The corrected third switch succeeded, changing only two argv values. Manager PID110268 adopted existing guest gdb55af9c1, with its QEMU44174 unchanged. The controller QEMU3967858 resumed in all cases. Normal dashboard Restart then began replacement guest gdc03538eb. Final runtime evidence is recorded separately.

The pad is retained by hardlink as a live inode, NOT a consistent content snapshot or permission to reuse one-time pad material. A new guest receives a new pad. Private recovery files remain outside source control. No guest secrets, pairing keys, wallet/session keys or key material were exported.

Watchdog limits are best-effort scheduling deadlines. Killing the whole helper cgroup could also kill its watchdog; this is not a guarantee against a host crash. Root supervised the switch and directly checked control/guest identities. Preserve the original release and admission entries until rollback is no longer needed.

## Rollback procedure

Use a fresh current-process plan; do not rerun the one-time forward helper with stale PIDs or records. Preserve current guest records and pad inode privately. Ensure the old release remains independently verified and admitted. First add the candidate runtime identity to adoption mappings if the current manager would otherwise refuse the candidate guest. Run the exact original-argv manager with -adopt-check against ALL current records. Only after all pass, briefly hold the correctly identified controller with a separate bounded resume watchdog, remove only the owned zzzzzzzz-loader-cache-20261028.conf override, daemon-reload and restart guestd; require original argv, unchanged environment/floors, successful current-guest adoption and unchanged QEMU identities, then resume controller. Restart only EyesOff through its normal signed dashboard operation to launch original5cab. Never restore/reuse burned pad material. Validate fresh quote, model and TLS/inference after rollback. If adoption cannot be proven, stop and diagnose; do not permit guestd's sweep to erase the guest.

Normal RPC VM remains off. This rollout does not establish RPC replacement completion. No new financial transfer or session spend was performed by these scripts.

Concrete rollback argv is retained in rollback-argv-with-candidate-adoption.json: original settings plus only af50d526 runtime-adoption mapping. A bounded real -adopt-check against the running gdc03538eb passed (adopt-rollback.out). This is an adoption prerequisite check, not an exercised app rollback. Never use the forward helper’s old guest/PID constants for a later rollback.
