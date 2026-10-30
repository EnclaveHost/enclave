# Completed stream cleanup

The native desktop compute service opens a worker stream for each graph job.
The supervised Hyper-V bridge also carries its long-lived control connection.
Previously, after both byte copies had finished, the guest-to-worker thread
could remain asleep for five seconds before returning. Its admission slot
remained counted until that thread was joined. With a 64-slot bridge, 63 rapid
completed graph streams plus the control stream exhausted admission.

`bridge_relay.rs` replaces this completed-copy polling delay with an immediate
notification. The five-second poll remains only for checking the existing
120-second half-closed idle limit when the downstream copy is still active.
The change preserves half-close/drain behavior, byte ordering, partition checks,
bridge authentication, stream caps and masking/verification in the guest.
It does not reset a retired compute service or authorize reconnecting a lease.

Validation on October 27, 2026:

- The original relay fails the completed-stream cleanup regression.
- Three Rust relay tests pass with the fix: prompt cleanup, an exact 4 MiB slow
  reply after guest half-close, and 80 repeated credential-prefixed streams.
- The Node relay/authentication/desktop-worker suites pass (23 tests).
- On NucBox, `bridge-churn-check` uses Hyper-V loopback and an isolated echo
  worker, keeping one resident stream while issuing 128 short requests. The
  original bridge fails at 63/128; the fixed bridge completes 128/128.
- `bridge-drain-check` receives every byte of a 4 MiB slow Hyper-V reply.
- `bridge-auth-check` passes credential ordering and startup-refusal checks.

Build/test binaries were staged in an isolated development directory. The live
bridge and shared services were not replaced or restarted. Deployment must
update the pinned bridge executable/digest and the authenticated desktop config
through the existing procedure. An already-retired desktop compute service
still requires a fresh trusted process; this fix is not an in-place reset.

Run portable regression coverage with:

```
node --test --test-concurrency=1 test/windows-bridge-relay.test.mjs test/windows-shield-local-auth.test.mjs windows/vbslike/manager/desktop-worker-transport.test.mjs
```

On a Windows Hyper-V host, run the three checks against a separate candidate
executable and unused loopback service ports. Never repoint a live production
worker or disturb a deployment's existing lease for these tests.
