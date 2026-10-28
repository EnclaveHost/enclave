# Root review: termination pause candidate, not installed

Eleven offline checks passed with zero skips: seven author fixtures and four independent root cases. The generator was read before execution and independently matched all eight input hashes to the previously qualified six-USDC candidate. Only migration.mjs changes; seven other modules remain byte-identical. The tests use scripted chain/HTTP responses, a memory store and public test data. Their signature bundles are fixture objects, not native wallet signatures. This is not native/browser/production qualification.

The added pause is included in the reviewed terms hash. Full-plan signature digests are required before the original termination. The durable pause is recorded atomically with the exact-refund proof; reload/reconcile/rearm do not clear it. Resume records reviewed activation evidence, requires live successor intake and a final termination proof, and sends nothing. Independent tests reject a wrong USDC refund, a nonfinal termination, a missing durable marker, and a termination proof lost after resume. Existing proof/reorg/unknown-send checks remain.

Author REPORT.md is preserved as source material, not an approved operation plan. Corrections:
- The current gateway cannot permit only this owner/SID termination. Its path-only gate does not authenticate or parse bodies. An exception for /owner would permit every operation on that route. Do not claim a selective barrier.
- No neutral/cancel/replacement transaction is authorized or required by this review. Unknown nonce outcomes remain quarantined pending reconciliation; no resend, nonce jump, unrelated wallet or extra funding.
- A termination receipt is a relayer nonce prefix, not proof the old process has drained. Late preflights and RPC-held transactions require the explicit stop-and-reconcile runbook.
- Current funding-config response is genuinely HTTP404/not_found, not funding_disabled. The frontend must preserve that fact and use only a reviewed explicit preparation mode, with null intake and full chain checks. It must never fake enabled intake or relabel an active runtime.
- A failed cutover may require a separately reviewed recovery flow to restore the legacy session. The API authority is temporarily unavailable after termination until replacement is proven; do not promise uninterrupted session availability. Funds remain in the owner wallet only to the extent established by exact receipts/current chain state.

No owner request is ready: the site integration, actual browser cutover test, immutable startup write-quarantine, full operational reconciliation/rollback and final live proposal/runtime/fee checks remain. The 24/4.8/1.2 split is a candidate, not human-approved. Original $30 is untouched; no production source, gate, service, grant, nonce or money mutation occurred.

Checks ran under the shared 256MiB lane, 220MiB inner RSS guard, 27648MiB host floor, one CPU/no swap. Author-run outer peak199MiB, root-run187MiB; no guard stops. Native/browser fixtures must additionally cover lost termination response and concurrent reload/admission before production.
