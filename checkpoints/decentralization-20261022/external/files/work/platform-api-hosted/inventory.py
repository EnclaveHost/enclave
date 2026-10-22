#!/usr/bin/env python3
"""Route / feature / state / credential inventory of the platform API (relay/api-relay.js and the modules it serves).
Reads the candidate tree READ-ONLY (source and public metadata only; no production state, key or env file is read).
Writes inventory.json beside this script. The owner and class columns are the reviewed classification; the route and
call-site lists are extracted from the source so a route added later shows up as UNCLASSIFIED."""
import json, re, os, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "tree")
src = open(os.path.join(T, "relay/api-relay.js")).read()

# ---- routes the relay matches (extracted) ------------------------------------------------------------------------------
found = set()
for m in re.finditer(r'(?:u\.pathname|p)\s*(?:===|\.startsWith\()\s*"(/[^"]*)"', src): found.add(m.group(1))
for m in re.finditer(r'u\.pathname\.match\(/\^((?:\\/|[^/])+)/', src): found.add("re:" + m.group(1).replace("\\/", "/")[:80])
found.add("/v1/fleet-tunnel (upgrade)")

# ---- the reviewed classification ---------------------------------------------------------------------------------------
# owner: who moves it. class: public-data | platform-private | customer-secret | platform-credential-use | transport-control
ROWS = [
 ("/v1/account/", "relay/auth.js", "platform-api (MINE)", "platform-private",
  "SIWE, passkeys (RP id enclave.host, unchanged), device pairing, linking, JWKS", ["accounts.json", "session-key.pkcs8.pem"]),
 ("/v1/sso", "relay/sso.js", "platform-api (MINE)", "platform-credential-use", "app sign-in tokens (SSO_SIGNER_KEY)", []),
 ("/v1/billing", "relay/billing.js + provisioner.js + vaultsvc.js", "platform-api (MINE)", "platform-private",
  "Stripe checkout + webhooks, credit orders, passkey credit vault prepare/exec, top-up, review queue; card optional (no Stripe key = card off, wallet unaffected)",
  ["orders.json", "stripe-events.json", "review-queue.json"]),
 ("/v1/sessions", "relay/sessions.mjs", "platform-api (MINE)", "platform-private",
  "session relayer (original factory), journaled submissions", ["sessions-index.json", "sessions-relayer.json"]),
 ("/v1/secrets", "relay/secrets.js", "platform-api (MINE)", "customer-secret",
  "relay-held deployment secrets, encrypted under SECRETS_KEY (independent custody v2 unaffected)", ["secrets.json"]),
 ("/v1/deployments", "api-relay.js gateway", "platform-api (MINE)", "public-data",
  "list/get from the ORIGINAL ledger; POST and controls proxied to the holder host through the tunnel hub", []),
 ("/v1/apps/upload-token", "api-relay.js", "platform-api (MINE)", "platform-credential-use", "signed upload tokens (UPLOAD_KEY)", []),
 ("/v1/claim-hint", "api-relay.js", "platform-api (MINE)", "public-data", "claim nudge to hosts", []),
 ("/v1/featured-view", "api-relay.js", "platform-api (MINE)", "platform-private", "best-effort view metering", ["featured-views.json"]),
 ("/v1/featured-views", "api-relay.js", "platform-api (MINE)", "public-data", "counts", ["featured-views.json"]),
 ("/v1/referrals", "relay/referrals.mjs", "platform-api (MINE)", "platform-private", "referrals incl. /v1/admin/referrals (admin)", ["referrals.json"]),
 ("/v1/admin/referrals", "relay/referrals.mjs", "platform-api (MINE)", "platform-private", "admin", ["referrals.json"]),
 ("/v1/referrals/host", "relay/referrals.mjs", "platform-api (MINE)", "platform-private", "host referrals", ["referrals.json"]),
 ("/v1/placement", "relay/placement.mjs", "platform-api (MINE)", "platform-private", "placement pins", ["placement.json"]),
 ("/v1/pads/", "relay/pads.mjs", "platform-api (MINE)", "platform-private", "pads ledger / prefix store", ["pads-ledger.json", "prefix-kv/"]),
 ("/v1/hosts/sponsor/", "relay/host-sponsor.mjs", "platform-api (MINE; lease-gas policy is credit-vault/app-lease-gas)", "platform-credential-use",
  "host onboarding sponsorship (HOST_SPONSOR_* keys, HOST_PAYMASTER)", []),
 ("/v1/hosts/name/", "relay/host-names.mjs", "platform-api (MINE)", "public-data", "host name ownership via the tunnel hub", []),
 ("/v1/platform-host-policy", "api-relay.js", "platform-api (MINE)", "public-data", "admin host policy read (governance preserved)", []),
 ("/v1/expected-guest", "relay/secrets-release.mjs + measurement-predict.mjs", "platform-api (MINE) - GAP: needs remote prediction gateways", "public-data",
  "guest measurement prediction (local tools are not in the guest; SECRETS_RELEASE_PREDICT_GATEWAY(S))", ["predict/ (cache)"]),
 ("/v1/prepare-guest-update", "relay/secrets-release.mjs", "platform-api (MINE) - same GAP", "public-data", "", []),
 ("/v1/network/", "relay/network-api.mjs", "platform-api process; discovery/policy authority: hosted-service-placement", "platform-private",
  "network providers/policies/BYO", ["network.json"]),
 ("/v1/relays", "api-relay.js", "hosted-service-placement (discovery)", "public-data", "network route map", []),
 ("/v1/health", "api-relay.js", "platform-api (MINE)", "public-data", "", []),
 ("/health", "api-relay.js", "platform-api (MINE)", "public-data", "", []),
 ("/availability", "api-relay.js", "platform-api (MINE)", "public-data", "host availability", []),
 ("/enclaves", "api-relay.js", "platform-api (MINE)", "public-data", "host status (registry + attached tunnels)", []),
 ("/route", "api-relay.js", "platform-api (MINE)", "public-data", "", []),
 ("re:/v1/enclaves/", "api-relay.js + tunnel.js", "platform-api (MINE)", "public-data", "fresh attestation through the attached host (client nonce)", []),
 ("re:/v1/amd-kds/", "api-relay.js", "platform-api (MINE)", "public-data", "AMD collateral proxy", []),
 ("/v1/fleet-tunnel (upgrade)", "relay/tunnel.js", "platform-api (MINE): hosts attach here; websocket proxied by the role", "transport-control",
  "in-memory attachments; hosts re-attach after a failover", []),
 ("/v1/domains", "relay/domains.js", "certificate-hosted-placement (DNS/certs) - process moves with the role", "platform-private", "custom domains", ["domains.json"]),
 ("/v1/certs", "relay/certs.js", "certificate-hosted-placement", "platform-credential-use", "ACME (account keys are state)", ["certs.json"]),
 ("/internal/tls-ask", "api-relay.js", "certificate-hosted-placement (replaces Caddy on-demand TLS)", "transport-control", "", []),
 ("/mcp", "relay/mcp.js", "mcp-hosted-placement", "public-data", "", []),
 ("re:/t/([A-Za-z0-9_-]+)(/.*|)$", "api-relay.js + tunnel.js", "platform-api process (tunnel proxy to attached boxes; public-only, sandboxed); transport roles: hosted-service-placement",
  "transport-control", "per-box path proxy through the hub (no application TLS on the relay origin)", []),
 ("/x", "api-relay.js", "retired (410 application_transport_moved)", "public-data", "", []),
 ("/x/", "api-relay.js", "retired (410)", "public-data", "", []),
 ("/v1/auth/", "api-relay.js gateway", "platform-api (MINE): proxied to a sticky attached host", "platform-private", "host-side auth nonces", []),
 ("/v1/", "api-relay.js gateway", "platform-api (MINE): the rest of /v1 proxied to attached hosts", "public-data", "", []),
 ("/", "api-relay.js", "-", "public-data", "", []),
]
classified = {r[0] for r in ROWS}
rows = [dict(route=r[0], module=r[1], owner=r[2], data=r[3], feature=r[4], state=r[5]) for r in ROWS]
unclassified = sorted(x for x in found if x not in classified and not any(x.startswith(c) for c in classified if c.endswith("/")))

