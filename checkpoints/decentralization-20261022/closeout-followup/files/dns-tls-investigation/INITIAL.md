> **SUPERSEDED (2026-10-23).** The "Planned remediation" below (reusing the whole marketplace verdict) was withdrawn after root review: it skipped admit's fresh confirmRow and catalog checks. See RESULT.md §5: cache only CID-verified DAG bytes, and bound the evidence wait with a 202. The diagnosis sections still stand.

# EnclaveDNS (0x59f1273d) TLS and route: diagnosis plan (INITIAL; source and live-evidence read only)

**Evidence.** `dns-tls-current/{native-state,network-state,routes}.json` (root's read-only captures, 00:28:57–00:29:36Z).

**Source lineage.** The files below are byte-identical in the installed relay tree
(`relay-release-list-review/tmp/installed-tree`), the relay candidate ad074e2 and the adapter candidate:
- relay/certs.js 237834d8, relay/shield-marketplace.mjs 463f11fe, relay/shield-app-verifier.mjs 2e1c0347,
  relay/measurement-predict.mjs a6372f41;
- network/guest-probe.mjs e26da7ff, network/local-app-transport.mjs 4c4b3ce1;
- windows/node/hvcert.mjs 3a87d9b8, windows/node/apptls.mjs 2fb25b00.

## Findings so far

1. **The timeout is the node's 60-s abort on POST /v1/certs/issue** (`windows/node/apptls.mjs:128`).
   - On a Shield/hv host, the relay awaits `verifyAppCertificate` with no bound BEFORE its cache lookup
     (`relay/certs.js:981-991`, cache at 993-995).
   - That calls `shieldMarket.certificate` → `admit`, which runs a FULL verification on every request
     (`relay/shield-marketplace.mjs:47-75`): `confirmRow` (chain quorum) ×2, the catalog read, the config fetch, the
     catalog component `fetchVerified` (`relay/shield-app-verifier.mjs:92`), and up to 3 evidence fetches through the
     tunnel.
   - A non-raw component CID is not kept on disk and is re-fetched through the gateways each time, bounded only by the
     predictor's `timeoutMs` (default 240 s; `relay/measurement-predict.mjs:225, 632-663`).
   - A cached certificate is therefore behind the same slow path.
2. **The node's retry** (`windows/node/hvcert.mjs:121-149`):
   - `app_evidence_required` (403, no hint) and the abort both count as failures, so the wait doubles: 30 s × 2^(n−1),
     up to 1 h.
   - `backoffUntil` is measured from the attempt's START. Observed: 240 s, 480 s, 960 s.
   - 00:12:55 + 960 s = 00:28:55, the install time.
3. **The route** (`network/guest-probe.mjs:43`, `network/local-app-transport.mjs:36`):
   - The LOCAL guest proof of a non-startup-egress app uses default WebPKI verification. The app's self-signed fallback
     fails ("self-signed certificate"), so there is no local proof, egress is off and no route.
   - After the install, the proof passed and network.log shows "egress back" at 00:29:14.
   - routes.json was written at 00:29:09, before that, so its missing route is ordering, not a new failure.
4. **Serving-first e7 + keeper changes `host.mjs` only.** The certificate pass runs from `windows/node/agent.mjs:1140`
   (hvcert), and the slow path is in the relay. They do not address this.

## Planned remediation (smallest; no policy weakened)

- **Relay.** `shieldMarket.certificate(host, d, spki)` reuses the app verdict the marketplace already holds when it is
  current and exactly matches. The match requires:
  - the same Shield session;
  - `until` > now (the 300-s TTL routing and DNS already rely on);
  - the same deployment fingerprint;
  - an active, public, live lease held by this host;
  - the secrets rule and the owner exception, as `admit` checks them;
  - the stored attested TLS key == the CSR key.

  Otherwise it runs the existing full `admit`, unchanged. This is the same evidence `admit` would produce, and no
  shorter path skips any check that `admit`'s verdict carries.
- **Tests:** reuse when fresh; refusal when stale, when the key differs, when the session changed or the fingerprint
  changed; and the evidence path still runs when no verdict exists.
- **Not implemented, for root's decision:**
  - local-proof WebPKI vs attestation-only for ordinary apps (a TLS-gating change);
  - classifying `app_evidence_required` and the abort as a bounded wait on the node.
