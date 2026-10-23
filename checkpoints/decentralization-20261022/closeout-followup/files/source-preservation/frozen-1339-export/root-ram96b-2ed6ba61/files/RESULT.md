# NucBox host RAM allocation: configured 96 GiB, activation pending

Direct user instruction: increase the current 64 GB allocation to 96 GB.

At 2026-10-23T10:09:28Z, root backed up and atomically changed only NODE_APP_RAM_GB=64 to 96 in node-config.cmd, node-config.local.cmd, and shield-config.cmd under C:\ProgramData\Enclave. Every resulting file was read back and checked. No source, contracts, VM settings, physical RAM, or application data changed. Backups remain only on the host; no private configuration contents are copied into this repository.

Verification at 10:09:53Z: both services healthy; runtime still 64 GiB / manager 65536 MiB because setting is startup-only. All eleven VMs retain identical assigned memory and increasing uptime; eight tenant apps running. No service or VM restarted.

Activation needs BOTH run-node and run-shield scheduled-task wrappers relaunched, not just their child node.exe processes: the wrappers load config before their restart loop. A manager restart destroys its live relays; recovered app VMs are not serving until reconciled. Root asked whether the ongoing NucBox experiment now permits that interruption. Do not activate merely because this config is staged.

Follow-up installer hazard: install-host.ps1 clamps the manager budget to floor(physicalGiB)-16 (95 here), while the owner local override remains 96 for the node. F composition owner notified: a future updater must not silently create this mismatch. Current three files all have 96.

First atomic write attempt failed because PowerShell converted a null backup argument to an invalid path; it made no config change. Corrected File.Replace uses an explicit backup path, then succeeded. Extra .pre-ram96 backups and the first attempt's sibling .tmp may remain. No secrets are present in the tracked receipts.

Activation procedure prepared (not executed): `activate.py` defaults to a no-contact dry run. After direct human restart release, execute individual `--execute --step` actions through the existing 256 MiB queue. It checks saved config hashes, exact scheduled task actions, physical headroom, successful preceding receipts, and old task/listener absence. Shield must expose poolMiB98304 before Node is started. It does not explicitly stop VMs, reboot, install code or edit config. Runtime/app health must still be verified afterward using status.py and endpoint checks. Only Python parsing and local dry-run generation have been verified; PowerShell/runtime behavior has not been executed or validated. Keep the ongoing experiment protected until the human replies.

Read-only verification at2026-10-23T11:07:35Z still reports node64GiB and manager65536MiB, both HTTP200, eight running tenant apps and eleven running VMs. No restart was executed; the human restart/experiment question remains unanswered. Receipt: status-current-check.json.

Offline activation-command transport check: all four generated PowerShell steps, including the helper watchdog/hash header, fit the helper limit of 7,900 encoded characters (preflight7,116; stop5,672; start-Shield6,104; start-Node6,944). This verifies transport size only, not native syntax or behavior; no SSH or restart occurred. Exact source hashes are in encoded-size-check.json.
