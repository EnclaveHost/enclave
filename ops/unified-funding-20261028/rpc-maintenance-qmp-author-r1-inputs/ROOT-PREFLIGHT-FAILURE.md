# Original preflight failure and reviewed alternative

Invocation21360273bb3c4fc49947e08e8e259593 stopped exit1 before auth or author work: process identity unreadable; root review required. Original prepared inputs remain byte-identical. MainPID0; inner exited1; no root-preflight-result/author markers. Shared queue scope owns child output, so outer unit status after collection is not failure evidence by itself; journal contains actual exit1.

Root inspected same-user process metadata: 41 executable links unreadable, classified as systemd, sd-pam, ly-dm, 37 ssh-agent, gpg-agent using comm and argv0. No unknown classes and no readable process uses reviewed2.1.281 executable. Other Claude versions exist and were not killed or changed. This does not prove absence of all credential concurrency. Noninteractive privileged readonly audit unavailable (sudo password required); no escalation or password request used.

Separate root-preflight-v2.py preserves original hash/seed/account/resource checks, classifies only these observed daemon pairs, records PID/start/class and unreadable-exe limitation, refuses any unknown. This is independent root admission tooling, not a product or prepared-runner edit. ONE bounded account status only, not API refresh proof. Future API failure is terminal with evidence, no retry. No credential lock/account change or process termination permitted.
