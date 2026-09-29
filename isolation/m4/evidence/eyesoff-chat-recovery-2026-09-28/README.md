# Eyesoff chat recovery — 2026-09-28

User report: mobile chat returned “Failed to fetch”. The same example prompt
was reproduced through the signed-in desktop browser and failed with a network
error. The guest app exited with status 137; replacement guests temporarily
served their bootstrap certificate until new WebPKI issuance completed.

The preceding prefix-cache rollout increased native sequence capacity from
16 to 22 (8 active + 6 conversation + 8 shared-prefix states). The 60 GiB guest
floor did not leave sufficient headroom for startup caches plus real MTP chat.
Warmup-only checks missed this. Preserved logs show repeated SIGKILL/status137
exits; no explicit kernel OOM report was available. The post-fix workload used
62.82 GiB at the QEMU-unit level, beyond the prior 60 GiB guest plus 768 MiB unit
allowance. That, together with stable completion after increasing RAM, supports
memory exhaustion as the cause; it is not a claim that an OOM counter was read.

## Fix

- Raise the 27B private guest memory floor from 61440 to 73728 MiB.
- The host manager advertises and reserves that floor, including QEMU overhead.
  Admission refuses pools that fit only the old reservation.
- Install guestd.7b9d2b66 and raise the configured total guest budget from 80 to
  88 GiB so this guest and the five existing apps fit. Keep the physical-host
  16 GiB availability floor and 24-vCPU pool budget.
- Restart only Eyesoff. All five other running guest IDs were adopted unchanged.
- No app version, config, shares, measured runtime, MTP, mask profile, or
  certificate/attestation checks were changed. No wallet transaction required.

## Validation

Contract and full guest-manager tests passed. Both public domains passed
fresh AMD attestation/TLS-key binding plus WebPKI and returned HTTP 200.
The custom domain's first CA authorization stalled; its existing fallback
issued a Let's Encrypt certificate normally. No TLS validation was bypassed.

A real chat was submitted while startup warming was still active, reproducing
the previous failure conditions. The exact user example completed with 823
tokens at 15.9 tok/s; its follow-up completed with 54 tokens at 16.4 tok/s.
MTP stayed enabled, startup warmup completed, and the guest remained running.
These are observed smoke-test rates, not a new throughput benchmark or an
eight-chat concurrency qualification. Memory observation and concise results
are recorded in results.json.
