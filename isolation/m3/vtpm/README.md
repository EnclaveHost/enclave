# OpenHCL direct-boot TPM transport

Candidate driver, not yet approved for production. It provides the Linux TPM
class interface for OpenHCL's x86 CRB device when the direct Linux loader omits
its ACPI description. It runs only in a Hyper-V VBS guest, validates the CRB
interface, allocates two contiguous guest-private pages below 4 GiB, and exposes
normal `/dev/tpm0` semantics through the TPM core. It cannot be unloaded while
OpenHCL retains its buffer addresses.

Build against the **complete matching kernel build**, including Module.symvers:

```
make -C "$KERNEL_BUILD" M="$PWD" modules
```

Do not use forced module loading or ignore unresolved symbols in a production
build. The disposable feasibility probe in `../probe` is a separate artifact.
