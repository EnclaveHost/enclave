# Threaded apps in isolated guests

The per-app SNP runtime can now enable shared-everything threads (SET) and
64-bit component memory. Both features are proved by executing a probe, not
by inspecting `--help` or setting a scheduler flag. An unpatched runtime
advertises neither feature.

`build-set-runtime.sh <new-directory>` builds the existing Enclave patch stack
at upstream commit `ac0772970b9ad2cd53866d95db69e26311fe3b75`. It excludes GPU
backend features and links only ordinary CPU system libraries. The output
retains the source, resolved Cargo.lock, patch hashes, compiler version, and
binary hash. Put its `bin` directory first on PATH when building the domain
release and running its guestd. Stock Wasmtime remains untouched.

`runtime-set.sh` measures each successful probe's marker into `/rt`. `dominit`
uses those markers to enable the corresponding runtime flags, inside the
existing unprivileged app process with its seccomp filter. JIT compilation
remains inside the guest, the compiled-code cache remains disabled, and SET's
epoch cancellation remains enabled. No host GPU device or new network path
is granted. guestd advertises the probed capabilities; the supervisor refuses
threaded/memory64 work on an older legacy guest image during release migration.

## Validation on 2026-09-27

- guestd Go suite passed, including capability default-denial and release scope.
- 15 SET manager tests passed.
- dominit hardening suite and its negative mutants passed.
- Real worker/atomic/futex probe and 64-bit canonical-ABI string-copy probe passed;
  missing and bogus runtimes were rejected.
- A threaded HTTP canary spawned and joined four pthreads for each of ten
  requests inside an actual SNP guest.
- RISC Box **0.6.54**, fetched and CID-verified from its published artifact,
  started in another SNP guest; its web interface returned HTTP 200 on ten requests.
- Both guests passed trusted verification against independently reconstructed
  launch measurements, AMD's signature chain and the configured TCB minimum.
  The verified TLS key was pinned before requests. Runtime W^X and installed
  seccomp were checked at attestation. These are specific checks, not a proof
  that the complete runtime has no vulnerabilities.

Final test domain release:
`ce2eab70bc755ef102b57fa9dcb6e00104c23419397a32b7017b4be1a2c64c9f`.
Machine-readable results are in `evidence/set-runtime-2026-09-27/results.json`.
The tests used no owner secrets, customer wallet or production deployment.
The RISC Box web interface was tested; booting the customer's stored OS image,
SSH, GameStream, GPU offload, and its production config were not exercised.

## Production rollout still required

This is a new measured runtime release, not a hot edit of existing images.
Publish and admit its complete domain release, install its matching guestd
and supervisor, and handle existing guests under their original runtime pins
before moving them. A naive switch from the global runtime-48 pin to runtime-49
would reject the existing guests during adoption; do not perform that switch.

The complete declared HTTP/TCP/UDP port set is now implemented by the protected
port tunnel described in [PROTECTED-PORTS.md](PROTECTED-PORTS.md). It passed
real SNP hardware tests. The owner's isolation opt-in and attested config/secret
release must also be in place before the production deployment is eligible.
