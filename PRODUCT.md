# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: deployers — privacy-conscious people (and, on equal terms, AI agents) who hold a wallet, browse the catalog on enclave.host, fund a deployment, and use the running app (private LLM chat, image generation, game servers). They come because they need compute on data they refuse to show a provider, and they judge the product by whether that promise is credible and effortless.

Secondary: developers/publishers who build `wasi:http` Wasm apps and publish them to the on-chain catalog for per-hour fees. Tertiary: hosts/operators who register TEE hardware and earn by claiming work. Design serves the deployer journey first; developer and host paths stay one click away, never in the way.

## Product Purpose

Enclave (enclave.host) is a trustless compute platform: apps run inside hardware-attested enclaves that neither the operator nor the host machine can see into, paid per second from a wallet on Base. It exists so that using powerful software on sensitive data does not require trusting whoever runs the hardware. Success means deployments funded and running by strangers who verified the claim rather than took it on faith.

## Positioning

Lead claim (user-confirmed): **compute that cannot see your data** — the privacy outcome itself. TLS terminates inside the enclave; the operator, the host, and Enclave itself are blind to workload contents.

Supporting mechanisms (never lead, always available as proof): the full chain of trust is verifiable client-side in the browser before a byte is sent (CPU attestation quote → measured image → Sigstore-logged release → this repo's commit); access is wallet-native ("If it can sign, it can compute." — no accounts, no KYC); the marketplace is non-custodial and on-chain (catalog, per-second billing, publisher fees forwarded trustlessly).

## Operating Context

The site is a static, IPFS-published app (LWC-style web components, soft-nav router) at enclave.host: catalog browsing, wallet connect (passkeys + SIWE), Stripe Checkout for credit, deploy console, dashboard with live provisioning output and in-browser attestation checks, host console, developer docs with OpenAPI reference. Deployed apps serve at `https://<id>.app.enclave.host` or on customer domains with certificates minted inside the enclave. The same platform is driven by the `enclave` CLI and by coding agents via the MCP server at mcp.enclave.host — agents are first-class users, not an afterthought.

## Capabilities and Constraints

Capabilities: Wasm (`wasi:http`) apps from the on-chain catalog; GPU inference via `wasi-nn` (GGUF/llama.cpp, ONNX, stable-diffusion) on fractional GPU slices; attested read-only model volumes; raw TCP/UDP behind an SNI relay; per-deployment dedicated IPv6; deployment secrets; encrypted volumes; per-deployment WAF; USDC (EIP-3009) and ETH funding, metered per second, self-serve cancel refunds the contract-held remainder; custom domains; Android shell app with QR pairing.

Constraints future work must respect: the site is static — no server-side rendering or per-user backend for site pages; inline scripts are CSP-hash-synced at deploy (a stale hash silently blocks a page's script); long LLM responses must stream (non-streaming dies at ~180 s at the proxy); the platform never takes custody of user funds; contract changes are effectively frozen by the EIP-170 size wall and one-shot governance, so product promises must not assume cheap on-chain iteration.

## Brand Commitments

- Name: **Enclave**; the site and product are always referred to as **enclave.host**. "Enclave Host, Inc." is the legal copyright holder only, never the brand.
- Slogan: **"If it can sign, it can compute."**
- Marketing copy never names hardware or TEE tech (no "H200", no "SEV-SNP" in marketing surfaces; specifics live in docs/verification, where they are proof).
- No human-only framing anywhere — copy must read correctly when the customer is an AI agent holding a key.
- No em dashes in user-facing copy.

## Evidence on Hand

- **eyesoff.ai** (user-confirmed citable): a production llm-chat deployment on a customer-owned domain, certificate minted in-enclave, proven end to end 2026-07-30 and soak-tested. This is the case study design may name.
- The catalog's published apps and running fleet exist as product facts, but were not confirmed as marketing evidence; cite them descriptively, not as social proof.
- Absent, and never to be implied or invented: testimonials, named customers, press coverage, public benchmarks.

## Product Principles

1. The privacy outcome leads; the mechanism supports. Say "cannot see your data" before any word of attestation vocabulary.
2. Never ask for trust the user could verify: every claim should sit one click from its live proof.
3. Deployer journey first: browse → fund → use, with a wallet as the only identity.
4. Anything holding a key is a customer — human or agent; no flow may assume a human.
5. Real proof only: name eyesoff.ai or stage live verification; never manufacture social proof.

## Accessibility & Inclusion

WCAG 2.1/2.2 AA is the established baseline: axe reports zero violations on the documentation pages, enforced by a do-not-regress token set and an axe harness. New surfaces inherit this bar.
