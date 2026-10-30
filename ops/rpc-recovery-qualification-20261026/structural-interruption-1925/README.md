# Interrupted structural validation

Scan1917 started13:33:47UTC and the shared guard terminated it at13:55:04UTC because host MemAvailable fell to15697MiB, below16384MiB. Peak measured process-tree RSS was1543MiB; this was a host-wide floor event, not exceeding the job's4GiB cap. No structured database report, session receipt or final job receipt was produced. Outcome: INTERRUPTED/INCONCLUSIVE, never CLEAN or database corruption evidence. The empty validator log provides no measurable completion percentage or reliable ETA.

Post-stop inspection found the validator/runtime PIDs absent and no own mount remaining. The265-part production view recheck passed (identities/records; not another full content hash). Keep the failed run intact; any retry must use a new run directory and unchanged safety limits after memory coordination.

A subsequent direct user instruction in the RAID chat authorized temporarily stopping metal0 to free RAM. Its owner handles that shutdown; this task does not duplicate it. This evidence archive does not authorize any media reset or deletion. Recovery acceptance is separate from later production synchronization/cutover: RAID preservation decisions must not wait for unrelated deployment work.
