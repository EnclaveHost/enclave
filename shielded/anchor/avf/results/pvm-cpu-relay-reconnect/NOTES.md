# Reconnect in place through the REAL relay on the Pixel 10 (2026-09-25 11:33Z-11:54:57Z): attempt 3, at 204f36bb

**LAB, not production.** The code is 48030dd5 (design reviewed by enclave-99, who gave the go for this run). The harness
got two setup fixes after it: c6e47492 and 204f36bb. Attempts 1 and 2 stopped on those harness errors before anything
ran; they are kept in `-run1` and `-run2`.
- **The chain:** a LOCAL anvil chain (id 31337, a block every 2 s) with the real contracts. No Base, no funds.
- **The operators:** two fresh random keys (the owner's and a "wrong operator"), held in memory only. The run's own scan
  found neither in the results. Registration values are synthetic lab values.
- **The relay:** a LAB relay process on 127.0.0.1:18443, started 9 times, each from an allowlisted environment
  (relay-env.jsonl), with a scratch cwd outside the repository and `PVM_SERVING` on in this lab process only. The
  production relay and its settings are UNCHANGED.
- **The phone:** the owner's authorized Pixel 10, over adb, running APK `955d7ebb…` (code hash `15d9f8c7…a76a`, TEST
  authority), built from 48030dd5's payload and host with app data kept. **ONE VM boot for the whole run:** one `ANCHOR
  start`, one transport key `…3d2852379867a1b8…`, the owner's out-of-band instance `ccd79db1…`, the same proof key
  `0xa91a5300…`.
- **The co-signer:** the phone's co-signer URL pointed at a harness proxy. The proxy answered as the owner's co-signer,
  as "down" (the connection dropped), as the WRONG operator's co-signer, or with a STALE owner signature from an earlier
  nonce.

## Steps (43 of 43 as expected; steps.jsonl)

- **A, boot:**
  - an unregistered attach; the row: tier pvm-cpu from the boot self-test, not eligible;
  - the bootstrap statement through `/t`; register; claim; `/x`; a proof; the client served as bound;
  - the phone's reconnector armed once the app served.
- **R1, three relay drops** (down about 10, 14 and 18 s). Each time:
  - the RUNNING VM re-attached in place (`REATTACH <nonce>`, a new certificate, the owner's co-signature), 3 to 15 s
    after the relay returned;
  - one row, with no tier (by design);
  - the client served as bound, and a proof landed.
- **R2, a frozen relay** (SIGSTOP: half-open, no FIN):
  - the phone's silence watchdog gave up on the tunnel after 94.4 s (RelayAttach.SILENT_MS = 95 s);
  - after SIGCONT, the VM re-attached in place, and the relay held exactly ONE tunnel ("(1 enclave)") and one row.
- **R3, one drop, then the co-signer proxy's answers in turn.** The hub refused, in order:
  - no operatorSig (co-signer down);
  - "registered on chain to <owner>, not <wrong operator>";
  - "registered on chain to <owner>, not 0x…" (the stale signature recovers to someone else over the new nonce).
  Then the owner's co-signature was accepted in place. The harness replayed that ACCEPTED attest frame (certificate and
  co-signature for nonce N) on a fresh connection N': refused, "attestationChallenge does not match ours", and the live
  tunnel was undisturbed. The client was served as bound.
- **R4, exactly once across a drop:**
  - The relay was stopped and a tick ran: the proof was `carrier-failed` and no checkpoint was signed. A due HEARTBEAT
    went out in that tick: an owner-side call that needs no VM, as designed.
  - The relay came back, and the VM re-attached in place.
  - R4-pre: a normal proof, with no lifecycle call due.
  - A checkpoint was journaled and signed but never delivered, and the agent stopped. The relay was dropped and
    restored, and the VM re-attached in place.
  - The restarted agent delivered the SAME transaction (`0xa801e1cb…`) once, and it landed.
- **R5:**
  - a relay admitting only the OLD build (`58ec3675…`) refused the in-place attach on its build ("no APK component with
    an allowlisted codeHash") and attached nothing;
  - the right relay accepted the attach in place;
  - the row has no tier, is not eligible and not serving, and `/v1/enclaves` answered 503 (no serving enclave).
- **D:** a final proof landed, then the lease was released. Still one boot, and 8 in-place re-attaches.

## Result: `check.txt` PASS (runtime/conformance/check-relay-reconnect.mjs)

It re-derives the facts from the run's own records:
- **One boot.** The running VM answered every REATTACH: 12 begun and ended = 8 accepted in place + 4 refused by the hub
  (R3's three, R5's old build) + 0 without a certificate. The phone's 17 failed dials (relay down) sent none.
- **Never two live tunnels on the phone:** every in-place acceptance follows exactly one loss.
- **Every owner co-signature (10) re-verified offline:**
  - the rad under the build, authority and Google's roots, over its own nonce;
  - the BOOT transport key in every one;
  - the instance proof over THIS transcript;
  - the operator signature recovering to the owner.
- **The co-signer's record:** no nonce co-signed twice, and the journal holds exactly those 10. The proxy's down, wrong
  and stale answers came once each, and the stale one is an earlier owner signature.
- **The relay's record:**
  - every attach of the name left exactly ONE tunnel;
  - R3's refusals came in order, with only the replay refused after the attach;
  - the old-build relay attached nothing.
- **Statements (5) and checkpoints (8)** re-verify. The carrier was the bootstrap route before the lease and `/x` after.
- **The client** was served as bound at boot and after every checked re-attach.
- **The rows:** never two at any sample; the tier at boot only.
- **The chain:** every Checkpointed event is a journaled landing; the undelivered checkpoint landed once; nothing was
  signed while the relay was down; released once, after the last proof.
- **The attestation cost:** every attestation chain in the run (15) hangs off ONE provisioned AVF key.

test/pvm-relay-reconnect-checker.test.mjs mutates this run 25 ways, and each must fail at its own check (26/26 including
the unmutated PASS).

The first checker version failed ONE check on this run, and the record was right. The R3 relay log holds a fourth
refusal: the harness's own replay, run on that relay after the attach. The rule is now positional and stricter: exactly
the three refusals, in order, BEFORE the in-place attach, and exactly one refusal AFTER it, the replay's. The REATTACH
accounting was also made exact, where it had been "at least".

## What this shows, and what it does not

**Lab end-to-end:** on one Pixel 10 and one VM boot, with the real relay code and the real contracts on a local chain:
- the runner survives repeated relay drops and a half-open relay, and re-attaches IN PLACE each time, with a fresh
  relay challenge, a fresh certificate over the VM's own transcript, a fresh instance proof and the owner's fresh
  co-signature;
- the owner's instance and build pins are unchanged, and never two tunnels are live;
- stale, wrong and missing co-signatures and a replayed attest frame are refused;
- a pending proof is delivered exactly once across a drop.

**Not restored in place: the pVM CPU tier.** The relay admits the tier only from a self-test AFTER an attach, and the
engine runs its self-test once, at start. So a re-attached row routes (`/t`, and `/x` for its own leased deployment's
pvm kinds) but carries no inference-lane tier until the VM restarts. This is by design (reviewed); the relay's policy is
not relaxed.

**Not shown:**
- nothing on Base, on the production relay, or with real keys, entries, leases, prices or payout addresses;
- not a Pixel 11, and not several app VMs at once;
- the relay's `/x/<D>/pvm` resolver is still the shared `runnerEndpointOf` here. enclave-99's eligibility patch (on
  another branch) will leave pvm-serving to its own resolver, which is the next change on this branch.

**Production still needs** (the owner's and the relay owner's; none of it is invented here): everything listed in
results/pvm-cpu-relay-route/NOTES.md and RUNNER-AGENT.md "What production still needs". That is: the operator key and
fee cap, the register values, the lease choice and bond ceiling, the payout, the owner's out-of-band instanceIds, the
co-signer channel, the production relay's `PVM_SERVING` / `METAL_AVF_*` / `PVM_CPU_*` / `PVM_APP_*` /
`TUNNEL_PUBLIC_ORIGIN`, and the client's production policy and release keys.
