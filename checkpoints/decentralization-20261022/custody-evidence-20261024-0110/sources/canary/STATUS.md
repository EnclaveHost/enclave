# Unfinished r2 production-canary scaffold

Claude reached its weekly limit while adapting baseline0152520 to a new r2 committee in the original production vault. This is saved work in progress, **not an executable or validated rollout kit**. No production, wallet, hardware, custody or secret action was performed by this scaffold.

The new plan.mjs describes r2 genesis and the proposed matrix. Root has reconciled committee selection, evidence evaluators and the HMAC proof path, with offline tests described below. Genesis verification and several hardware/CLI handlers remain unfinished. Do not run its CLI against production or read private keys through it.

The previously tested baseline driver, the corrected r2 source/build/startup evidence, and the proof-app source remain independently preserved. Actual rollout is gated on control recovery, operator funding, accepted host ownership, verified public ingress, funded and signed genesis, catalog publication, then a full dedicated-canary lifecycle matrix. Existing committee4774 and policy4e62 must remain unchanged.

Root's proposed resource exception is at most two new VMs (3072MiB custodian plus1024MiB recipient, plus measured overhead) while maintaining16GiB available host RAM and preserving all original VMs. No hardware launch is authorized by this file.

Root continuation October24: the proof module, policy preparation and evidence evaluators are now reconciled with the new committee. The CLI's dependent selectors and proof command were wired, but **the CLI is still incomplete and must not execute against production**. Genesis/host enrollment receipt verification, launch provenance, outage recording, committee-migration refusal and full CLI tests remain unfinished. Tests below are offline module tests, not production outcomes.

The original import mismatch is fixed. New preparation checks bind the freshly read committee key to the planned committee, and only X.old.create may use the old committee. The proof command issues a fresh random challenge, checks exact names and HMACs, rejects the previous revision, and returns no peer-controlled response data. Empty searches, missing identity pins, incomplete protected-policy snapshots and unobserved rollback claims now fail.

Validation at this stage: 18 targeted offline tests passed; 11 deliberate broken evidence checks were detected. The first full suite found one missing copied proposal file (not a production defect), which was restored from the baseline Git object 01525201. The intentionally failing rollback-protection property remains a TODO demonstrating a known design limitation, not a passing security claim. No production keys, transactions or custody lifecycle actions were used.

Final offline validation for this continuation: root-full-2.out reports **43 passed, zero unexpected failures, one known-limitation TODO**. root-evidence-mutants-2.out reports **12/12 mutants killed**. The full run imports the CLI without invoking it; it does not exercise the unfinished production command sequence. Existing production custody and protected tenant VMs were not changed.
