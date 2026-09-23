# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: deployers, privacy-conscious people and, on equal terms, AI agents, who hold a wallet, browse the catalog on enclave.host, fund a deployment, and use the running app (private LLM chat, image generation, game servers). They come because they need compute on data they refuse to show a provider, and they judge the product by whether that promise is credible, effortless, and honestly scoped to the host they land on.

Secondary: developers/publishers who build `wasi:http` Wasm apps once and publish them to the on-chain catalog for per-hour fees. Tertiary: hosts/operators who register hardware they own and earn by claiming work; confidential hardware sells the strongest tier, other machines are listed at the level they can prove. Design serves the deployer journey first; developer and host paths stay one click away, never in the way.

## Product Purpose

Enclave (enclave.host) is a verifiable compute platform: one portable app package runs on independent hosts, each host states the protection level it actually provides, execution is verifiable from the client, and the infrastructure is designed to depend on the company as little as possible. On confidential hardware the host machine and its operator cannot see into the app; on other hosts the listing says exactly what the owner can still see. Paid per second from a wallet on Base. It exists so that using powerful software on sensitive data does not require trusting whoever runs the hardware, and so that the buyer can always tell which guarantee they bought. Success means deployments funded and running by strangers who verified the claim rather than took it on faith.

## Positioning

Lead claim (user-confirmed): **compute that cannot see your data**, the privacy outcome itself. It is delivered on confidential hardware (the hosted fleet and self-hosted confidential servers): TLS terminates inside the enclave; the operator and the host are blind to workload contents. The hero states it and immediately scopes it: every other host is labeled with the protection level it provides, never assumed to share the lead claim. Copy must never say that all supported hosts cannot see data.

Four pillars, in this order, carry the story on the homepage (updated 2026-09-23): **portable apps** (one Wasm package across backends), **explicit protection** (levels stated per host: confidential, partitioned, plain), **verifiable execution** (client-side chain of trust), **independent infrastructure** (public contracts, content-addressed bundles, public source, independent hosts; the goal is to outlive any one company or domain, and the parts still on company servers are listed honestly).

