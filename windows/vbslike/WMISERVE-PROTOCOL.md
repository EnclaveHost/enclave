# `vbslike-host wmiserve` — the line protocol

The contract between the manager and the Rust launcher for a partition the launcher did **not**
create: a Hyper-V VM defined through WMI, named only by its GUID. Pinned so the manager driver and
the package's expectations name the same thing.

Source: `windows/vbslike/host/src/wmiserve.rs` at `1ba73a20`
(`windows/custom-vbs-like-hyperv`), binary `c2cb0c10945a35f8…`.

## Invocation

```
vbslike-host wmiserve --vm <GUID> --bundle <file> --medium-sha256 <64 hex> --isolation-type <1|16>
                      [--tcp <port>] [--label <name>] [--vcpus N] [--mem MiB] [--hold SECONDS]
```

`--isolation-type` is **required** (since `daa61749` on windows/custom-vbs-like-hyperv; launcher `da16c20f`): the
partition kind the launcher actually created, 1 (VBS) or 16 (no isolation). It is refused rather than defaulted,
because the ready note and the boundary line state it and guessing would state it wrongly. `hostExcluded` stays
false on BOTH types.

`--medium-sha256` is **required**: without it the signed report cannot say what the guest booted
from. It is the hash of the medium **as attached**, taken by the caller from the VM's own DVD/disk
path, not from the pin it intended to attach.

The caller creates, configures and starts the VM. This process joins an already-running partition
after `MON ready`, so ordering is the caller's to get right.

## Output: one JSON object per line on stdout, in order

| `step` | fields | meaning |
|---|---|---|
| `launcher` | `key` (base64 Ed25519 public), `vm` | the report signing key for this run. Ephemeral: a new one per invocation |
| `report-service` | `port` 9001, `bound` bool, `error?` | the signer is listening. `bound:false` means no attestation can be answered |
| `load` | `ok`, `id`, `appSha256`, `guestPort`, `agreed`, or `ok:false` + `error` | the bundle is in the guest |
| `relay` | `ok`, `tcp`, `guestPort`, or `ok:false` + `error` | host TCP is carrying ciphertext to the domain |
| `ready` | `note` | serving. The note states the tier's limits and is not decoration |
| `closed` | — | the hold expired or a line arrived on stdin |

A failing step prints `ok:false` with `error` and the process exits non-zero. **Absence of a later
step is a failure**, not silence to be interpreted.

## The rules this enforces, which a caller must not re-implement loosely

- **Hash agreement.** The monitor's `appSha256` is compared with the launcher's own hash of the
  bytes it sent. On any disagreement the domain is **destroyed** and `ok:false` returned, before it
  can serve. `agreed:true` in the `load` line means that comparison ran and passed.
- **Only a loaded app is signed.** A report request whose `report_data` names an app this process
  did not load into **this** VM is refused by name.
- **Only this partition may ask.** The 9001 listener is bound to the VM's GUID and a connection
  whose peer is another partition is closed without an answer.
- **The relay never terminates TLS.** It copies bytes between a host TCP socket and hv_sock
  `40000+id`. The guest holds the key.

## What the signed report says on this path, and why it differs from HCS

- `partition.guestImageSha256` — the **medium's** hash. Not the UKI's: with Secure Boot off the stub
  reads addons, credentials and extensions from the ESP, so two media carrying one UKI can boot
  different command lines, and only the medium hash separates them.
- `partition.kernelSha256` — **omitted entirely**. No host-supplied kernel exists here, and a field
  present and blank still claims something.
- `platform.partition` — `wmi-openhcl-gen2`, stated by the launcher. The guest cannot know its own
  partition kind and the monitor no longer guesses.
- `platform.hostExcluded` — **false**. Type 16 is "OpenHCL but no isolation" in Microsoft's own
  source (`petri/src/vm/hyperv/powershell.rs`), so the root partition can map this guest's memory.

## Host prerequisite the HCS path does not have

A host process may only **bind** a partition's hv_sock service if that service GUID is registered
under `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices`.
Port 9001 is `00002329-facb-11e6-bd58-64006a7986d3`. Without it the bind fails with **os error
10013**, "access forbidden". The HCS path never needed this because its compute-system document
carries `HvSocket.HvSocketConfig` with an SDDL granting SYSTEM and Administrators; a WMI VM has no
such document, and this build exposes no `Msvm_HvSocket*` class.

Register it for the run and remove it after, and never remove a GUID somebody else registered.
