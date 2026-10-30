# SYSTEM identity source qualification — r4

The unchanged 252-file frozen candidate passes **140 tests, zero failures, skips or cancellations**: all 102 retained checks plus 38 new SYSTEM identity/configuration/ACL/installer cases. No root product repair was needed. This is source qualification only. No backend installation, native Windows execution, protocol migration, automatic refill or financial transaction occurred.

## Reviewed implementation

The config accepts an explicit canonical `NT AUTHORITY\SYSTEM` / `S-1-5-18` process identity and a separately specified, bounded local-owner scheduled-task launcher. The owner may choose a non-Enclave task name; no centralized approval is required. The existing virtual-service identity remains a distinct form. Mixed identity fields, arbitrary accounts, wrong SIDs and malformed launcher paths are rejected.

SYSTEM state ACL evaluation requires exactly SYSTEM and Administrators full-control entries. Trust-input ACL evaluation treats SYSTEM as a trusted OS writer; it does not pretend SYSTEM cannot alter its own files. Broad or other untrusted write/replace access is still refused. The virtual-service read/no-write trust policy and separate state-write entry remain intact.

SYSTEM installer plan/apply and runtime construction deliberately return `CutoverUnqualified` before probes, journal access or writes. No environment flag, input Boolean or TEST override enables them. The missing facts are continuous old-writer exclusion, the running process's effective NODE_DIR and task-to-process binding. The SYSTEM directory-creation script is not implemented; the old three-entry service script is unreachable for SYSTEM. This slice must not be reported as a working SYSTEM migration.

## Evidence and limits

`result.tap` is the actual combined execution. The candidate runs actual config/installer/operator-effect modules, Linux owned storage and the unmodified shipped client, with inert signer/RPC/relay and explicit Windows ACL/process fixtures. It does not establish native Windows effective access, EXLOCK, process death, Base authority, hardware capacity or OS-crash durability.

The retained test files differ from the r2 repaired review only in import paths pointing to this candidate. The dependency symlink uses the same existing workspace node_modules. Product pins were checked before and after the run. The frozen delivery is preserved separately at `../operator-windows-wiring-delivery-r4/candidate`; `pins.json` identifies all candidate and harness bytes. No frozen source was edited.

Unit `enclave-windows-wiring-r4-root-tests-20261029` / invocation `2fce193a23b049509a149a22c6b1166b` completed with exit 0, MainPID 0 and its owned temporary directory removed. Shared queue, 512 MiB hard limit, 450 MiB inner RSS, 27,648 MiB available floor, CPU 1, no swap and isolated loopback namespace were used. Inner peak 185 MiB; aggregate peak 236 MiB; minimum host available 32,376 MiB.

Claude's exact terminal delivery had six changed files, zero removed files, zero readonly-input drift and zero mutation replay issues. Its author report/closure honestly states no author tests. Root independently verified all 252 hashes. The previously repaired chain authorization quarantine, three r12 projection/last-send repairs and shipped bundles remain unchanged.

## Next boundary

Use existing ownership primitives and launcher artifacts to implement and qualify continuous exclusion and startup bindings while preserving serving legacy apps. Native admission still requires at least the live 18,432 MiB floor plus pending commitments, observer and early-setup allocations; none may be assumed zero. The existing lower launcher cutoff is insufficient. Do not remove `CutoverUnqualified` based on stale JSON, task status alone, an empty journal or these fixtures. Production Top up and the three recorded original recoveries remain unchanged.
