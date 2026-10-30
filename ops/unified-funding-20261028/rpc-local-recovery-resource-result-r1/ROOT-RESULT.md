# Local recovery feasibility observation

Single local read3b26c4ba7023434c8a068e4f44b00c5c terminated0/MainPID0. Prepared17input pins unchanged. Installed guestd194657/start148657014 was authenticated and unchanged. Two active guests reserve68249MiB; pending5950MiB/unread0; before/after reservation snapshots agree; observed available minimum30127MiB; actual guestd floor18432MiB. This status read did not allocate or mutate any VM.

The original and frozen r6 image metadata match retained evidence. Images reside locally on encrypted ext4 over NVMe; available filesystem space616052559872B exceeds300GB floor. Permissions/topology do not prove safe exclusive attachment. No disk content was read and no mount, client or repair was launched.

At the proposed conservative27648MiB operational admission floor, none of the read's conditional local-client cases fit after pending allocations/tooling. The read also conservatively subtracts640MiB for Nan, now terminal; removing that obsolete reserve still does not make any case fit. Other workload growth remains unclassified. Actual guestd18432MiB floor is a separate value; this record does not silently substitute it for the planned operational floor or authorize reducing reserves.

Nan allocator trial failed under4GiB before the human15-minute cutoff. Neither that configuration nor an unchanged long network-backed recovery is to be repeated. A materially different placement/memory design requires explicit technical review with these actual constraints. No new native trial is admitted.
