# Eyesoff first-token latency, 2026-09-29

Candidate work; not deployed as of this record.

## Measured baseline

Real authenticated browser POST /chat, 1.0.68, 27B MTP, Loop and configured tools enabled, 64-token bound:

| Probe | Headers | Tool discovery | Prefill | First streamed delta |
| --- | ---: | ---: | ---: | ---: |
| New test prompt | 3022 ms | 2130 ms | 510 ms | 5881 ms |
| Exact repeat | 439 ms | 1885 ms | 1 ms | 2558 ms |

Prompt length was 3769 tokens. Decode remained ~15–16 tok/s in these short probes. First delta includes reasoning; it is not necessarily the first visible answer word. Initial network setup varied, so these two rows are observations, not a statistically controlled comparison.

## Transport candidate

Each outgoing WASI HTTP request previously established a new TLS connection. Opt-in `ENCLAVE_HTTP_POOL=1` keeps up to 16 idle connections (2 per origin), with 120-second idle expiry and 600-second maximum age at reuse. A 30-second reaper closes unused expired connections. Live streaming responses are not interrupted at these limits.

Only the runtime belonging to one isolated app enables reuse. The process-wide egress identity and destination policy are immutable. Every new connection uses the existing SOCKS/SSRF and TLS verification path. Every HTTP request sends its own credentials; responses and tool registries are not cached. Fully consumed successful bodies may release their transport; incomplete/error/timeout/Connection-close bodies discard it. A failed send is never replayed.

Native tests cover header/response separation, origin separation, server close, incomplete bodies, body timeout, failed POST non-replay, and existing TLS server-name parsing (6 tests total). The standalone native test harness substitutes only the egress dial; the full Wasm integration below uses the real runtime implementation.

The built runtime served the existing api-mcp-adapter Wasm locally, whose synthetic tool fetched the live adapter's public page. No production credentials or model work were used. Direct transport repeat calls dropped from 1702–1765 ms to 380–387 ms. The authenticated SOCKS integration produced 1737–1755 ms unpooled and 398–403 ms pooled. All 8 SOCKS requests succeeded using exactly 5 authenticated connections: 4 baseline and 1 pooled. These are transport measurements, not yet production chat improvements.

The runtime build leaves ggml.rs and prefix_claims.rs byte-identical. The candidate release changes only template/init and template/rt/wasmtime. It preserves the deployed GPU libraries, masking, MTP, model, and resource settings.

## Authenticated warmup candidate

Startup/browser warmup previously omitted the verified caller. The MCP adapter therefore omitted identity-dependent tools, yielding a different prefix from authenticated chat. 1.0.69 passes verified identity from request credentials through warmup, sends browser credentials on both warmup paths, and prepares again after popup sign-in. Anonymous boot probes stay anonymous. Settings cannot inject identity or conversation contents.

216 Rust and 9 browser tests passed. The application was built with nightly-2026-07-25. Publication/activation require the owner's hardware-wallet signature. Activation must wait for independent prediction of the new app/runtime pair, then preserve the 72-GiB guest floor and other guests. Verify real MTP chat and first-token timing after rollout, not only warmup responses.

## Additional local model validation

Using the actual candidate runtime/app with the small 0.5B CPU model and a local MCP fixture: anonymous warmup prepared 344 tokens; a spoofed caller in settings stayed anonymous at 344; a verified synthetic sign-in exposed the authenticated 578-token prefix. Its first warmup cost 1480 ms and repeat cost 0 ms. The following real authenticated chat had 589 prompt tokens and 36 ms prefill, demonstrating reuse across the warmup-to-chat path. Synthetic signer credentials were generated in memory and never saved. This validates behavior; it is not a 27B production latency claim.

The candidate manager configuration's read-only adoption check accepted all six current guests, including Eyesoff. Runtime files and additive release pins are staged on the independent verifier; its live process has not been restarted yet. Production remains on release 4f6fcd61 and app 1.0.68 pending publication and independent prediction of the candidate pair.
