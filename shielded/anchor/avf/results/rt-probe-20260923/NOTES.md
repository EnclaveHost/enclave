# The portable runtime inside the Pixel 10 pVM: conformance PASS (2026-09-23)

`payload/rt_probe.c` + `runtime/pvm-rt` (wasmtime =49.0.0, Cranelift -> Pulley, built for aarch64-linux-android) in a
protected VM (`vm run-app --protected --debug full --cpu-topology match_host`), running the conformance component
`runtime/conformance/bundles/hello-v1.wasm` (sha256 faaf2071...) under its pin from the measured APK.

run2 (1,536 MiB): `runtime/conformance/check-probe.py run2-1536mib.console.txt` -> **PASS conformance in the pVM**:
- identity `{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}`
  (the isolation contract's admissible pVM vector);
- every case's stdout byte-identical to the reference (the host's wasmtime 48.0.1, Cranelift JIT to x86-64), exit codes equal;
- a pin one bit off: refused before compilation; a 512 MiB allocation under a 64 MiB limit: stopped; a spin under a 500 ms
  epoch deadline: interrupted;
- 0 writable+executable mappings before and after (the platform also refuses to create one: results/jit-probe-20260923).
Compile in the VM: 2,002 ms cold (first engine use), then 179 and 64 ms; the primes case ran in 245 / 42 ms.

run1 (512 MiB): the first compile aborted in the allocator (`Scudo ERROR: internal map failure (Out of memory)`); the
checker FAILs it. The runtime's memory need in a small VM is open (wasmtime's growth reservation is the first suspect).
