# Nan n10 terminal result and human startup cap

Invocation 788a6b50252d41b893d1aeb9d95f481b is terminal2/MainPID0; all seven recorded local processes are gone. Source35/runtime16 pins are unchanged. Actual allocator initialization matched all five sources and fourteen lines for the exact Lighthouse binary: one arena, dirty and muzzy decay zero, background thread disabled. This verifies the change was applied, not that it reduces the live-state requirement enough.

Lighthouse invocation34f8d341874c4e9e9dc41ffc293b9f53 was OOM-killed at20:17:53UTC (code2/status9) without RPC, after startup at20:03:49. The 4GiB cap was unchanged. Startup reached fork-choice restoration and attempted additional hot-state loads. The allocator-only configuration failed; do not repeat it or extend its timeout.

Human imposed a15-minute deadline at20:18:02.695UTC, counted from the attempt including preparation. Separate exact-bound stop helper requested operator-stop at20:18:02.706UTC and received success. The recorded OOM preceded that request by about9 seconds: do not attribute the OOM to the human stop. Existing main/watchdog cleanup and independent remote verification passed; original unchanged, private child retained. A stop acknowledgement alone was not used as death proof.

Next direction is the reviewed local-storage resource/status observation, followed by a different qualified design if it fits. This is not approval for another native run, a cap increase, source-policy weakening or a database reset. All future startup attempts are limited to15 minutes unless the human changes that requirement. No production readiness, RPC consumer switch, app funding or serving-manager change occurred.
