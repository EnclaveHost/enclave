# Original owner serving commit: actual qualification

Production RPC remains OFFLINE. The full decentralization objective is unachieved.

The maintained original owner accepts canonical `enclave-rpc-serving-commit/1` through its existing framed stream. First commit requires its live prepared response hash, the SHA256 of the actual prepared private observation, the CURRENT continuation sequence/link, refreshed original authorization and both the original startup and short preparation windows. No receipt reconstructs the live capability. The exact commit intent is consumed before refresh/signing; exact dual-signed continuation bytes are persisted before reply. Renewals use the same prepared/observation binding and exact next chain link with strictly advancing absolute expiry. Startup regression, replay, cancellation, short/lost response and all errors poison the original session; no new export, reconnect, writer release or chain transaction follows.

The owner watcher now reads a coherent immutable atomic phase/cutoff record. Startup remains bounded by the original deadline. Serving commit changes only this actor's cutoff to the accepted short monotonic permit. The watcher cancels independently of the signing/persistence mutex; the existing owner command's independently armed os.Exit on context loss remains unchanged. Bounds are checked before and after publication and previous expiry is never reset. The owner's host clock is not compared with guest kernel time; measured guest freshness enforcement remains necessary.

The actual Python dispatcher forwards the explicit commit and renewals on the SAME original stream. It checks its live prepared hash, original observation digest and current sequence/link; before acknowledgement it requires both the exact consumed owner commit intent and exact continuation proof in the original journal. Its original 900-second deadline, 90-frame count, unit limits and 3-second exchange remain unchanged. It is transport, not an independent signing authority.

## Actual evidence

Invocation c68cb4529e144b8395ef50050860be89 completed status 0/MainPID 0/empty cgroup. 66 PASS = 56 Go test/subtest records (15 top-level) plus 10 Python dispatcher tests; no failure. Whole 9.46875013411045 seconds including actual owner binary build. All 832 frozen and maintained pins matched at execution. Post-test changes correct README/READINESS status only; FINAL-SOURCE-PINS records delivered files. Executable/test source is unchanged after qualification.

Tests use actual original Go issuer/dual Ed25519 verification/private persistent fixture journals/framed pipes; chain authority, exporter and native environment are fixtures. They cover commit/renewal after original startup, current chain advancement after preparation, independent serving expiry with the operation lock blocked, late blocked commit refusal, exact persisted response/intent, substituted/missing/stale preparation, observation mismatch, sequence/replay/conflicting journals, startup regression, cancellation, EOF and short-write ambiguity. Python uses real pipes and the maintained relay/dispatcher with a stub signer and mocked systemd/export. It checks commit and renewal through one signer/export, and refuses wrong preparation/observation or missing durable owner intent.

These results do not prove actual native owner death, hardware attestation, full transport survival after startup, exporter handoff, writer settlement or production RPC readiness.

Limits: 512 MiB hard/450 MiB RSS/one CPU/no swap/150-second outer/120-second composition/5-second stop. Authenticated admission 93640 MiB available, actual pending 0, installed floor 18432; retained 27648 plus 640 MiB. Inner peak 153, outer tree peak 286, minimum host available 93543 MiB. No cap/floor/timeout relaxation or reuse of the completed 1.5 GiB firmware build exception.

Private owner binary independently rehashed: 10915666 bytes, SHA256 38c878c500aa72095acd92abd56f04e4f181d0f43e0af11268eec41d863260b1. It is not deployed or included in Git. No keys, private journals, cache or media are included.

## Remaining work

The broker still does not emit serving requests or guardian COMMIT/RENEW. Complete its transaction with current original owner/exporter authority and the service/host guardians before originalD; coordinate the exporter, broker, operator/systemd/TLS and Windows cutoffs with independent short expiry/loss controls. Do not boot this partial composition or mix older firmware. Target admission, accepted platform, original production owner journal/chain and all prior writer settlement, real NBD/verity/full-stack fit/sync/finality and consumer cutover remain unproven. Original 8091, live catalog, funds, ambiguous Windows attempt and private records were unchanged.
