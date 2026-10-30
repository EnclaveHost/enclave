# Recovery checkpoint: 68 GiB verified, composite checker admission corrected

Parts 0..16 (68 GiB) were independently verified in confirmed sessions; the latest source/destination verification for 9..16 returned zero, original metadata unchanged, full cleanup, no leftovers. The qualified driver continues subsequent batches automatically, with fresh full remaining space reservations and separate verification. This establishes byte preservation only, not database validity or RPC readiness.

The r4 checker fixture job refused at admission before running any tests. Its broad full-command-line process search could match the launcher's earlier comparison command, which contained the checker filename. The historical matched PID was not logged; this is a supported explanation, not a captured PID proof. The new r5 guard matches actual script invocations and logs refusal evidence. The checker runtime is byte-identical to r4. This source checkpoint makes no fixture PASS claim; separately archived actual receipts are authoritative. Production remains disabled.

Preserve the original, paused archive/checkpoint, existing apps and administrator controls. No writes to the USB array or RPC VM startup were authorized by this checkpoint.
