# The manager's WMI launcher on nucbox-k11: two bounded runs, 2026-09-25 (boot 68, Secure Boot ON)

enclave-d1. Code: windows/isolation-manager.
- `wmi-launcher.mjs` is the type-1 port, `7417dd67`, merged at `050aa110`.
- The canary is `ops/launcher-canary.mjs` at `01353d1c`.
- The harness is `ops/manager-launcher-canary.ps1`: run 1 used `01353d1c`; run 2 used `3cc68b87` (sha256 `80803a75…`).
- The image is enclave-63's v30 G1 candidate `a44bb55a…` (launch digest `58DFEBFE…`), linux-direct, 2048 MiB,
  1 vCPU, prefix `enclave-mgrcanary-`.
- AllowFirmwareLoadFromFile was applied by the harness for each run and restored to Absent (verified). The launcher
  never touches it.

This is the first time the manager's own JavaScript launcher, not the `uefi-dev-boot.ps1` recipe, defined, started
and removed a type-1 partition on this host.

| step | run 1 (07:09:35Z) | run 2 (07:11:40Z) |
|---|---|---|
| preflight (role, namespace, pinned hyperv.psm1 `17ca4352…`, master VMGS, opt-in) | ok | ok |
| start: petri New-CustomVM type 1, every read-back, then Start-VM, then COM1 bytes | ok, 46.5 s, 613 B | ok, 46.4 s |
| survey: the VM, by Id, carries the manager's Notes identity (`hv` + 32 hex) | ok | ok |
| stop: removed by VM Id; guest-state copy archived | removed | removed |
| survey-after: nothing under the prefix | ok, none left | ok, none left |
| launcher exit / harness exit | unreadable / 2 (harness bug, below) | 0 / 0 |

After both runs ([post-state-0713Z.txt](post-state-0713Z.txt)):
- no VMs, no sentinel, no watchdog firing, no watchdog process;
- setting Absent, Secure Boot on;
- no run copy left; the master `type1.vmgs` is unchanged (`4f051697…`); both run copies are archived.

What this establishes:
- The ported launcher's type-1 definition, its read-backs, start, console check, Notes identity, and removal by Id
  work against real Hyper-V on this host. The fakes' guesses held: `Set-VMSecurity -VM`, and Automatic Start/Stop
  actions on a type-1 VM.

What it does NOT establish:
- **No app is served.** The launcher loads no app and starts no relay (`appReady:false`).
- **The data plane refuses linux-direct domains.** The handle's `image` is null, with its reason stated, so the
  datapath refuses the domain for want of a medium identity. That integration is open.
- **No isolation result.** `hostExcluded:false`, `attested:false`; no report and no chain.

Findings:
1. **The harness misread the exit code (fixed in `3cc68b87`).** Windows PowerShell's `Start-Process -PassThru` gives
   an empty `ExitCode` after `WaitForExit(ms)` unless the Handle was taken first. So run 1 held every step and still
   said exit 2. An unreadable exit is now a failure.
2. **`start` always takes about guestReadySec.** `readConsole` reads for the whole window rather than returning at
   the first bytes or at `MON ready`. Correct but slow: about 46 s per start with 40 s. It is the manager's latency,
   not a boundary property.
3. **The partition names disagree.**
   - The JS handle names the linux-direct partition `wmi-openhcl-gen2`, telling the forms apart by
     `guestImageKind: "igvm-linux-direct"`.
   - The Rust `wmiserve` report (`8f156c9a`) names it `wmi-openhcl-gen2-igvm-linux`.
   - Both separate the forms. A judge that compares the handle's partition to the signed report's will see a
     mismatch. The verifier contract should choose one name before the two are compared (enclave-99, enclave-5d).
4. **Grants accumulate.** Like the recipe, the launcher grants the VM's own SID read on the IGVM and never revokes
   it, so ACEs for removed VMs accumulate on the staged file. Harmless, but unbounded.
