> **ROOT RULING (2026-10-25): O4 is NOT APPROVED.** A tunnelled trusted remote verifier replaces the public-provider
> authority with one mutable host. That host could fabricate owner, registry and lease facts for every host, itself
> included, and it conflicts with the user's refusal to replace Nan with one central control host. The statement below that
> "only metal0 can run the runtime" is NOT a live fact (no hardware was inspected); the source only shows that rpc-runtime
> refuses non-Linux hosts. See EXIT-PROOF-OPTIONS.md for alternatives that keep chain facts checked locally.

# Exit-provider (DO) public-RPC dependency: read-only audit and bounded plan (2026-10-25)

**Scope.** This is a READ-ONLY source audit.
- Source: route-source `dba7b4fdc`, plus the agent-authority diff that root published as `94a639558`. route-source was
  not changed.
- No code, build, test, SSH, config or key read was done; no other worker's tree was touched.
- "SUPPORTED" means the code path exists today. "PROPOSED" means it does not exist and would need source work.

**Constraints, kept throughout.**
- DO boxes stay minimal WireGuard transport hosts. All real services run on hosts and apps.
- Admin authority is preserved: bans, allowlist, anchor, book current owner, sequence, replay and persisted refusals.
- No alias quorum. The three hosts (metal0, minipc, Pixel) have ONE operator and are not an independent quorum.

## 1. What the exit reads from the chain today (`network/wg-provider/main.mjs`)

Every read below goes through `cfg.rpc`, which `main.mjs` requires to hold two or more public HTTPS RPCs
(`main.mjs:55` for the check-config path, `:70` at start).

