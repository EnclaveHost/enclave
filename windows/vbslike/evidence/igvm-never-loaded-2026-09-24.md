# Our IGVM has never been loaded — 2026-09-24

This withdraws two claims I made earlier today and replaces the diagnosis. Both retractions come
from the Hyper-V worker's own event channels, which I had not read until now.

## 1. The worker loads its default image, not ours

`Microsoft-Windows-Hyper-V-Worker-Operational`, event 1820, for **every** partition in every run,
including the ones whose document named our image in `SecuritySettings.Isolation.IgvmFilePath`:

```
[Virtual machine <id>] Loading IGVM file from default location.
```

There is no event naming a path, and no event naming our file. So this build's worker does not read
`IgvmFilePath`, the document is accepted with it present and silently ignores it, and **every**
"create ok, start ok" result reported earlier was Microsoft's in-box paravisor. Our own-guest image
`openhcl-ownguest.bin` (124,962,164 bytes, `2d735376…`) has never executed, and neither has the
upstream test payload. The claim in `f3c3bb7d` and its correction in `09c15623` were both wrong
about what was running.

## 2. `0x80070490` is a memory failure, not a firmware lookup

`Microsoft-Windows-Hyper-V-Worker-Admin`, event 3050:

```
'vbslike-iso-8404-15' could not initialize memory: Element not found.  (0x80070490)
```

I read "Element not found" as the worker failing to find a firmware element and concluded that
`FirmwareFile.Parameters` supplied it. What that parameter actually did was change the **default**
paravisor's memory layout enough for memory initialisation to succeed. The reasoning was wrong even
though the observation was real.

## 3. `Chipset.FirmwareFile.Path` is not the answer either

`FirmwareFile` accepts `Parameters`; adding a `Path` beside it is refused at Construct with
`0x8037010d`, "the virtual machine or container JSON document is invalid", in all three shapes
tried. Disproven cheaply, and not pursued further — guessing schema keys one at a time is not a
method.

## 4. There is no Microsoft reference on this host to diff against

```
Microsoft-Hyper-V                        Disabled
Microsoft-Hyper-V-Hypervisor             Disabled
Microsoft-Hyper-V-Management-PowerShell  Disabled
Microsoft-Hyper-V-Services               Disabled
VirtualMachinePlatform                   Enabled
vmms        NOT INSTALLED        vmcompute  Running        hvhost  Running
```

`Get-VM` does not exist here. The box runs HCS on Virtualization Machine Platform alone, which was
the deliberate design constraint (no feature or boot change). So a "known working VBS-isolated
launch constructed by Microsoft's tooling" cannot be produced on this machine as it is configured -
the tooling that would construct it is not installed. That absence is also a candidate cause: the
custom-IGVM path may be provisioned by the Hyper-V role rather than by VMP.

## Exact versions, for any servicing discussion

| | |
|---|---|
| OS | 10.0.26200, 25H2, UBR 9457 |
| `vmwp.exe` | file 10.0.26100.1, product 10.0.26100.9278 (from the crash report) |
| `vmchipset.dll` | file 10.0.26100.1, product 10.0.26100.9278 |
| `vmcompute.exe` | file 10.0.26100.1 |
| fault | `0xc0000005` at `vmchipset.dll+0x6e31c`, bucket 1868582954261880381, 12 occurrences |

I am **not** claiming a cumulative update fixes this; I have no update identity and no evidence for
one. The crash is real and reproducible, but since our image never loaded, it is a property of
starting an isolated partition with the DEFAULT paravisor on this configuration, and its relationship
to the custom-IGVM goal is now unknown rather than established.

## The two candidate next actions, neither of them servicing

1. **Source comparison, not key guessing.** OpenVMM/OpenHCL launches OpenHCL on Windows through this
   same HCS interface, so its document construction is the authoritative reference for which key
   carries a custom IGVM on a 26100-family worker. That is a read of published source against our
   `hcs.rs`, needs no host change, and replaces guessing.
2. **The Hyper-V role.** Enabling `Microsoft-Hyper-V-Hypervisor` (and the management pieces, to get
   a reference launch) is a FEATURE change requiring a reboot. It is well specified, unlike "a
   cumulative update", and it is the thing that would both provide a reference and test whether the
   custom-IGVM path is role-provisioned. It is Steven's call and I have not done it.

## Still true

No app runs on this backend. The five production apps run on the old path. Nothing here is verified
protection and nothing is advertised as tenant capacity.
