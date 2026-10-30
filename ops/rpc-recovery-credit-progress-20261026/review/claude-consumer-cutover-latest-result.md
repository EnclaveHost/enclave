# Consumer cutover: latest remaining audit + credit-page seam (2026-10-26 UTC). PREPARED, NOT RUN

**Stage:** `consumer-cutover-remaining-20261026/`.

**Exact hashes:**
```
187417ea9e6c699422d75f4add16a61c46ee530b5d8667abab13ffea28edd841  SHA256SUMS
634e5c64ff3ad00fa7c71378e73b17b077ff1cf54d3f0ac8d941d4b438973d0c  credit-read-authority.patch
1126fce9f0f3ee2b4718f56336098d9ced3d1ba85de1c56ab3a26c5c78d06f4f  jobs/credit-read-authority-tests.sh
826f8d0e52e5b78ca80dc91813a48d6bfcafae4162218eb1d54c924ecc0343c9  site/js/core/read-authority.js
31e52ce8c27f9c03232378d14fc7c2c0b4ff1a0239eab78e1222e7451389a0bf  site/credit/credit.js
36bdac554e096e958b2233b4800ffef7887a731eb2cb1b8a26147bc91f4ac21a  scripts/build-site.mjs
a67f827ef134a7861273e89bd17557ac1657efabab52d7604af1cf810f09f077  test/credit-read-authority.test.mjs
```

---

# consumer-cutover-remaining-20261026: remaining ordinary-consumer RPC dependencies (source audit) + ONE seam (PREPARED, NOT RUN)

**Not done:** no tests, builds, queue use, SSH, network, live change or commit. Only `node --check` and `bash -n` were
run.

**Not touched:** the Windows owner-CLI and r4 stages (frozen).

**Source read:** `relay-consumer-source` HEAD **`b6ac5d657`** (= `e4f507d6b` + the owner CLI), via `git show`.
- **Updates:** `logs/claude-consumer-remaining-audit-result.md` (at `e78a764d1`) and
  `logs/claude-consumer-cutover-refresh-result.md` (live 2026-10-25 22:05–22:20).
- **No new live reads.** The live column below is the refresh's 2026-10-25 observation, not re-verified.

**Threat goal:** external-provider censorship resistance. Platform admin authority, user wallet signing and admin
controls are unchanged. **Custody v2 stays REFUSED** until a separately qualified SNP measurement exists; nothing here
touches it.

## Two properties, kept apart (for every row)

- **Endpoint replacement:** which servers answer. A self-hosted endpoint removes third parties, but it proves nothing.
- **Proof verification:** answers are checked against chain data. Only the local verifier
  (`network/chain-authority.mjs` / `LeaseReader` verifier mode) does this: the unsafe tier, no L1 finality, and logs
  prove inclusion only. The browser has **no** proof seam.
- **Live evidence:** none here. Every "seam" below is source; no consumer is cut over.

## 1. Status at `b6ac5d657` of the requested priorities (already solved in source: NOT repeated)