# ---- credentials (names only, from work/control-vm/service-shape.json: env KEY NAMES, never values) ----------------------
shape = json.load(open(os.path.join(HERE, "..", "control-vm", "service-shape.json")))
api = next(s for s in shape["services"] if s["service"] == "enclave-api-relay")
SECRET = re.compile(r"(^|_)(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|HMAC|SEED|MNEMONIC|EAB)(_|$)")
SYSTEMD = {"INVOCATION_ID", "JOURNAL_STREAM", "LANG", "LOGNAME", "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE", "PATH", "SYSTEMD_EXEC_PID", "USER", "STATE_DIRECTORY"}
ROLE = {"AUTH_DATA_DIR", "API_RELAY_PORT", "API_RELAY_BIND"}
creds = sorted(k for k in api["environmentKeys"] if SECRET.search(k) and k not in SYSTEMD)
public = sorted(k for k in api["environmentKeys"] if not SECRET.search(k) and k not in SYSTEMD and k not in ROLE)

# ---- the site's API call sites (extracted) -------------------------------------------------------------------------------
site_calls = set()
for d, _, fs_ in os.walk(os.path.join(T, "site")):
    if "/vendor" in d or "/dist" in d or "/node_modules" in d: continue
    for f in fs_:
        if not f.endswith((".js", ".html")): continue
        t = open(os.path.join(d, f), errors="ignore").read()
        for m in re.finditer(r'"/(account|billing|sso|sessions|secrets|domains|certs|network|deployments|auth|apps|hosts|referrals|claim-hint|featured-views?|enclaves|pricing|availability|gpu|placement|expected-guest|prepare-guest-update|platform-host-policy|amd-kds)[^"]*"', t):
            site_calls.add(m.group(0).strip('"'))
