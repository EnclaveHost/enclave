# Proposed recovery for metal0's expired app leases

**Prepared, not executed. Approval required before spending or changing wallet delegation.**

The image-generator and EyesOff VMs are still running and both passed local application health checks with normal TLS certificate verification at 8:36 p.m. Arizona. Their public routes failed after the last recorded leases expired. At 8:35 p.m., three agreeing Base RPCs showed no replacement claimant and sufficient funds in both app gas reserves.

The proposed sequence preserves both VMs:

1. Stop the exhausted keeper cleanly and stop only metal0's control service. Wait the full six-minute signature-expiry window, checking that both units remain stopped.
2. Re-claim each existing deployment exactly once on the original host, paid by its existing app reserve. Cap: **0.000006 ETH per app**, **0.000012 ETH total**. The observed quote was about 0.000004562 ETH per app; fresh fees and eligibility remain mandatory.
3. Once both claims are independently verified, wait out their signed deadlines and require the existing funding procedure's full lease margin. Then fund the operator using the previously proposed temporary delegation clear-and-restore: **0.000005 ETH transferred**, plus **at most 0.000002 ETH in fees** from the existing sponsor wallet.
4. Verify restoration of the exact executor, then recover normal registration, adoption of the original VMs and ordinary app-funded renewals. Check the live enclave listing and both public app endpoints. Any separate control-image activation still requires its existing rollback and health gates.

**Combined spending ceiling: 0.000019 ETH.** No administrator contract privileges change, and no new contract or deployment is created. No MetaMask signature is needed for these operations; the available operational keys would be used only after approval.

Each claim gets a durable record before submission. An uncertain outcome blocks further signing rather than retrying. Original keeper records and limits remain unchanged. This proposal expires at **9:30 p.m. Arizona on October 23 (04:30 UTC October 24)**. A short or failed claim does not authorize weakening the funding safeguards.

A delegation restoration failure would leave lease signing stopped until the exact original executor is restored and verified. An app claimed elsewhere or an owner/VM change aborts this path. The procedure may therefore stop with recovery incomplete; it never reports restored service based solely on a successful transaction.

Local verification: 12 controller/body/stop-timestamp tests passed. Nine mutation controls detected removed owner, original-expiry, guest-record, charge-cap, receipt, approval and quiescence checks. An initial receipt test was corrected because another guard masked the missing receipt check. These are source tests, not proof of production recovery. Production changes remain unexecuted.


Update at 8:56 p.m. Arizona: the exhausted keeper exited normally and systemd removed its transient unit. The revised preflight handles that specific state only when all eight completed renewals per app are present and the latest verified lease expiry plus six minutes has passed. The control service still must stop for the full six minutes. An absent control never qualifies for the keeper exception. Spending limits, approval requirements and VM preservation are unchanged.
