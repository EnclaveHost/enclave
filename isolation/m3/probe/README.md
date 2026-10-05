# NucBox public vTPM report probe

This is a disposable diagnostic init and guest driver, not a production image.
The wrapper reads OpenHCL's public report at NV index 0x01400001, creates the
64-byte guest-input index 0x01400002 if absent, writes a fresh random challenge,
waits past OpenHCL's two-second refresh limit, and reads the report in bounded
chunks. It then executes the original init at `/init-real`.

The fallback diagnostic module connects two guest-owned pages through OpenHCL's
x86 TPM port interface and maps only those pages to the root probe. It does not
access the host TPM or mark pages shared with the host. This probe uses forced
module-version loading because the original WSL kernel build did not preserve
Module.symvers. **Never ship or allowlist this diagnostic image.** The normal
TPM driver is being developed in `../vtpm` and must use a matching kernel build.

## Measured September 29, 2026

On NucBox host boot 69 with Secure Boot on and test signing off:

- The direct Linux loader supplies no TPM2 ACPI entry, so `/dev/tpm0` was absent.
  The kernel also has `CONFIG_X86_IOPL_IOPERM` disabled.
- The diagnostic guest driver successfully read the OpenHCL CRB vTPM.
- The VBS report verifies with this boot's IDKS, RSA-PSS SHA-256, salt 32,
  signed span `[0,304)`, signature `[304,560)`.
- The report measurement matches igvmfilegen's exact build-time VBS digest.
- SHA-256 of the HCLA runtime claims matches report_data[0:32]; its other half
  is zero. The signed claims contain the exact fresh 64-byte guest input.
- A separate same-boot host evidence exchange passed the existing hv-node
  verifier: EK root, credential activation, quote, PCR replay, measured Secure
  Boot, VSM/HVCI, debug-off and test-signing-off checks. Its authenticated log
  is byte-identical to the one supplying IDKS for the VM signature check.

Fresh-challenge probe firmware SHA-256:
`4d45a3ce32a40ce0571d9ebc9bbf6a84d41936db0d5f4299bc6bd6fdf63b6b7d`

VBS launch digest:
`e3f136bc54db00acbacc28db95937adac1a3151b01974a16e0e828822e9448e1`

Pinned OpenHCL source: `a7b0bd4a653ba1c9192497a9d3669b14e7f3bc58`.

These results establish the report transport and cryptographic chain. They do
not, by themselves, establish app TLS-key custody, defeat of host memory access,
or production admission. The production boundary remains `hostExcluded:false`.

Evidence is retained locally in
`/home/steven/enclave-bench/nucbox-shield-20260929` and on NucBox under
`C:\Users\claude\vbs-evidence`. The raw host identifiers and TPM evidence are
not source fixtures. `relay/vbs-vm-report.test.mjs` uses synthetic signing keys.