openapi = json.load(open(os.path.join(T, "site/openapi.json")))
out = {
  "generatedFrom": {"tree": "work/platform-api-hosted/tree (main e762a9c5 + dirty)", "api-relay.js sha256": hashlib.sha256(src.encode()).hexdigest()},
  "routes": rows, "routesExtracted": sorted(found), "unclassified": unclassified,
  "siteCallSites": sorted(site_calls), "openapiPaths": sorted(openapi.get("paths", {}).keys()), "openapiServer": openapi.get("servers"),
  "credentials": {"platformOwnedSecretNames": creds, "publicConfigNames": public,
                  "rule": "secret-shaped names are refused in the bound (public) platformApi.relayEnv and arrive only as an admin-signed package sealed to the primary's boot"},
  "stateClasses": {
    "platform-private (replicated, AEAD under K, archived as ciphertext)": ["accounts.json", "session-key.pkcs8.pem", "orders.json", "stripe-events.json", "review-queue.json",
        "sessions-index.json", "sessions-relayer.json", "referrals.json", "placement.json", "pads-ledger.json", "prefix-kv/", "network.json", "domains.json", "certs.json",
        "featured-views.json", "route-grace.json", "indexer-cursor.json", "platform-credentials.json"],
    "customer-secret (replicated as is: already encrypted under SECRETS_KEY)": ["secrets.json"],
    "in-memory only (lost on failover by design; clients retry)": ["SIWE/passkey challenges", "rate limits", "tunnel attachments", "fresh-attestation sessions"],
    "public-data (no platform state)": ["ledger/registry/catalog reads", "/enclaves", "/availability", "openapi.json"]},
}
json.dump(out, open(os.path.join(HERE, "inventory.json"), "w"), indent=1)
print(f"{len(rows)} classified routes, {len(found)} extracted, unclassified: {unclassified}; {len(site_calls)} site call sites; {len(creds)} credential names; {len(public)} public config names")