| Consumer (live release, 10-25) | Source seam at `b6ac5d657` | Kind | Remaining work |
|---|---|---|---|
| Site/dashboard wallet fallback (`site/js/core/wallet.js` `fallbackRead`) | **Present.** `fallbackUsesPool(INDEPENDENT.state, READ_AUTHORITY)`: under a release read authority it uses `baseRpc` (only the own pool). The `mainnet.base.org` POST happens only in the legacy hosted mode. `addChainRpcs`/WalletConnect `rpcMap` are the wallet's signing config (unchanged by design) | endpoint replacement (`own-rpc` = trusted self-hosted transport) | a site **release** built with `--read-authority FILE --read-authority-digest sha256:…` (`scripts/site-read-authority.mjs`). It needs **≥1 own HTTPS `rpc-<b32>`-role endpoint** (third-party hosts are refused by `parseReadAuthority`), plus an ENS/IPFS publication. Mobile follows the site |
| Site catalog/ledger/dashboard pool (`site/js/core/config.js` `APP_CATALOG_RPCS`) | **Present.** `READ_AUTHORITY = resolveReadAuthority(...)`: own-rpc means only its endpoints; invalid means none; legacy means the public pool | endpoint replacement | the same release input |
| **Credit page** (`site/credit/credit.js`) | **ABSENT before this stage.** It always defaulted to `credit-config.json`'s 4 public RPCs (quorum 2) and ignored the release authority, which the build did not embed into the credit bundle | endpoint replacement | **implemented here (§2)** |
| Network checker (Metal0 `nan-retirement-2d848c8/wg-qualify.mjs`, live: one `--rpc publicnode`) | **Present** in `scripts/network/wg-qualify.mjs`: `--chain-authority verifier --chain-verifier http://127.0.0.1:<port>/` via `qualifierChainAuthority` (mixing with `--rpc`/`--independent` refused) | **proof** (local verifier) | **release + invocation:** deploy a checker release from this lineage, and run it with the two flags against the host-local verifier (unit prepared in refresh §2.4; serves only after Base sync) |
| Public directory ×4 (`runtime-37366ab`, `config-f6959cb.json` with 3 public RPCs) | **Present** in `network/directory-server.mjs:48-54`: `config.chainAuthority: "verifier"` + `config.chainVerifier` (loopback). A config that still names `rpc` is refused | **proof** | a **release** from this lineage per region, plus a config without `rpc` and with `chainAuthority`/`chainVerifier`. Each region needs **its own host-local verifier** (loopback only, so a remote verifier is refused). That is a deployment prerequisite, not source |
| Legacy v1 custodian ×4 (`custodian.mjs`, `CUSTODY_RPCS` 4 public, `MIN_AGREE` 2) | **Present** in `custody/custodian-config.mjs`: `CUSTODY_CHAIN_SOURCE=verifier` + `CUSTODY_CHAIN_VERIFIER`. `CUSTODY_RPCS`/`CUSTODY_MIN_AGREE` must be absent (mixing refused) | **proof** | a **release** from this lineage (the live custodian predates it) and the env change. **v1 only.** Custody v2 stays refused |
| Relay MCP inside the API relay (`relay/mcp.js`) | **Present:** `useMcpChainClient(RELAY_CHAIN.client)` (api-relay hands its verifier client in) | proof (relay verifier) | API relay deployment (the **live API relay is still not located**, refresh §5) |
| Standalone / guest MCP (`mcp/server.mjs`, `metal/guest/mcp-server.bundle.mjs`) | **Operator profile quorum** (`mcp/server.mjs:10`: pins/profile, RPC quorum). The guest bundle's public list remains (`relay/mcp.js:79-81` comment) | quorum of the operator's RPCs | **NOT solved; not implemented here.** It needs the measured guest's verifier/proof-source route (refresh §2.3: the `rpc-<b32>` proof route is not live) and a **new measurement**. Do not replace its quorum with one unverified remote |
| DNS relay fleet (`relay/fleet.mjs`, `relay/dns-relay.js`) | **Present** (`CFG.chainClient = relayChainAuthority(...)`: the prior candidate is applied in the head) | proof | the generated `relay/network-runtime.bundle.mjs` must be built (the composition r4 failure: it is ignored and was missing) |

