# Portable Shield-direct guest candidate inputs

This is a build-input bundle for the unactivated candidate from Enclave commit
0ed5a8ba. It includes public pinned firmware, kernel, runtime and generator
artifacts, guest source, and the two public Go modules used by the guest. It
contains no wallet credentials, guest secrets or operator state.

Verify the bundle's archive SHA-256 against the published candidate record
before extraction. INPUTS.json verifies each input after extraction; it is not
an independent signature or an authority by itself.

Run `bash rebuild.sh` from this directory. No network dependency downloads are
used: GOPROXY is off and GOMODCACHE points to the bundled public sources.
The measured runtime and kernel are preserved as pinned binary inputs.
Rebuilding those upstream dependencies from source is outside this bundle.

Tested prerequisites: Linux x86-64; Go 1.27.2 with GOEXPERIMENT=nodwarf5;
GCC 16.2.1 20260810 with its static libc; Node.js; Python 3; bash. Toolchain
executables/static libc are not bundled. Other versions may give other output;
the script refuses to proceed unless the compiled initrd matches the candidate.
The image generator required a 1 GiB memory scope on the tested machine.
Use a disk-backed workspace: /tmp may be RAM-backed. Allow several GiB disk
space for temporary image builds. The generator is pinned and runs natively on
Linux; no Windows executable or Wine is involved.

Expected image SHA-256:
`c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec`.
VBS digest:
`6a3135a9378688805a36905c5e0f1443bb65031014618f390a6e3d6e2d90b86a`.

The build reproduces a historical reference image, verifies its twin, builds
the candidate twice and checks six measurement mutations. The DEBUG-TRUSTS-HOST
output is a negative test artifact and must never be served. Successful
reproduction does not prove real TPM or guest transport behavior, independent
operators, custody migration or production readiness. Separate legacy/direct/GPU
selection and the documented hardware activation gates remain required.
