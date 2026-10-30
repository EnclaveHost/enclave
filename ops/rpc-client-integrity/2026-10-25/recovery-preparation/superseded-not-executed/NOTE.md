# SUPERSEDED, NOT EXECUTED: do not run

`control-rerun.sh` (sha256 `1e22e897f152a418907759a7f9290fef5fada6ec241702dc8bff3f7309ddf940`, kept byte-unchanged as
history, mode 0644) was a candidate negative-control rerun. It was **never executed**.

**It is wrong:**
- **Failure count:** it expects **four** control failures. The source requires **five**:
  `forged_header_cannot_vouch_for_forged_receipts` also fails when the receipts check is disabled, because its header
  fetch sits inside the disabled branch.
- **Approach:** it relied on a seeded copy of the target directory instead of forcing a provider rebuild.

**Superseded by** `../../m7-control-recovery/test-offline-r3.sh`, which root ran foreground (exec54162) to a full PASS,
rc 0.
