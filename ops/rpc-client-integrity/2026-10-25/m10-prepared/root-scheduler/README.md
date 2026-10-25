Root launched this exact scheduler from finality-stage/m10-bootstrap/root-run.py.
These are archival copies, not a runnable standalone installation. The script derives paths from its original stage location.
At launch it was WAITING for the active M7 full production build to finish successfully. It stopped with blocked-by-m7-build-result when that build exited 143 after a cgroup OOM at 19:57. M10 native tests have NOT run. A new scheduler must wait for the resumed build receipt; the original failed receipt and scheduler logs must be retained.
It then verifies frozen job inputs and uses the existing 1792 MiB queue, one compiler and one linker thread, private target/cache,
offline networking, and the unchanged 16 GiB host floor. Only not-started code 98 is retried; test/build failures stop.
Current status belongs to the original stage logs/root-run-status.json. Do not change frozen job inputs while it is waiting/running.
