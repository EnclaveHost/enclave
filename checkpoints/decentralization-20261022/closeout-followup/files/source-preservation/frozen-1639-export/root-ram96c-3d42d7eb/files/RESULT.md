# NucBox host RAM allocation: 96 GiB active; nine apps recovered

Direct user instruction: increase the current 64 GB allocation to 96 GB.

At 2026-10-23T10:09:28Z, root backed up and atomically changed only NODE_APP_RAM_GB=64 to 96 in node-config.cmd, node-config.local.cmd, and shield-config.cmd under C:\ProgramData\Enclave. Every resulting file was read back and checked. No source, contracts, VM settings, physical RAM, or application data changed. Backups remain only on the host; no private configuration contents are copied into this repository.

Verification at 10:09:53Z: both services healthy; runtime still 64 GiB / manager 65536 MiB because setting is startup-only. All eleven VMs retain identical assigned memory and increasing uptime; eight tenant apps running. No service or VM restarted.

Activation needs BOTH run-node and run-shield scheduled-task wrappers relaunched, not just their child node.exe processes: the wrappers load config before their restart loop. A manager restart destroys its live relays; recovered app VMs are not serving until reconciled. Root asked whether the ongoing NucBox experiment now permits that interruption. Do not activate merely because this config is staged.

Follow-up installer hazard: install-host.ps1 clamps the manager budget to floor(physicalGiB)-16 (95 here), while the owner local override remains 96 for the node. F composition owner notified: a future updater must not silently create this mismatch. Current three files all have 96.

First atomic write attempt failed because PowerShell converted a null backup argument to an invalid path; it made no config change. Corrected File.Replace uses an explicit backup path, then succeeded. Extra .pre-ram96 backups and the first attempt's sibling .tmp may remain. No secrets are present in the tracked receipts.

Activation procedure prepared (not executed): `activate.py` defaults to a no-contact dry run. After direct human restart release, execute individual `--execute --step` actions through the existing 256 MiB queue. It checks saved config hashes, exact scheduled task actions, physical headroom, successful preceding receipts, and old task/listener absence. Shield must expose poolMiB98304 before Node is started. It does not explicitly stop VMs, reboot, install code or edit config. Runtime/app health must still be verified afterward using status.py and endpoint checks. Only Python parsing and local dry-run generation have been verified; PowerShell/runtime behavior has not been executed or validated. Keep the ongoing experiment protected until the human replies.

Read-only verification at2026-10-23T11:07:35Z still reports node64GiB and manager65536MiB, both HTTP200, eight running tenant apps and eleven running VMs. No restart was executed; the human restart/experiment question remains unanswered. Receipt: status-current-check.json.

Offline activation-command transport check: all four generated PowerShell steps, including the helper watchdog/hash header, fit the helper limit of 7,900 encoded characters (preflight7,116; stop5,672; start-Shield6,104; start-Node6,944). This verifies transport size only, not native syntax or behavior; no SSH or restart occurred. Exact source hashes are in encoded-size-check.json.

## User-authorized activation on 2026-10-23

The user explicitly approved the restart. Native preflight passed at15:25:52Z, with45.2GB free physical memory and a conservative21.6GB app-growth estimate plus8GiB headroom. The Node and Shield scheduled wrappers were stopped and restarted in order. Both active APIs confirmed96GiB (node96; Shield98304MiB) at15:27:33Z. No full Windows reboot was needed; the control/storage VMs retained their uptime. No code or private config changed during activation.

Fresh admission initially held the host owner-only, then passed and restored market scope. Automatic recovery retired the recovered app partitions through the manager before starting fresh measured partitions. At15:33:36Z four apps were running, with the others still progressing through recovery. This is an intermediate state, not a completed recovery claim. API-MCP's fresh certificate was installed at15:33:06Z. Local workstation DNS temporarily failed; direct-ingress TLS checks are tracked separately.

At15:41:46Z, restored the already-published EnclaveDNS0.1.5 artifact to the EXISTING us-west recovery replica. All four retained replicas returned404 for this CID, while the running adapter returned an empty/truncated CAR. Reconstructed the frozen release DAG (11blocks), verified CID and artifact SHA256 e3780187ebaff9e0f4f1440d8292f7e161f764825e5e2f56880150d6605ef5e9, and added one immutable entry after checking the old manifest hash. Original1018entries preserved; backup retained on host. Only that existing cache service restarted. This repairs availability, not decentralization: the retained provider replica and distributed storage cold recovery remain architecture work. No new app version, chain transaction, signature or admission bypass. Readback/app recovery still pending at this intermediate checkpoint.

## Final verification

At15:43:47Z all nine previously running tenant apps were Running, with one fresh readiness VM. At15:44:19Z node96GiB and Shield98304MiB both returnedHTTP200; control/storage VM uptime increased without a restart. At15:44:59Z all nine normal public app hostnames passed system-CA and hostname TLS verification, including EnclaveDNS and API-MCP. Cache readback verified the entire CAR and recovered WASM against its published CID and release hash. No app version, contract, admin policy or deployment placement changed.

The allocation is not free physical RAM. Observed VM assignments total74.92GiB on112GiB physical; the future chain backend deployment must remeasure capacity. The provider recovery cache remains an existing architecture dependency and this incident does not complete decentralization. Bulk artifact copies are not committed; the frozen release provenance, deterministic CAR reconstruction recipe and digests are committed.
