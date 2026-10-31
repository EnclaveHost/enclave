PREPARED ONLY. No target execution, syntax qualification, tests or mutation.

Purpose: one bounded public readiness observation before any VMGS fence decision.
Use the copied rpc-pool-enrollment-read-r1/run.py transport and unchanged guard
limits, with a fresh local unit/package and exclusive ATTEMPT marker. Root must
review the generated manager-read.ps1 and COMMAND.json before ONE execution.
The preparer has not created an ATTEMPT marker or run the command.

Exact input provenance:
- sidecar-v12/control/windows/vbslike/manager/main.mjs:113–118 consumes
  ENCLAVE_GUEST_STATE_MASTER, MASTER_SHA256, RUN_DIR and ARCHIVE_DIR.
- sidecar-v12/bootstrap.mjs pins C:\ProgramData\Enclave\shield-config.cmd
  SHA256 d688c172b44b21267067ed390803aff1c957f01e13549e6d82f1bd4e01496047.
- sidecar-v12/external-pins.json contains the literal master assignment
  C:\ProgramData\Enclave\shield\type1.vmgs. It does not supply a master hash.
- sidecar-v12/repair-runner.ps1 and runner-repaired.json identify the installed
  release58ca73.../run-manager.cmd and repaired SHA256
  97d27cf986e13069e9bb257b9b7f3dd133025ad3e0957bbdb6094844d80b3c1c.
  The earlier local run-manager.cmd is NOT the repaired bytes. The target read
  must match the repaired pin and its exact literal call to the pinned Shield
  config; no script is sourced/executed. Only four named VMGS assignments escape
  the bounded parser. Duplicate/nonliteral values refuse; no arbitrary config
  path traversal or environment expansion occurs.
- listener incarnations come from rpc-sizing-binding-read-r1 evidence; root
  must approve those pins against its newest retained read before dispatch.

Outputs: public config digests/file identity and whitelisted fields, master
hash/length/device/fileIndex/link count, path ACL/owner/reparse/ancestor facts,
owned VM realized guest-state paths (no run-copy content reads), public process
PID/parent/creation/executable identities, physical/disk facts, whitelisted
manager and node GET projections. No command lines, raw config/environment,
Notes, secrets, private journals or file contents are emitted. Native file
identity is returned by Node fstat(bigint) on a read handle. ACL snapshots are
path-based; this is not a held namespace proof. File identity is bracketed
around content reads; no exclusive access or access-control change is made.

This cannot establish every running process's inherited environment, unseen
launch wrapper, every issuer/master, pending fetch/script/provider operation,
or original journal handoff. allOldIssuerInputsProven and settlement/admission
remain false. A mismatched config is reported unavailable, never guessed. An
unavailable observation, metadata change, unexpected incarnation or transport
timeout authorizes no retry or mutation. Root must assess partial errors.

The existing transport's local timeout explicitly does NOT prove remote death.
Target standard read-only PowerShell/CIM/Get-VM and installed Node are used;
no Add-Type, fsutil child, dot-sourcing, application import, tasks or target
file writes are introduced. Existing guard budget unchanged: CPU1, 128MiB
local outer limit, shared256/220MiB RSS and 27648MiB free floor, no swap.
