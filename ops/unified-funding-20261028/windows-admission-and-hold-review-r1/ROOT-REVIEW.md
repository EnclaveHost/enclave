# Windows admission observation and truthful ingress acknowledgment

No production mutation, new funding, app restart or new deployment occurred. The same reviewed Claude r2 run remains active; its inputs and candidate were not changed by these checks.

## Read-only Windows observation

One reviewed aggregate observation at13:35:26UTC returned81,684MiB available. Actual8091 reported stable epoch, no starting or unattributed records,5,166MiB allocated and84,992MiB pool;8095 reported stable epoch, no starting or unattributed records,0allocated and the same pool. These are overlapping shared pool definitions, not two independent free pools. Output is diagnostic and explicitly inadmissible. It does not cover failed-launch commitments, a pre-dispatch router reservation, external pending jobs or future admissions. No EXLOCK test, native launcher build or remote staging was executed.

Observation script5535101430c793729631181740e9e2a3d1a1a251989997697e5809499976a72e/runnerfc7cbf3c623b12429ae24372d4022c4d4eb3e682d38e0a41d09837d89e41bc06 matched proposal pins. Unitb9fad5b9d5c7432295d9fa80261e80a4 terminal/Main0/rc0. Local256MiB shared lane/220RSS/floor27648/CPU1/noSwap; remote operation was bounded read-only PowerShell/GET, not a claimed Windows Job Object memory qualification. Pending evidence must be resolved before using free memory to admit the lock test.

## Actual hold acknowledgment defect

The unchanged frozen Windows r1 candidate was composed using actual installed Manager/ProtectedManager, authenticated ControlServer/GuestdControl, real signed permits, separate guard process and an actual loopback TCP splice. TEST backend/authority/inventory and in-process exclusion remain explicit limitations. Injecting failure into the actual closeInstance call while backend stop is held leaves the established connection open, yet the MAC-authenticated hold reply returns ingress:true. The independent assertion fails (1FAIL/0skip), proving that acknowledgment is inaccurate. It does not demonstrate a production app leak or Windows VM escape. Cleanup restored the close function, closed the stream, released the TEST stop and awaited removal.

Final unit7ebd7fba64f74539948b91ceeaa317d2 terminal/Main0/rc1,256MiB/220RSS/floor27648/CPU1/noSwap/netnsloopback; inner peak175MiB/min33321. Source pins from windows-manager-review-r1 remained unchanged. The active r2 task already requires truthful boundary acknowledgments; this test is retained for its later frozen review, without modifying active author inputs.

## Retained fixture failure and cleanup correction

The first hold run did not reach the assertion: deep persistent TMPDIR made its Unix socket request190bytes. The runtime truncated the filesystem path to U/windo, colliding with a stale socket from the earlier persistent-router test. That earlier router run passed its three cases but left this filesystem artifact; no live server remained. This is a Linux fixture path issue, not a Windows/product failure. Unix IPC must use a separate short owned directory; router journal files must still use suitable persistent storage.

The final hold rerun uses short /tmp paths; this test does not instantiate the router journal. The single stale socket was removed only after exact uid/type/inode6078719/ctime13:25:14 correlation with root unitfe989dc9, both owning units MainPID0 and no Unix listener. socket-cleanup.json preserves the receipt. No broad deletion or cleanup of other jobs occurred. Initial EADDRINUSE evidence is retained separately from the actual acknowledgment failure.

External dependencies/assembled source are those of windows-manager-review-r1. The copied observation proposal-pins manifest references other unexecuted proposal files in its original directory; this package preserves the executed observation subset, not a standalone qualification runner or release.
