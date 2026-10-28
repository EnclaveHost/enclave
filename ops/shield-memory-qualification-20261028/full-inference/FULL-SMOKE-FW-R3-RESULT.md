# Correct graph selected; cold request ended at client timeout

A passed fresh attestation with runtime/TCB/seccomp/pinned-key and replay checks. The correctly named graph request ran60.35s, then the client exited1 without an HTTP response or tokens. The baseline guest sampled peak rose to48,248,758,272bytes. No serial capacity-decline line appeared. The front logged GET unreachable when the request ended. B was not run; cleanup clean.

The original client hardcodes a60,000ms socket-idle timeout in `request`; the harness900s outer deadline cannot override it. Stderr was discarded by the harness, so a timeout is strongly consistent with timing/source but is not directly established by a retained exception. Do not claim successful inference or a memory/GPU failure.

The next isolated client derivation will change only application idle timeout to840s, retain60s attestation timeout, preserve all trust gates, and record bounded errors separately from parseable stdout. The outer900s request and1260s arm watchdog remain. No production client changes.