| # | read | code path | used for | authority today |
|---|---|---|---|---|
| E1 | platform host policy for host-service grants | `main.mjs:105-115`: `hostServicesPolicyEnv(hostServices)` → `resolveHostPolicyConfig` → `createHostPolicyRuntime` → `hostAdmission = rt.admissions`; used at `provider.mjs:245-252` (`admitHost`, every grant) and `:332`/`:352-361` (the sweep batch) | ban, allowlist, anchor, current owner and sequence, for host services | `hostServices.platformHostPolicyRpcs`, or the production RPC quorum |
| E2 | registry rows, `hosts(id)` | `main.mjs:118-120`: `leases.registryEntries` (`LeaseReader({rpc})`, `:75`) | control peers (`provider.mjs:343`), service peers (`sweepService :357`: deregistration or deactivation = the admin's registry ban), and provider-record operators for guard forwarding (`main.mjs:~94`) | the `cfg.rpc` quorum |
| E3 | app leases | `main.mjs:~132`: `leases.readSnapshot([id])`; app peer grant and sweep (`provider.mjs:345-348`) | every APP circuit through the exit | the `cfg.rpc` quorum |
| E4 | owner signatures | `main.mjs:78`: `verifyOwnerSignature({reader: leases, …})` | owner-signed app policies and requests (ERC-1271 / SessionVault) | the `cfg.rpc` quorum |
| E5 | paid qualification writes | `main.mjs:~146-159`: `createWalletClient(… http(cfg.rpc[0]))`, `ensureHost`, `submitAttestations` | paid or community providers only (`pricePerGiB6 > 0`) | **one** public RPC, used for submission |

**A host-service grant needs E1 and E2** (and E4 for signed requests). So moving only the policy runtime (E1) would
**not** free host services from public RPC: `sweepService` and the request checks still read registry rows through the
`cfg.rpc` `LeaseReader`. Every app circuit needs E3.

## 2. Seams that exist today (SUPPORTED) and their limits

| seam | where | what it does | limit |
|---|---|---|---|
| S1: policy-level `chainAuthority: "verifier"`, `chainVerifier` | `providerHostServices` accepts any plain `platformHostPolicy` object (`host-services-config.mjs:28-31`); `resolveHostPolicyConfig` honours policy-level `chainAuthority`/`chainVerifier` (`platform-host-policy-config.mjs:32-37,56-63`); `createHostPolicyRuntime` then builds `verifiedHostSnapshot` (`host-policy-runtime.mjs:62-65,86-87`) | a config-only switch for **E1** | (a) the verifier must be **loopback** (resolver regex). (b) **Untested for the provider.** (c) **Silent mixed form**: with `platformHostPolicyRpcs` also set, the verifier wins without a word. The agent block now refuses this (94a639558); the provider block does not. (d) It covers E1 only |
| S2: `LeaseReader` `authority:'verifier'`, `verifier` / `clients` / `proxy` | `lease-reader.mjs:144-170` | proof-backed reads for E2/E3/E4 (the same class the agent and Windows node use; `test/lease-reader-verifier.test.mjs`, `test/windows-chain-authority.test.mjs`) | **not exposed** by `wg-provider/main.mjs`, which passes only `rpc` (`:75`). It **refuses a remote verifier by design** (`lease-reader.mjs:106-116`: "a remote 'verifier' would be one unverified server, exactly what this authority must never be") |
| S3: `createHostPolicyRuntime({snapshot \| clients})` | `host-policy-runtime.mjs:79-87` | inject one chain authority | code-only; there is no config path in `main.mjs` |
| S4: the provider's `hostAdmission` / `hosts` / `leases` injection | `WgProvider` constructor (`provider.mjs:68-69`) | the provider core is authority-agnostic | only `main.mjs` builds them |

The agent side is SUPPORTED:
- `cfg.chain.authority:'verifier'` makes the agent `LeaseReader` proof-backed. The bootstrap reader inherits `chain`
  (`provider-bootstrap.mjs:22`), and owner signatures use the verifier reader (`enclave-network-host.mjs:82-87`).
- The host-services gate now has explicit verifier plumbing (94a639558).
- One exception: `egressProbeUrls` defaults to the RPC origins (`egress-probes.mjs:4-5`). That is a reachability probe, not
  an authority, but a verifier-only agent needs explicit `egressProbeUrls` (≥2 hostnames, or an empty list).
- `createPaidNetwork` follows `leaseReader`; it was not audited further.

**Today's agent reads cross the exits.** The agent's `LeaseReader` (and so its public-RPC reads) can be sent over SOCKS
through its control circuits at the exits (`privacy-agent.mjs:340-341`, `proxy: wgControl.proxies()`). The exits egress
that traffic to the public RPCs. Under `chain.authority:'verifier'` that traffic goes away.

## 3. Options

| option | verdict |
|---|---|
| O1: a verifier (or node) on each DO box | **rejected by constraint.** The verifier is ~234 MB of pinned binaries, `MemoryMax=1536M`, a P2P gossip listener and a proof source. That is chain compute on DO |
| O2: `cfg.rpc` = host-owned nodes over tunnels | **rejected.** As far as is known (live hardware not inspected), only metal0 currently runs our Base node. Two RPC entries for one node is an **alias quorum**. The three hosts share one operator, so even two nodes would not be independent |
| O3: stay on the public quorum (status quo) | keeps the dependency; it is the fallback when O4 is not approved |
| **O4: a remote host verifier over an authenticated operator WireGuard link: NOT APPROVED (root ruling, banner above)** | below, kept for the record |

### O4: the bounded plan

**Mechanism.** No Enclave protocol change; the transport is OS-level WireGuard.
1. metal0 runs the host-local verifier `127.0.0.1:28590` (`examples/host-rpc-runtime.metal0.json`; its proof source is
   the loopback node, so it has no public dependency).
   - rpc-runtime has **no bind option** (loopback only). metal0 exposes it on a dedicated operator WireGuard interface
     through a loopback→wg forwarder bound to that interface's /32 only (e.g. `systemd-socket-proxyd`).
2. Each DO box gets ONE static operator WireGuard peer, metal0's key:
   - metal0 dials out, with persistent keepalive, because the site has no inbound;
   - AllowedIPs is that /32;
   - an nft rule allows only that peer to reach the forwarder port;
   - a DO-side loopback forwarder `127.0.0.1:<p>` → `<metal0 wg /32>:<p>`.
   The DO box runs no chain software.
3. **PROPOSED code (small, explicit, not a disguise).** Point all of E1, E2, E3 and E4 at ONE authority:
   - `main.mjs` gains an explicit `chainAuthority: "tunneled-verifier"` + `chainVerifier` (loopback) setting;
   - it builds the `LeaseReader` with `authority:'verifier'` and the policy runtime with the same snapshot (S2+S3);
   - it refuses `cfg.rpc`, `platformHostPolicyRpcs` and a policy-level authority beside it (no mixed form);
   - status and logs say "**remote verifier over operator WireGuard: answers are trusted, not verified on this box**";
   - E5 stays unavailable: no submission route; DO exits must be unpaid, or paid writes need their own decision.
   - **Config-only S1** (loopback-forward + policy-level authority) would technically work for E1 today. But it relabels a
     remote server as "local verifier", against `lease-reader.mjs:106-108`'s rule, and leaves E2/E3/E4 on public RPC.
     **Not recommended.**

**Trust change (explicit).** The exit **no longer verifies anything.** It trusts metal0's verifier answers. Those answers
are proof-checked *on metal0* against sequencer-signed heads, and the WireGuard key authenticates the transport, not the
facts.

| | today | under O4 |
|---|---|---|
| what decides the exit's admission facts | agreement of independent public providers | one operator host |
| what it takes to defeat that | ≥2 of 3 providers lie or censor | compromise of metal0 (or of its WireGuard key) |
| what a defeat yields | false answers at the exit | arbitrary answers at **every** exit using it, **for every host including metal0 itself** — metal0 is also a judged host |

Admin authority itself is unchanged:
- documents are still admin-signed and anchored;
- the current-owner, sequence, replay and persisted-refusal checks still run in the unchanged gate core
  (`host-service-gate.mjs`, `platform-host-policy.mjs`) on the exit;
- only the chain FACTS (anchor, owner, registry rows, leases) come from metal0.

Root decides whether that trust is acceptable.

**Bootstrap cycle: solved by construction.**
- Exit grants need E1 and E2. Under O4 those come over the static operator WireGuard peer, which is configured outside
  Enclave grants and the registry. The exit never needs metal0's *public* `rpc-<b32>` route, or any grant, to read the
  verifier.
- metal0's verifier needs only its loopback node and Base gossip.
- The full order: node → host verifier → (runner gate, agent gate, exits via the operator link) → grants → public-rpc role
  → guest verifiers.
- Not acceptable: carrying the link as an Enclave *control* peer of the exit. Control peers are admitted through E2
  (`provider.mjs:343`), which would recreate the cycle.

**Outage behaviour and recovery (existing code, SUPPORTED).**
- **New grants:** `admitHost` refuses on an unreadable policy (`provider.mjs:245-252`).
- **Existing peers:** the sweep removes peers only on a **definite** answer; an unreadable read keeps them until their
  grant expires (`provider.mjs:332-348,352-361`).
- **Effect of a metal0 or link outage:** no new or renewed host-service, control or app grants at those exits **for every
  host**, while existing circuits ride out their expiry. Recovery is automatic once reads answer, with no restart: the
  runtime keeps the accepted anchored policy under `stateDir` (`main.mjs:112-114`).
- **Fallback:** O4 has none, by design. **This makes metal0 a single point of failure for every app on those exits (E3),
  not only for host services.**

## 4. Blockers and decisions for root

1. **Trust acceptance (§3 O4):** one operator host replaces a public-provider quorum as the source of chain facts for the
   exits.
2. **Single verifier host (source-level claim only; live hardware not inspected).** The source refuses non-Linux hosts.
   Which hosts can run it is a live fact for root. Until a second, independently operated verifier host exists, O4 is a SPOF for app transport
   (E3).
   - Bounded alternative: migrate only the exits that carry host services, and leave app-transport exits on O3.
   - That is an **explicit per-exit choice, never mixed within one exit**. It still leaves those other exits on public
     RPC.
3. **PROPOSED code (not written):** `main.mjs` authority plumbing + refusal of mixed settings; also refuse a policy-level
   `chainAuthority` in `providerHostServices` (closing S1(c)).
   - Tests to add (offline; the shared guard; the existing `platform-policy-world` + `loopback-verifier` helpers):
     - provider grant admit, ban and unban with the public RPCs down and zero public hits;
     - owner rotation;
     - a verifier outage refuses new grants while existing peers are kept until expiry, then recovery;
     - mixed or remote config refused;
     - the control/app paths on the same authority.
4. **E5 paid writes:** needs a live fact: are the DO exits paid (`pricePerGiB6`)? If so, a separate submission decision
   (an own backend over the link, or keep public).
5. **Live fields root would need (read-only):**
   - per DO exit: `bootstrap` mode, `pricePerGiB6`, whether `hostServices` is present and its `platformHostPolicyRpcs`
     hostnames, `rpc` hostnames;
   - metal0: a free WireGuard interface/port plan;
   - DO: whether an operator WireGuard interface separate from the Enclave exit/guard/control ports (51820-51822) can be
     added.
6. **Not affected by O4:** the hosts' own agents, runner and guests already have a verifier path
   (`chain.authority`, `hostServicesPolicy.chainAuthority`, `chainVerifier` member). The lease relay is remote
   (`134.209.248.172`); its migration is handled separately in `lease-relay-source`.
