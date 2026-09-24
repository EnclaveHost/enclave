# TPU campaign: the last queue, as it stood when it was stopped (2026-09-23 17:26)

The queue scripts, condition files, logs and the Play Protect dialog watcher of the final smp2 checks, copied from
~/gguf-e2b/tpu so the record survives outside the repo's results. Stopped because TPU acceleration is closed as a product
goal (TPU.md, Status: 2.4-2.6 tok/s measured against the 15 tok/s threshold).

- q3/q4: df1, df1b, dp1 (results/*). q3 hung on df-02 (the Android 17 reinstall-relaunch race, fixed in 66975c2f) and was
  replaced by q4. q4 was stopped during dp1 (dp-09 at the cool gate; NOTES in results/dp1).
- q5 (dfc: defaults with the bank left to the app) and q6 (ab1: smp1 vs smp2 interleaved, same settings) were queued and
  never ran.
- pp-watch.sh answered two device dialogs a harness reinstall raised: Play Protect "Send app for a security check?" with
  "Don't send" (nothing uploaded, no setting changed) and the 16 KB ELF-alignment notice for a debuggable build with "OK".
  Every tap is in pp-watch.log.
