# Unfinished r2 production-canary scaffold

Claude reached its weekly limit while adapting baseline0152520 to a new r2 committee in the original production vault. This is saved work in progress, **not an executable or validated rollout kit**. No production, wallet, hardware, custody or secret action was performed by this scaffold.

The new plan.mjs describes r2 genesis and the proposed matrix; copied consumers still import original committee constants and require reconciliation. Tests have NOT been run for this scaffold. In particular assert.mjs still expects COMMITTEE_4774 while the new plan exports OLD_COMMITTEE_4774. Do not run its CLI against production or read private keys through it.

The previously tested baseline driver, the corrected r2 source/build/startup evidence, and the proof-app source remain independently preserved. Actual rollout is gated on control recovery, operator funding, accepted host ownership, verified public ingress, funded and signed genesis, catalog publication, then a full dedicated-canary lifecycle matrix. Existing committee4774 and policy4e62 must remain unchanged.

Root's proposed resource exception is at most two new VMs (3072MiB custodian plus1024MiB recipient, plus measured overhead) while maintaining16GiB available host RAM and preserving all original VMs. No hardware launch is authorized by this file.
