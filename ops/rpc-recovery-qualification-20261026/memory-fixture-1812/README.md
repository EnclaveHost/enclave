# Synthetic memory fixture source — not executed or qualified

This preserves prepared r1 source and the author report. No tests, scope changes, mounts or workload runs have occurred. Independent source review 1811 is pending. Normal shared-queue admission is held until the KVM chat completes or releases its pending native image build and isolated test window.

The proposal measures an 8 GiB sparse synthetic file through a read-only FUSE/NBD mapping, under a 768 MiB queue scope with MemoryHigh. It does not read original or preserved database bytes. Source review and later synthetic results must not be called production database integrity or RPC readiness. The 16 GiB host floor, full recovery disk reservations and existing 8 GiB native reservation remain mandatory.
