# Installed Windows operator identity: read-only observation

At 2026-10-29 21:17:26 UTC, one bounded minipc SSH diagnostic succeeded. The exact scheduled task `\Enclave\Node` is enabled, state 4, principal SYSTEM, logon type 5, run level 1. Its cmd.exe action matches the known run-node.cmd launcher. The alternative EnclaveWindowsNode task was absent. No matching/named SCM service was found.

The port 9600 listener is PID 41272, created 2026-10-27T08:24:45.0989590Z, with owner SID S-1-5-18 and the known agent.mjs entry. Its executable is the existing Enclave Node runtime. The process incarnation/executable/command remained stable across the diagnostic. Task configuration plus matching owner does not establish task-to-process ancestry.

Bounded reads of three known config files expose only hashes, byte counts, known calls and literal NODE_DIR assignments. node-config.cmd assigns C:\ProgramData\Enclave\node and calls node-config.local.cmd; the latter has no recognized literal assignment. Effective running NODE_DIR remains unknown because this narrow read does not prove all command semantics or inherited environment. No raw arguments, environment, configuration or credentials are preserved.

This establishes an actual compatibility blocker: the frozen wiring candidate accepts only NT SERVICE virtual accounts and SCM exclusion records. The repair must support the installed SYSTEM scheduled-task model without changing its account implicitly. This observation is not writer exclusion, native EXLOCK, ACL effective access, process-death, memory admission or migration qualification.

No service/task/app/journal changed, and no retry occurred. Local shared queue 512 MiB hard / 450 MiB RSS, 27,648 MiB available floor, CPU 1, no swap; 60-second unit/45-second transport/4-second CIM bounds. Guard logs and terminal MainPID 0 are retained. These local limits do not establish a remote whole-job resource guarantee; a timed-out SSH session would not prove remote exit. This attempt returned normally.
