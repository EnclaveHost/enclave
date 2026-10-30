# Retention operational controller qualification

Root1353 passed all15 existing activation guard tests and14 controller integration tests with no skips. Controller bytes remain identical between r2 and r3; r3 fixes a fake guest fixture whose existing foreign run had already completed before the initial check. The failure receipt is preserved.

The controller refuses a running first snapshot, missing marker, active holder or another retention invocation. It starts only through the reviewed activation guard and follows the new systemd invocation. Lost responses, memory-floor breaches, time limits and signals stop only its observed invocation. The physical host floor remains16GiB; live start requires20GiB available and a coordinated exclusive window. Watchdog samples every5seconds. The final stop check still has a small state-check/stop race because frozen activation-r2 has no invocation-scoped stop API; the resource window must prohibit other starters.

These are offline orchestration tests with a controlled fake SSH guest, not successful real retention or production readiness. First snapshot verification remains active; no live start has occurred. The actual activation-r2 source is already recorded in the existing bootstrap stages and is hash-bound here.
