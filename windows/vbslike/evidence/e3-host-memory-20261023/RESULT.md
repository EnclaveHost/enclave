# E3 — host-memory exclusion: RESULT (2026-10-23, nucbox-k11)

E3 asks the one thing a boot state and a signed report cannot answer: **can the ordinary Windows
host OS (the root partition's VTL0 — kernel and admin/SYSTEM) read a running VBS type‑1 partition's
private guest memory?** Until now it was `BLOCKED (parked by direction)` in `PROOF-CHECKLIST.md`, and
every record carried `host_excluded=no`.

**Result: host‑OS exclusion of VBS guest memory is DEMONSTRATED on this host (scoped below).** A
privileged host memory capture that *does* read a non‑isolated child partition's RAM *cannot* read a
VBS type‑1 child partition's RAM. The two partitions differ only in the isolation bit, so the
exclusion is attributable to VBS isolation — not to the generic fact that child‑partition memory is
hypervisor‑managed.

## Threat model (unchanged from PROOF-CHECKLIST.md)
Target: exclusion of the ordinary host OS = root VTL0 (kernel + admin), under a TRUSTED hypervisor,
root VTL1 secure kernel, firmware/boot chain. Physical access out of scope. VBS here is
hypervisor‑enforced page protection, not memory encryption.

## Why the earlier attempts were inconclusive (and avoided here)
- **vmwp ReadProcessMemory** (2026‑09‑25): the worker process does not hold GPA‑backed guest RAM in
  enumerable committed regions — the instrument saw nothing even where it should (VOID).
- **Save‑VM / saved‑state**: refused on type 1, so it cannot be the comparison instrument.
- **The per‑boot nonce as a marker is contaminated**: the monitor returns it to the host, so finding
  it in a host capture could be a host copy, not guest RAM. (It appeared in host capture as expected.)
- **Any marker pushed into a guest over hv_sock transits host memory** (the vmwp relay), so it is
  host‑present regardless of whether guest RAM was read.

## Instrument: a privileged host live memory capture, with CLEAN guest‑only markers
Capture: `NtSystemDebugControl` command 37 (`SysDbgGetLiveKernelDump`), version‑1 control,
`Flags = IncludeUserSpaceMemoryPages | AbortIfMemoryPressure (0xC)`, `AddPages = HypervisorPages (0x1)`.
This is the host OS's own capture of host‑accessible memory, including user‑space process memory and
hypervisor pages. `status=0x00000000`.

Two markers, each present ONLY inside a running guest (never in a host file or process), so a hit in
the capture is unambiguously guest RAM:
- **C1/C2 (non‑isolated control):** 64‑byte chunks of the guest's **decompressed** monitor code.
  The host only ever holds the *compressed* `mon.cpio.gz`; the guest kernel decompresses it into
  guest RAM. The chunks were verified ABSENT from the compressed image and were extracted in memory
  (no decompressed copy written to host disk). 46 distinct bytes each.
- **N (isolated test):** the type‑1 guest's **per‑boot nonce**, generated inside the guest. The
  canary was **never dialed before the capture**, so at capture time N existed only in the isolated
  guest's RAM (the host had never received it). N was revealed only afterwards, by dialing the
  monitor's control port.

Both canaries are GPA‑backed child partitions (0 host working‑set), differing only in
`GuestStateIsolationType` (none vs 1/VBS). The non‑isolated control is a direct‑kernel (HCS
LinuxKernelDirect) partition; the isolated test is an OpenHCL type‑1 partition on the production
guest image (`runtime.bin`), `GuestStateIsolationType=1` read back, `GuestFeatureSet=0x201`.

## Measurement (single capture, both canaries live)
| Marker | Guest | In the host capture? |
|---|---|---|
| C1 (decompressed monitor code) | NON‑isolated (`iso=none`) | **PRESENT** (count=1) |
| C2 (decompressed monitor code) | NON‑isolated (`iso=none`) | **PRESENT** (count=1) |
| N (per‑boot nonce, guest‑only at capture) | ISOLATED (`iso=1`, VBS) | **ABSENT** (raw‑16, hex, utf‑16; count=0) |

- C1/C2 appear exactly once (one guest, one copy): the capture **does** reach non‑isolated GPA‑backed
  child‑partition guest RAM — so the instrument is not blind to child memory.
- N is absent in every encoding, in the same capture, and **remained absent even after N had been
  revealed to the host** (the host does not retain it in a capturable region).
- Corroborating: a complete physical crash dump (forced bugcheck, `CrashDumpEnabled=1`) of the running
  production box was 95.8% zero — only ~5 GB of 112 GB held readable content; the ~46 GB of VBS guest
  RAM was not present as data.

## Verdict
**On this host, the ordinary host OS cannot read a VBS type‑1 guest's private memory through any
mechanism exercised here** — user‑mode process reads, `\Device\PhysicalMemory` (access‑denied), a
full kernel live‑dump including user + hypervisor pages, and a complete physical crash dump — while
those same mechanisms **do** read a non‑isolated guest's RAM. The differentiator is VBS isolation.

This updates E3 from `parked` to **demonstrated (box‑local)**. It does **not** change the per‑app
verifier verdict: `host_excluded` stays `no` in the signed report (V8), because this is a one‑time
box‑local demonstration of the isolation property, not a property a per‑deployment report can attest
remotely.

## Honest scope / residuals
1. **Not exercised:** a raw physical (SPA) read via a kernel debugger (`kd`) of the guest's backing
   pages. Enabling kernel debugging is **refused by Secure Boot policy** (`bcdedit /debug on` →
   "protected by Secure Boot policy"), and Secure Boot cannot be disabled from the OS (requires
   physical BIOS access). The live‑dump result already shows the hypervisor removes the isolated
   pages from VTL0's *privileged* capture — the same mechanism a `kd` SPA read would meet — but the
   `kd` path itself was not run. Closing it (and the operator‑with‑physical‑access case) needs
   Secure Boot off + `kd`.
2. **Control construction:** the non‑isolated control is direct‑kernel (HCS) while the isolated test
   is OpenHCL (paravisor). A perfectly matched type‑16 (OpenHCL, `IsolationType::None`) control does
   not stay booted on this host, so the differential is across GPA‑backed child partitions that also
   differ in construction; the operative variable is still isolation.
3. Per the threat model, the hypervisor, root VTL1 secure kernel, firmware and physical access remain
   trusted; VBS is page protection, not encryption.

## Reproduction (host tooling)
- Live capture: `NtSystemDebugControl(37, {Version=1, BugCheckCode=0x161, Flags=0xC, AddPages=0x1})`.
- Clean non‑isolated marker: `gzip.decompress(mon.cpio.gz)`, take a high‑entropy 64‑byte chunk absent
  from the compressed bytes; present only in a running direct‑kernel guest's RAM.
- Clean isolated marker: boot a type‑1 canary (`runtime.bin` + a minted blank VMGS,
  `GuestStateIsolationType=1`), do NOT dial it before the capture; reveal its per‑boot nonce after.
- Scan the capture for both markers (raw + hex + utf‑16). Non‑isolated present + isolated absent ⇒
  isolation excludes the host.

Owner note: this is an E3 result record (enclave-12, driven by Steven 2026‑10‑23). `host_excluded`
in the per‑app verifier (V8) is unchanged. See `PROOF-CHECKLIST.md` O1/E3.
