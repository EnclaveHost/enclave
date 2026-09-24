# Milestone 2 on the Pixel 10: the component from outside the APK, run by the pvm-cpu payload (2026-09-23 21:05)

Build rt4 (`anchor-pvm-cpu-rt4.apk`, sha256 `586d32ee…`, protected, pvm-cpu tier; branch pvm-cpu/portable-runtime).
`cpu/app-run.sh` pushes `runtime/conformance/bundles/hello-v1.wasm` (sha256 `faaf2071…`) into the app's files -- NOT into the
APK -- and launches `--es mode app` once per vectors.json case, plus once with the app's test hook announcing a digest that
is not the component's. The payload receives the bytes on APP_PORT, pvm-rt verifies them against the APP line's digest and
compiles them to Pulley inside the VM. `runtime/conformance/check-app.py results/app-m2` -> **PASS** (check.txt):

- every case: the protected pvm-cpu payload, the contract's runtime identity, stdout byte-identical to the reference
  (the host's wasmtime 48.0.1, Cranelift to x86-64), the exit code equal, the capture complete;
- the wrong announced digest: `APP refused: bundle sha256 faaf2071… is not the expected 0000…: refusing to compile`, and
  nothing ran or printed.

Compile in the VM 900-965 ms (a fresh VM each launch, so every compile is cold), run 19-283 ms.

Each capture also holds the run's ABI/2 app attestation (`ABI2 *`, `ABI2_LINK*`; milestone 5, results/app-m5).

**Superseded (21:32): results/app-m2c.** This run's bad-digest capture shows the gap the audit found: an ABI/2 certificate
(`ABI2_LINK*`, AppID 000…0) was requested before the digest check, for an app the VM then refused. `check-app.py` now fails
that case; `ABI2_BEFORE_DIGEST=1 check-app.py results/app-m2` reproduces the verdict recorded in check.txt. The captures
are kept as recorded.