Supporting mechanisms (never lead, always available as proof): the full chain of trust is verifiable client-side in the browser before a byte is sent (CPU attestation quote → measured image → Sigstore-logged release → this repo's commit); access is wallet-native ("If it can sign, it can compute.", no accounts, no KYC); the marketplace is non-custodial and on-chain (catalog, per-second billing, publisher fees forwarded without custody).

Status vocabulary (used identically on every page): **available** = a deployment can have it now on the hosted platform or a listed host; **experimental** = built and measured on a lab machine or one box, not selectable by a deployment; **planned** = designed or intended, not built or not run. Anything from the isolation research (M1 to M4), the cross-backend domain contract, the Windows partition-per-app backend, shielded inference, and phone-anchored hosts is experimental or planned until newer evidence says otherwise. M4a (one SNP guest per app) is measured and independently rechecked as of commit 773a7450 (2026-09-23): the recheck re-derived both AppIDs and all three launch measurements from the saved evidence, verified the adversary's report through the real AMD chain, refused seven negative fixtures, 14 PASS / 0 FAIL. It proves exactly one confidential guest per app and nothing in the product starts one. M4b (app-naming authority in the measured SVSM, one VMPL plane per app, capped at 2 to 3 apps per guest) is in progress and unmeasured.

## Operating Context

The site is a static, IPFS-published app (LWC-style web components, soft-nav router) at enclave.host: catalog browsing, wallet connect (passkeys + SIWE), Stripe Checkout for credit, one-click deploy from an app's card, dashboard with live provisioning output, per-deployment settings tabs (config, model volumes, protection, relay, secrets, domains) and in-browser attestation checks, host console, an architecture page (protection levels, verification, research status, independence, the status board), developer docs with OpenAPI reference. Deployed apps serve at `https://<id>.app.enclave.host` or on customer domains with certificates minted inside the enclave. The same platform is driven by the `enclave` CLI and by coding agents via the MCP server at mcp.enclave.host — agents are first-class users, not an afterthought.

## Capabilities and Constraints

Capabilities (available): Wasm (`wasi:http`) apps from the on-chain catalog, run on the confidential Linux fleet and, interpreted, on the Windows enclave node; GPU inference via `wasi-nn` (GGUF/llama.cpp, ONNX, stable-diffusion) on fractional GPU slices inside the confidential VM; attested read-only model volumes; raw TCP/UDP behind an SNI relay; per-deployment dedicated IPv6; deployment secrets; encrypted volumes; per-deployment WAF; USDC (EIP-3009) and ETH funding, metered per second, self-serve cancel refunds the contract-held remainder; custom domains; Android shell app with QR pairing; self-hosted confidential servers (metal); free self-hosting of your own apps.

Protection levels the copy may name: **confidential** (SEV-SNP CVM, host excluded, attested; GPU in CC mode where present), **partitioned** (the Windows enclave node: owner's software excluded, owner not; no RAM encryption; traffic and TLS key on the host side; development tier; and, in the lab only, one Hyper-V partition per app with the host inside the trust boundary), **plain** (ordinary virtualization, app separation only, planned, no host listed). Physical attacks on the memory bus are outside what confidential CPUs defend, and the site says so where it matters (host page, architecture page).

Not to be claimed without new evidence: per-app hardware isolation in production; an attested monitor on the IGVM/M3b path (the launch digest covers SVSM and firmware, not the monitor image); M4a as shipped or as more than one-guest-per-app (it is measured and rechecked, not in the product); M4b as measured (in progress); hardware app-vs-app isolation at scale via planes (hardware caps it at 2 to 3 apps per guest); a confidential GPU host or a self-hosted server as currently attached unless the live fleet panel shows one (neither was attached on 2026-09-23; metal0 has been off since 2026-09-14); any public performance number for shielded inference or phone accelerators (each needs model, hardware, protection mode, conditions and checked evidence, and unstable numbers are omitted); permissionless hosting as open today (admission is by a measurement allowlist); Windows hosts as confidential or host-blind; native CreateEnclave as the Windows roadmap (the direction is the partition-per-app backend).

Constraints future work must respect: the site is static — no server-side rendering or per-user backend for site pages; inline scripts are CSP-hash-synced at deploy (a stale hash silently blocks a page's script); long LLM responses must stream (non-streaming dies at ~180 s at the proxy); the platform never takes custody of user funds; contract changes are effectively frozen by the EIP-170 size wall and one-shot governance, so product promises must not assume cheap on-chain iteration.

## Brand Commitments

- Name: **Enclave**; the site and product are always referred to as **enclave.host**. "Enclave Host, Inc." is the legal copyright holder only, never the brand.
- Slogan: **"If it can sign, it can compute."**
- Marketing copy never names hardware or TEE tech (no "H200", no "SEV-SNP" in marketing surfaces; specifics live in docs/verification and on the architecture page, where they are proof).
- Readiness is always one of three words, available / experimental / planned, and internal milestone names (M1 to M4b) never appear on the hero or in marketing cards; they live on the architecture page beside their evidence.
- No human-only framing anywhere — copy must read correctly when the customer is an AI agent holding a key.
- No em dashes in user-facing copy.

## Evidence on Hand

- **eyesoff.ai** (user-confirmed citable): a production llm-chat deployment on a customer-owned domain, certificate minted in-enclave, proven end to end 2026-07-30 and soak-tested. This is the case study design may name.
- The catalog's published apps and running fleet exist as product facts, but were not confirmed as marketing evidence; cite them descriptively, not as social proof.
- Isolation research evidence (isolation/DESIGN.md, isolation/m3/PLAN.md, isolation/m4/PLAN.md), the Windows partition backend (windows/vbslike/README.md) and the Windows node (windows/PARITY.md, windows/vbs/REPORT.md) are lab results on named machines; cite them with their limits, never as shipped. The claim-to-evidence record for the 2026-09-23 site refresh is docs/site-claims-2026-09-23.md.
- Absent, and never to be implied or invented: testimonials, named customers, press coverage, public benchmarks.

## Product Principles

1. The privacy outcome leads; the mechanism supports. Say "cannot see your data" before any word of attestation vocabulary.
2. Never ask for trust the user could verify: every claim should sit one click from its live proof.
3. Deployer journey first: browse → fund → use, with a wallet as the only identity.
4. Anything holding a key is a customer — human or agent; no flow may assume a human.
5. Real proof only: name eyesoff.ai or stage live verification; never manufacture social proof.
6. Protection is stated per host, never averaged: "cannot see your data" is said only where a confidential processor enforces and attests it; every other host is labeled with what its owner can still see.
7. One package, many hosts: portability is a promise about the deployer's build, never about identical guarantees on every backend.
8. Independence is a direction with an honest inventory: name what is already on public contracts and content addressing, name what still runs on company servers, and present the rest as proposals until code establishes it. Existing payments and contracts are not described as being replaced.

## Accessibility & Inclusion

WCAG 2.1/2.2 AA is the established baseline: axe reports zero violations on the documentation pages, enforced by a do-not-regress token set and an axe harness. New surfaces inherit this bar.
