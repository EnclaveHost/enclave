# Production MTP on/off comparison

MTP improved warm decode by **17.85%** in this paired production test:
17.2–17.3 tok/s with MTP versus 14.6–14.7 without. Leave MTP enabled.
The >=20 tok/s target remains unmet.

Both modes ran through the real Eyesoff `/chat` endpoint, with the same
3,781-token prompt including tool definitions, 384-token output limit,
temperature zero, model, Enclave Shield runtime and 1380 MHz GPU clocks.
Only the model's `draft` setting changed (`"mtp"` versus `null`), through
owner-signed deployment updates. Each side started a fresh guest, verified
its AMD attestation and public TLS certificate, processed one cold prompt,
then ran two serial warm repeats. Prefill reuse took 0–1 ms. Both warm-run
decode times are included in the aggregate rate; no best-run selection.

All six completed outputs are byte-identical (SHA-256 recorded in
`results.json`). MTP proposed 218 tokens and accepted 166 per run. The
disabled path used ordinary feed verbs and reported no drafting activity.
There were no tool-discovery notices or failed completed runs. An initial
browser request before certificate issuance failed and was retried only
after ordinary public WebPKI validation passed; it generated no tokens.

Cold prefill was slightly slower with MTP: 250.0 seconds versus 242.0.
Thus the decode speedup does not imply lower cold end-to-end latency.
This is one prompt on a shared production host, with two warm repeats per
mode. Earlier measurements on a long-lived guest with other cached histories
were slower and are retained separately; using them against the fresh
MTP-off guest would conflate MTP with cache state.

The original owner configuration was restored exactly. The final running
Eyesoff guest is `gdce7361bc`, with MTP enabled, one draft per round and
`draft_p_min: 0`. All masking, verification and isolation settings remain
unchanged. No inference code was modified for this comparison.
