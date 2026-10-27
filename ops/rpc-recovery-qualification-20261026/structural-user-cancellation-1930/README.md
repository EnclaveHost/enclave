# Structural scan 1930: cancelled at the user’s direction

On October 27, 2026, the user chose to discover any recovered-database usability problems later instead of waiting for pre-reset validation. The direct instruction was verified in the RAID investigation chat (turn `01a17ed8-aa63-7620-8a03-4855d90b9bf9`, user item `01a17ed8-aa84-7613-a91f-ad3dd078ed85`).

The qualified stop helper sent SIGTERM to owned runtime 3593721. The job exited 5 with outcome CANCELLED and reason `signal 15`. Its final receipt confirms cleanupComplete, noMountLeft, noProcessLeft, peersUnchanged and snapshotsOk. No hard kill or memory soft stop occurred. The scan did not finish and does not prove database integrity.

All preserved parts and recovery artifacts remain retained. Do not restart structural/state validation or bulk hashing as a prerequisite for the RAID reset. The RAID owner controls its own mounts, reset and restoration. USB writes, downloads and the RPC VM remain paused pending explicit restored-storage authorization. Production RPC acceptance remains separate and unfulfilled.

The job’s FINAL-EVIDENCE-FAILED marker is retained verbatim: this cancellation is not a successful validation. These are small evidence copies only; no database parts were copied or modified for this archive.
