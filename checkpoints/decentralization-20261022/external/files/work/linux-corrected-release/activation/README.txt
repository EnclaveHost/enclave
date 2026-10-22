CORRECTED LINUX LEASE-GAS ACTIVATION (prepared by Claude 5a07654a; ROOT REVIEWS AND EXECUTES; nothing here was run)
Run every script from /home/steven/Documents/Codex/2026-10-18/wo. The c083 activation directory
(work/linux-lease-root-release/activation: plan, admission, private-backup, result) is evidence and is never written.

Image: work/linux-corrected-release/stage/dist-leasegas-51516b778 (measurement 9fcbd925...ca0b4)
Release: work/linux-corrected-release/stage/metal-51516b778 (git archive of scratch commit 51516b778, no node_modules)

ORDER
0. Preconditions root checks: production attached at b8376e15 (rollback measurement), both apps running in the old
   control, the c083 result.json says productionActivated=false and its drop-in 95-app-funded-leases.conf is absent.
1. python3 work/linux-corrected-release/activation/stage.py
   copies release+image to /home/steven/enclave-prod/{metal,dist-leasegas}-51516b778 (inventory-compared, never over
   c083's), checks the staged lease-gas record, writes plan.json. No config/service change.
2. python3 work/linux-corrected-release/activation/prepare-admission.py
   reads the PUBLIC attestation allowlist; measurement.env = every allowed measurement (all retained, c083's included) +
   the corrected one; admission.json. Local files only.
3. python3 work/linux-corrected-release/activation/admit.py      (REMOTE: API relay, ssh as before)
   compare-and-swap of /etc/nan-relay/linux-leasegas-measurements.env against the sha the c083 admission installed
   (848d39be...), fresh remote backup <env>.before-51516b778, the existing drop-in must be byte-identical (21fadc72...)
   and is not rewritten; failure restores. Then recheck the public allowlist lists 9fcbd925... and update admission.json
   stage to 'verified active; old control still connected' (as root did for c083).
   Undo: python3 work/linux-corrected-release/activation/unadmit.py (CAS on both versions).
4. Refresh the funding/lease preflight (outputs/decentralization-audit/linux-conduit-funding-preflight.json, < 6 min old;
   every lease must have > 13 min left: rollback margin + the 300 s adoption window).
5. python3 work/linux-corrected-release/activation/activate.py
   fresh private-backup/, config dist -> the corrected image + leaseGas, drop-in WorkingDirectory -> the corrected
   release, restart; KEEP only if (a) the public attestation shows admittedAtAttach == 9fcbd925... within 120 s AND
   (b) both 0xda09d0f2... and 0x9eb4e600... print "[claim] <id> adopted:" within 300 s (claim lines only, from this
   host's enclave-metal journal). Otherwise it restores the backup, removes its drop-in, restarts, and records why.
6. After keeping: verify app-PAID renewals at their next renewal (read-only): node work/lease-relay-activation/audit-paid-leases.mjs
   (or root's current audit) must show claim/renew paid by the apps' reserves, not this host's key, for both apps.
   Later rollback of a kept activation: python3 work/linux-corrected-release/activation/rollback.py (CAS).

REMAINING PREREQUISITES (not satisfiable from here)
- root's fresh funding/lease preflight immediately before step 5;
- the remote admission (step 3) and both service restarts are root's;
- hardware: only the real SNP launch proves attach and adoption; the measurement was computed with the production
  recipe, which reproduced production's recorded b8376e15 first.
