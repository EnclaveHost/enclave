# Fresh native RPC state

`prepare_vmgs.py --tool /absolute/pinned/vmgstool --out /new/private/directory`
creates a fresh VMGS input for native Windows definition. Run it only in the
reviewed offline preparation envelope. It does not access a VM, import a donor,
copy provisioned state, create a key, register a task or start a guest.

The tool is pinned to SHA-256
`46e0eefcbcac4d32cbcf89c52bff75a57ff6871052346fd07a156d0038ce856a`.
Preparation snapshots and hashes that executable, creates the output directory
exclusively, durably records an intent and invokes only `create --file-size
4194304` with the new fixed filename. There are no encryption-key, import or
force-overwrite arguments. The tool has a 20-second child deadline; the caller
must also enforce the independent aggregate memory/CPU/lifetime envelope.
Failures leave the directory consumed and retain partial evidence.

Independent readback requires exactly 4,194,816 bytes: a 4 MiB VMGS v3 store
and a 512-byte fixed VHD footer. It checks the fresh sequence-one header and its
CRC, blank alternate header, file-table entries 0 and 63 only, blank extended
table, and every unallocated byte. All TPM, key-protector, provenance, guest
identity and provisioning-marker entries must be absent. The fixed VHD footer
must have the correct checksum, size, format and creator metadata, a nonzero
disk identifier, and no saved-state marker or reserved data. Valid headers alone
are insufficient: hidden bytes in unused blocks also refuse preparation.

The new state is deliberately unprovisioned and unencrypted. This proves the
absence of inherited state at preparation, not the confidentiality or trust of
future host-managed VMGS. The guest-only volatile report-input patch and fresh
hardware/guest identity checks remain mandatory. The state and tool snapshots
stay private; publish only the source and bounded evidence receipts.

The native controller accepts the resulting file and full digest as
`initialStatePath` and `initialStateSha256` in its protected configuration. That
configuration still requires fresh target admission, original attempt authority
and a new private per-attempt copy. Never point it at a previously booted VM's
state or overwrite an ambiguous attempt. Do not infer Windows provider sharing,
future growth, target acceptance or attestation from this offline readback.

Actual qualification `rpc-fresh-vmgs-r1` created and checked a new store with
SHA-256 `7fae11f9bd0ace50bf3fb1acd75961f7b9674d4301aaeae3eef908fa3beebae5`.
Three tests also covered inherited metadata/hidden payload, footer corruption,
truncation, symlinks and existing-attempt refusal. No guest was booted. The
receipt keeps `windowsAccepted`, `providerSharingQualified`, `growthQualified`,
`hardwareIdentity` and `deployed` false. The later source read-limit refinement
passed a separate test with an actual file append during the snapshot. It stops
before intent or execution; the successful store was not recreated.