**Unchanged outside the requested scope:**
- the SDK defaults (`sdk/sessions`, third-party docs);
- the operator CLI (`cli/enclave.mjs` independent mode uses the operator's own quorum);
- the Windows node and owner CLI (done: r4 and owner-CLI r2, root PASS);
- custody v2 (refused).

## 2. The ONE seam implemented (stage only): the credit page follows the site release's read authority

**Why this one:** concrete, unowned and small.
- It is the last site page that ignored the release authority.
- The existing test `browser-read-authority` "credit page contract (unchanged)" already states the requirement: a
  credit cutover needs two own endpoints.

**The change:**
- **`site/js/core/read-authority.js` `creditEndpoints({authority, saved, config})`** (pure):
  1. **The owner's saved endpoints keep precedence.** That is the page's existing "save endpoints" form, the owner's
     explicit choice.
  2. **Legacy:** `credit-config.json`, exactly as before.
  3. **own-rpc:** ONLY the release's endpoints, with **the same `credit-config.json` quorum (2)**. Fewer own endpoints
     than the quorum are **refused**: never one own RPC standing in for the quorum, never the public defaults.
  4. **Invalid:** refused.
- **`site/credit/credit.js`:** selects through it. A refusal leaves no endpoint (reads refuse) and is shown to the
  owner, who can still save their own endpoints.
- **`scripts/build-site.mjs`:** the credit bundle gets **the same reviewed `readAuthorityPlugin`** as the main site
  (`--read-authority` FILE + digest). With no flags, nothing changes.
- **Untouched:**
  - the quorum reader (`quorum.js`: two or more origins, quorum ≥ 2);
  - the passkey signing at the pinned origin;
  - the vault pins and `credit-config.json`.

**Kind:** **endpoint replacement only**, a trusted self-hosted transport. **There is no proof verification in the
browser, and no live evidence.**

**Files** (`SHA256SUMS` covers all; `base/` = `b6ac5d657`, `BASE-b6ac5d657.sha256`; `candidate/` → `CANDIDATE.sha256`):

| File | Notes |
| --- | --- |
| `credit-read-authority.patch` | 149 lines, 3 files + the new test. Applies to `git archive b6ac5d657` and reproduces `CANDIDATE.sha256` exactly (checked) |
| `test/credit-read-authority.test.mjs` | **7 tests** |

**The tests:**
1. Legacy is unchanged (the shipped quorum is 2).
2. own-rpc uses only the own endpoints, with the same quorum.
3. **One own endpoint is refused with its exact reason.**
4. Invalid or mislabelled authorities (a third-party host, http) are refused.
5. The owner's saved endpoints keep precedence; a malformed saved entry is ignored.
6. **Integration:** the REAL `createQuorumReader` with a recording fetch contacts **only** the own origins, and an
   outage is a refusal.
7. **The build seam:** the credit build applies the plugin, there is exactly one replaceable declaration, and
   `credit.js` uses `creditEndpoints`. This one is structural.

**Root job (offline, cap 1024; strict TAP):**
```
./jobs/q-exit-status.sh consumer-credit-authority 1024 unshare -rn bash consumer-cutover-remaining-20261026/jobs/credit-read-authority-tests.sh
```
- **Expected:** the new 7, plus the existing `browser-read-authority` 12 on the candidate **and** on the unpatched base
  (31), with 0 fail/skip/todo/cancelled.
- **Exit codes:**

  | Code | Meaning |
  | --- | --- |
  | 0 | PASS |
  | 1 | FAIL |
  | 30 | INCOMPLETE |
  | 20 | SETUP |

## 3. Viable cutover config (required inputs; no live URLs invented)

| Consumer | Required explicit inputs | Prerequisite |
|---|---|---|
| Site (+ credit, mobile) | an `own-rpc` read-authority file `{version: 1, mode: "own-rpc", rpcs: [<own https rpc-<b32> origins>], trust: "self-hosted-transport"}` and its sha256. **≥2 distinct own origins** for the credit page | own hosted RPC role(s) live (not yet), a site release, ENS/IPFS |
| Network checker | `--chain-authority verifier --chain-verifier http://127.0.0.1:<port>/`, with no `--rpc` | host-local verifier serving (after Base sync), a checker release |
| Public directory | `"chainAuthority": "verifier", "chainVerifier": "http://127.0.0.1:<port>/"`, with no `rpc` | a per-region host-local verifier, a directory release |
| Legacy v1 custodian | `CUSTODY_CHAIN_SOURCE=verifier`, `CUSTODY_CHAIN_VERIFIER=http://127.0.0.1:<port>/`; unset `CUSTODY_RPCS`/`CUSTODY_MIN_AGREE` | a per-host verifier, a custodian release |
| Standalone/guest MCP | none viable yet (§1) | proof-source route plus a new measurement |

**Before any of these:** the own Base node synced; A2–A4, readiness and SNP gates as applicable; the refresh §4
canary (deny egress to public RPC hosts, then stop the verifier and confirm it fails closed). **No cutover is claimed.**
