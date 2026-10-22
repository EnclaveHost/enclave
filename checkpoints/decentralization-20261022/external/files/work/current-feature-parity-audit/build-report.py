#!/usr/bin/env python3
"""Current feature-parity audit (read-only). One source of facts -> feature-parity.json and feature-parity.txt.

Categories (exactly one per feature):
  implemented      current source path implemented (state given: committed | dirty-integration | candidate)
  unowned-gap      incomplete, and no active workstream owns the missing piece
  owned            actively owned by a named workstream (its scope covers the missing piece)
  activation       source exists; deployment/activation (owner, operator or release action) is what remains
  evidence-missing the claim cannot be established from current source or receipts
Source state is never deployed proof: 'committed' = in work/enclave HEAD fd1cc627 or enclave-apps HEAD 50f93d74;
'dirty' = in the uncommitted main integration tree (233 changed/untracked entries); 'candidate' = in a worker tree.
"""
import json, os, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OWNERS = {
    "gas40c": "application-funded-lease-gas (Claude 40c909a2, work/app-lease-gas): Linux/Windows leases, app-paid claim/renew",
    "policy354d": "existing-custody-compatibility (Claude 354d2e08, work/existing-custody-audit): host/relay/control/admin policy enforcement",
    "browsera8b4": "browser-default-independence (Claude a8b4f94e, work/browser-offchain-liveness): default browser policy, management, liveness",
    "browser7cfd": "browser-secrets (Claude 7cfd0800, queued-for-memory): browser Secrets + CORS integration",
    "sdk3923": "storage-fencing-implementation (Claude 3923fff3, work/storage-c2-implementation): SDK C2 storage",
    "go6b7": "indexd-fencing-implementation (Claude 6b7af721, work/indexd-c2-implementation): Go indexd C2 storage",
    "appsed8f": "app-release-migration (Claude ed8f1f12, work/app-auth-release-migration): EAB1 / passkey-only app account continuity (jot, EyesOff, depot, api-mcp-adapter)",
    "front9d6a": "storage-front-generation-binding (Claude 9d6a7d6f, work/storage-front-binding): writer authority binding",
    "heartbeat9d6a": "offchain-heartbeats (completed-source-integrated-not-activated)",
    "ipnse49a": "ipns-production-cutover (completed-source-verified-not-activated)",
    "root": "coordinator/root (production activation owner)",
    "NONE": "no active workstream",
}

F = []
def feat(id, area, prior, category, *, default, optin=None, authority, alternative, source, deployed, owner, gap, boundary=None):
    F.append(dict(id=id, area=area, priorSemantics=prior, category=category, defaultPath=default, optInPath=optin,
                  requiredServerOrAuthority=authority, availableAlternative=alternative, sourceEvidence=source,
                  deployedEvidence=deployed, owner=owner, ownerDetail=OWNERS[owner.split("+")[0]], gap=gap, trustBoundary=boundary))

# ---------------------------------------------------------------- A. naming, certificates, custom domains
feat("custom-domains-direct-snp", "names/TLS",
     "an owner attaches their own hostname to a deployment and the app serves it with a certificate minted inside the enclave",
     "activation",
     default="relay domain store (relay/domains.js) -> guest learns names from api.enclave.host/v1/domains/map (isolation/m2/front/domains.go:89, release.RelayHost constant pins.go:14); supervisor DOMAINS_API defaults to SECRETS_API (supervisor.js:7030)",
     optin="owner-committed names in the startup package (bootstrap prepare --names, --acme-directory/--acme-challenge/--acme-zone; sdk/bootstrap/package.mjs validateNames) certified in-guest (isolation/m2/front/names.go, acme.go; GET /.well-known/enclave-names)",
     authority="default: Enclave relay (domain map, CA account, DNS-01) and enclave.host DNS; opt-in: owner-chosen CA + owner-chosen DNS-01 responder (relay/dns-relay.js attested mode is runnable by anyone)",
     alternative="opt-in path needs no Enclave service: CA proves control via the owner's own _acme-challenge CNAME",
     source="committed 0ed5a8ba (front/names.go, acme.go, bootstrap/names.go + tests); browser form site/js/core/startup-package.js validateNames is UNTRACKED (dirty)",
     deployed="no receipt of an owner-name certificate issued by a public CA for a live direct guest; outputs/direct-host-control/review.json limits: 'Native direct-only mode excludes browser certificates and custom domains until independent implementation exists' (reviewed af16a74c, before 0ed5a8ba)",
     owner="NONE",
     gap="(1) no deployed proof: public-CA issuance for an owner name on hardware; (2) dashboard 'Domains' button hidden in independent mode (site/components/deployments/deployments.js:1450) and the replacement form exists only in dirty source; (3) production direct guests not activated",
     boundary="A browser trusts a name only through WebPKI: some CA and the owner's DNS are irreducible external trust; the owner chooses both")
feat("custom-domains-windows-shield", "names/TLS",
     "custom domains for apps on Windows/Shield (GPU) hosts", "unowned-gap",
     default="Windows domains from relay (windows/node/network-enroll.mjs:142 ${relayBase}/v1/domains/map; apptls via api.enclave.host)",
     optin="Shield-direct partition image certifies owner names (windows/node/shield-startup.mjs:216,244,269); legacy-public owner packages REFUSE names (shield-startup.mjs:217)",
     authority="Enclave relay for the default path", alternative="Shield-direct image only",
     source="committed shield-startup.mjs; Shield-direct front isolation/m2/front/shield_direct.go",
     deployed="outputs/shield-direct-runtime-verification.json exists; shield-canary-isolation workstream STOPPED (terminal1, provider safeguard rejection)",
     owner="NONE", gap="Shield-direct canary stopped with no owner; Windows GPU apps keep relay-issued names/certs")
feat("app-zone-certificates", "names/TLS",
     "every deployment gets https://<label>.app.enclave.host with a WebPKI certificate", "unowned-gap",
     default="relay CA account + DNS-01 (relay/certs.js); supervisor CERTS_API; guest cert gate via relay /v1/expected-guest",
     optin="in-guest ACME for owner names (above); native full-ID access needs no WebPKI",
     authority="Enclave relay CA account and the enclave.host zone (Enclave's business domain: legitimate brand, but a DNS/registrar dependency)",
     alternative="native client (attested SPKI, no WebPKI) for non-browser clients; owner names for browsers",
     source="relay/certs.js, supervisor.js CERTS_API, isolation/m4/guestd/supervisor-guestcert.mjs",
     deployed="production app-zone certs are relay-issued (prior audit; not re-verified here)",
     owner="NONE", gap="app-zone names are certified only through the relay's CA account and DNS-01 (a required central server); in-guest ACME (acme.go) exists for owner names only. A relay-free app-zone issuance (guest ACME against the provider DNS replicas' attested DNS-01 responders) is not implemented or owned; policy354d's scope is policy enforcement, not issuance",
     boundary="app.enclave.host is Enclave's own zone: issuing under it inherently involves Enclave DNS")

# ---------------------------------------------------------------- B. native client
feat("native-get-head", "native access", "a client reaches an app by full deployment ID without Enclave DNS/CA/API", "implemented",
     default="browser: https://<label>.app.enclave.host (Enclave DNS + relay certs)", optin="network/native-client.mjs (Node) with pinned profile, directories, attested SPKI",
     authority="none required on the native path (directories/RPCs chosen by the client)", alternative="itself",
     source="committed ca7fc543 network/native-client.mjs", deployed="outputs/native-writes/live-transport.json: live verified GET/stream against deployment 0x9eb4e600… via enclave-network route",
     owner="NONE", gap="Node only")
feat("native-writes-streaming", "native access", "authenticated POST/PUT/PATCH/DELETE, streamed responses (chat/SSE)", "unowned-gap",
     default="browser via app.enclave.host", optin="native-client.mjs request()/stream() with bodies <= 64 MiB",
     authority="none on the native path", alternative="-",
     source="committed ca7fc543; outputs/native-writes/review.json: 42 tests pass",
     deployed="live no-op POST (HTTP 404 /ping) and one streamed GET only; review limits: 'no authenticated chat/write or live SSE generation tested'",
     owner="NONE", gap="no streaming upload; no authenticated write/SSE proven live; no browser integration")
feat("native-websocket", "native access", "WebSocket apps (IRC, minecraft-server, vault) reachable over the independent path", "unowned-gap",
     default="browser WSS via app.enclave.host", optin="none", authority="Enclave DNS/certs for browsers", alternative="none",
     source="native-client.mjs has no Upgrade/101 handling (grep: no websocket); WebSocket users in enclave-apps: IRC, minecraft-server, vault", deployed="none",
     owner="NONE", gap="no WebSocket on the native path at all; IRC, minecraft-server and vault have no independent client")
feat("native-browser", "native access", "a browser user reaches an app without Enclave DNS/CA", "unowned-gap",
     default="app.enclave.host", optin="owner-committed names (WebPKI) — the only browser path", authority="WebPKI CA + DNS",
     alternative="owner names (activation pending)", source="native-client is Node-only; site/js/core/native-instructions.js only prints instructions",
     deployed="none", owner="NONE", gap="browsers cannot verify attestation natively; owner names are the only route",
     boundary="Browsers cannot pin an attested SPKI or speak the enclave-network transport: WebPKI is a genuine browser trust boundary")

# ---------------------------------------------------------------- C. accounts, passkeys, SSO, devices
feat("passkey-account-dashboard", "identity", "sign up / sign in to the dashboard with a passkey account; multiple devices; recovery", "implemented",
     default="relay account system (relay/auth.js, ES256 account JWTs, /v1/account/*)",
     optin="owner-selected Safe v1.4.1 passkey account (site/js/core/passkey-account.js, account-transport.js, account-providers.js; bundler/paymaster owner-chosen)",
     authority="default: Enclave relay accounts; opt-in: the owner's Safe on Base + owner-chosen bundler", alternative="opt-in Safe account; EOA wallet",
     source="UNTRACKED in main dirty tree (passkey-account.js, account-transport.js, account-providers.js, owner-signature.js)",
     deployed="root verified 3 full passkey UI tests in the integration tree (work/claude-browser-secrets-queued-task.txt ROOT FINAL BROWSER SESSION RESULT); deployed site: UNPROVEN (boot chunks show none of the new markers; complete-CAR check not run, see evidence/deployed-site-partial.json)", owner="root",
     gap="commit + site release; device linking for passkey accounts = adding owners to the Safe (passkey-aa-interface); relay accounts still exist and are not migrated",
     boundary="WebAuthn credentials are bound to an RP ID (an origin): moving the dashboard origin requires re-registering passkeys or keeping the RP")
feat("cli-device-login", "identity", "`enclave login` device flow (approve on phone/browser)", "implemented",
     default="relay device flow (/v1/account/device/*, site/js/pages/link.js committed c2bc3cc6)",
     optin="independent login: grant link to an owner-chosen frontend, approval watched on chain (cli/independent-login*.mjs)",
     authority="opt-in: none beyond Base RPC quorum + the owner's chosen frontend origin", alternative="itself",
     source="cli/independent-login.mjs, independent-login-cli.mjs UNTRACKED (dirty); dispatched at cli/enclave.mjs (independentLogin)",
     deployed="no receipt of a live independent login", owner="NONE",
     gap="uncommitted; no deployed frontend serves /grant for independent links (site/js/pages/grant.js modified, dirty)")
feat("app-sso", "identity", "'Sign in with Enclave' for tenant apps (jot, EyesOff, depot, api-mcp-adapter)", "owned",
     default="relay EST1 tokens signed by SSO_SIGNER_KEY (relay/sso.js)", optin="EAB1 binding snapshot pinned per deployment; passkey-only continuity",
     authority="default: Enclave SSO signer", alternative="contract-wallet sign-in with owner-pinned RPC quorum (app wallet.rs)",
     source="candidate work/app-auth-release-migration", deployed="outputs/app-auth-review/eyesoff-production-artifact.json (base build only; migration not proven)",
     owner="appsed8f", gap="migration continuity in progress")
feat("account-billing-card-credit", "identity/billing", "card top-ups, credit vault, order-provisioned deployments", "unowned-gap",
     default="relay billing (Stripe + company provisioner wallet, relay/provisioner.js; credit vault executed by relay)",
     optin="owner-chosen third-party fiat on-ramp to the owner's own wallet/Safe (passkey-independence-interface: EXTERNAL)",
     authority="Enclave relay + company wallet (custodial for order deployments)", alternative="wallet USDC/ETH funding (chain-direct)",
     source="relay/billing.js, provisioner.js (committed); no independent order flow implemented",
     deployed="hosted only", owner="NONE",
     gap="no independent equivalent for card-funded/credit-vault deployments (their records are company-owned); not to be labelled hosted-by-nature: needs an owner-held on-ramp design",
     boundary="Card payments require a payment processor; that is a legitimate business service, but the deployments it creates should be owner-held")

# ---------------------------------------------------------------- D. sessions
feat("session-budgets-management", "sessions", "agent sessions with budgets, scopes, expiry, top-up, revoke; management UI", "implemented",
     default="hosted sessions relayer/index (sdk/sessions constants; site sessions.js; CLI session new via RelayClient)",
     optin="CLI independent: session new|open|inspect|status|list|use|terminate|top-up|top-up-link|resume-wait|revoke-all|delegate (cli/enclave.mjs:3890-3896); browser quorumSessionClient (sessions.js, independent-chain.js)",
     authority="opt-in: the existing SessionVault factory/vault on Base + any gas payer", alternative="itself",
     source="DIRTY: cli/enclave.mjs modified (+1204 lines), site/js/core/sessions.js modified, independent-chain.js untracked",
     deployed="outputs/browser-existing-contract-sessions/verification.json (6 Chromium tests with first RPC offline; local); no production grant migrated",
     owner="browsera8b4+root", gap="commit + site deployment; existing grants untouched (correct per requirements)")

# ---------------------------------------------------------------- E. CLI
feat("cli-independent-commands", "CLI", "every CLI command usable without the Enclave API", "implemented",
     default="hosted API (api.enclave.host) + book", optin="--independent with reviewed profile or --contract-pins + >=2 RPCs",
     authority="opt-in: Base RPC quorum + owner-chosen directories/storage", alternative="itself",
     source="DIRTY cli/enclave.mjs: INDEPENDENT_COMMANDS covers 44 commands; only `secrets` refused (INDEPENDENT_REFUSALS, cli/enclave.mjs:5053-5057); host init|build|install|run|check|referral via cli/host-independent-lifecycle.mjs (untracked); availability via cli/independent-capacity.mjs (untracked)",
     deployed="not released (get.enclave.host installer builds from repo; uncommitted)", owner="root",
     gap="commit/release; work/cli-remaining-interface.txt is stale (it still lists availability NEEDS-PROTOCOL and account/login HOSTED-BY-NATURE)")
feat("cli-secrets-per-key", "CLI/secrets", "secrets set|ls|rm|clear one key at a time", "owned",
     default="relay-held secrets (plaintext visible to relay)", optin="custody v2 whole-map (custody status|set|migrate…); per-key owner read needs work/owner-secrets-interface.txt + new measured custodian image",
     authority="default: Enclave relay", alternative="custody v2 whole-map", source="owner-read interface written; not integrated",
     deployed="none", owner="browser7cfd", gap="owner-read custodian image unbuilt (root activation); browser Secrets CRUD queued for memory")

# ---------------------------------------------------------------- F. management plane
feat("logs-restart-attest-management", "management", "owner reads logs, restarts, attests, gets app tokens", "implemented",
     default="relay tenantRoute over fleet tunnel (api.enclave.host/t/<name>)",
     optin="operator-signed management records + direct supervisor routes (network/management-routes.mjs, management-client.mjs; browser independent-management.js)",
     authority="opt-in: the host's operator-signed record + owner session/wallet", alternative="itself",
     source="management-routes.mjs/management-client.mjs MODIFIED (dirty); site independent-management.js UNTRACKED; outputs/independent-host-integration.json: managementIncludingGpu 38/38 (fixtures)",
     deployed="outputs/independent-host-integration.json activation=false", owner="browsera8b4+policy354d", gap="activation; hosts must publish management records")
feat("private-app-access", "management", "private apps reachable only by their owner from a browser link", "unowned-gap",
     default="supervisor bounces to SIWE_URI/authorize, SIWE_URI default https://enclave.host (supervisor.js:86,5026); SIWE_DOMAIN default enclave.host (supervisor.js:85)",
     optin="host operator may set SIWE_URI/SIWE_DOMAIN (per host, not per owner)", authority="Enclave dashboard origin + enclave.host DNS by default",
     alternative="none per owner; session-signed native requests (session-api-auth.mjs) for non-browser", source="committed supervisor.js",
     deployed="production default", owner="NONE",
     gap="no owner-selectable sign-in origin for private apps; direct guests/independent dashboards cannot complete the private-app browser sign-in without enclave.host")

# ---------------------------------------------------------------- G. fleet / prices / availability / discovery
feat("fleet-prices-availability", "discovery", "dashboard/CLI show live hosts, prices, free capacity", "implemented",
     default="relay /availability and /enclaves (DEFAULT_TRUSTED_OPERATORS filter)",
     optin="registry prices on chain; host-signed capacity records (network/host-capacity*.mjs) read via `enclave availability --independent --capacity-directories|--hosts`; browser fleet-read.js (committed c2bc3cc6)",
     authority="opt-in: registry + host-signed records + chosen directories", alternative="itself",
     source="network/host-capacity.mjs, host-capacity-producer.mjs UNTRACKED; wired in supervisor.js and windows/node/agent.mjs (dirty)",
     deployed="no host publishes capacity records in production (not observed)", owner="root", gap="commit + host activation; directory hosting of capacity records")
feat("provider-bootstrap", "network", "anyone installs a WireGuard provider/checker", "implemented",
     default="explicit bootstrap (network/wg-provider/install.sh: --pins/--rpc/--directories required); Enclave defaults only with --legacy-enclave-defaults",
     authority="none on the default path", alternative="itself", source="committed 31052d2a",
     deployed="outputs/relay-free-network/activation.json: relay removed from Enclave providers; 'Providers/checkers remain Enclave-operated'",
     owner="root", gap="no independent operators (not required by the clarified goal)")
feat("contract-resolution", "chain", "clients find the platform contracts", "implemented",
     default="EnclaveAddressBook 0xab21… read via RPC (site/js/core/addressbook.js) — a LEGITIMATE admin authority on Base, not a server",
     optin="reviewed profile with addressBook (site config.js:116) or fixed pins; CLI --profile/--contract-pins with RPC quorum",
     authority="Enclave admin wallet via the book (retained by requirement)", alternative="-",
     source="site/js/core/addressbook.js (modified, dirty) still loops APP_CATALOG_RPCS and takes the FIRST answer (lines 21-31); quorum reader site/js/core/addressbook-reader.js is UNTRACKED",
     deployed="production site reads the book from public RPCs", owner="browsera8b4",
     gap="default browser read is first-answer, not an agreeing quorum (availability/integrity of the RPC read, not of the admin authority)")

# ---------------------------------------------------------------- H. publication / metadata
feat("publish-browser", "publication", "publish an app version + metadata (logos, banner) from the dashboard", "activation",
     default="IPFS_WALLET_AUDIENCE = \"\" (site/js/core/config.js:196) -> upload token from api.enclave.host; single adapter ipfs.enclave.host",
     optin="independent profile STORAGE_PLAN (config.js:199) with wallet-signed uploads (upload-auth.js)",
     authority="default: Enclave API upload-token issuer", alternative="storage plan + wallet signatures; CLI publish --storage-plan",
     source="dirty site (49 changed site entries)", deployed="outputs/adapter-current-cors.json (coordinator check 2026-10-20T05:51Z): production adapter sends NO Access-Control-Allow-Origin for https://enclave.host",
     owner="browsera8b4+browser7cfd", gap="adapter CORS + audience activation; the media (logo) path depends on the same adapter (logo-cache repairs in outputs)")
feat("publish-cli", "publication", "publish WASM/config/media from the CLI", "implemented",
     default="upload token + ipfs.enclave.host", optin="publish --storage-plan --wallet (multi-adapter, readback)",
     authority="opt-in: owner-chosen adapters", alternative="itself", source="committed/dirty cli", deployed="adapter wallet uploads live (prior audit)",
     owner="root", gap="independent adapters do not exist; availability only as good as the chosen replicas")
feat("site-and-ipns-release", "publication", "the website and its IPNS name move to a new release", "activation",
     default="IPNS publisher value = https://ipfs.enclave.host/site-root (mutable Enclave file)",
     optin="owner-signed `config set value=/ipfs/<CID>` (existing ledger) or optional ReleaseAnchor",
     authority="default: the site-root file on an Enclave server", alternative="existing ledger, no new contract",
     source="work/claude-ipns-production-cutover-result.md", deployed="IPNS seq 1026 points at bafybeieuxt6… (older); apex bafybeig3rai… (logos fix) newer; complete DAG only at ipfs.enclave.host",
     owner="ipnse49a+root", gap="publisher lease expired; second complete replica missing")

# ---------------------------------------------------------------- I. storage / volumes
feat("storage-writes-renewal", "storage", "artifact writes, Sia renewal and recovery", "owned",
     default="single indexd/PostgreSQL writer (minipc)", optin="C2 fencing (SDK + Go) with writer authority binding",
     authority="default: one Enclave writer", alternative="sealed snapshot reads with indexd blocked (read-only)",
     source="candidates work/storage-c2-implementation, work/indexd-c2-implementation, work/storage-front-binding", deployed="read-only recovery proven (prior)",
     owner="sdk3923+go6b7+front9d6a", gap="C2 interop and production rehearsal pending")
feat("encrypted-volumes", "storage", "user-held-key confidential volumes; recovery after host loss", "evidence-missing",
     default="key from the owner's wallet signature (enclave-apps/encrypted-volumes README); ciphertext in an owner-chosen S3 bucket; credentials sealed with a wallet-derived key",
     optin="vault app with EnclaveVolumeAccess ACL (book key volumeAccess 0xF999…; enclave-apps/vault)",
     authority="none for keys (wallet); bucket provider chosen by the owner", alternative="-",
     source="committed enclave-apps encrypted-volumes, vault", deployed="no receipt of a volume recovered on a different host or after host loss",
     owner="NONE", gap="no evidence of cross-host recovery; volume mount delivery path on direct guests not audited end to end")
feat("model-volumes", "storage", "per-box model volumes for GPU apps", "evidence-missing",
     default="supervisor DEP_MANIFEST_KEYS volumes (supervisor.js:1995, 10780)", authority="host-local", alternative="-",
     source="committed supervisor.js", deployed="not checked", owner="NONE", gap="not assessed for direct/Windows paths")

# ---------------------------------------------------------------- J. hosts, updates, runtimes
feat("windows-updates", "hosts", "Windows hosts auto-update", "activation",
     default="UNSIGNED get.enclave.host/windows/latest.json (HTTP 200 today); EnclaveSetup.cs:337 reads it",
     optin="signed channel: release-policy.json pins P-256 keys + mirrors (windows/node/release-channel.mjs, committed b470add2)",
     authority="default: whoever controls get.enclave.host; opt-in: operator-pinned release key", alternative="signed channel",
     source="committed b470add2", deployed="get.enclave.host/windows/latest.signed.json -> HTTP 404 (not published)",
     owner="NONE", gap="no signed release published; installer still reads the unsigned pointer; no host has a policy")
feat("linux-host-onboarding", "hosts", "install and run a Linux host", "implemented",
     default="enclave host init with relay tunnel defaults", optin="independent lifecycle (cli/host-independent-lifecycle.mjs, docs/network/independent-host-onboarding.md)",
     authority="opt-in: plan-recorded authorities only", alternative="itself", source="UNTRACKED lifecycle module; integration checks in outputs/independent-host-integration.json",
     deployed="activation=false", owner="gas40c+policy354d", gap="activation; app-paid leases (gas40c)")
feat("windows-host-onboarding", "hosts", "install and run a Windows host", "owned",
     default="installer requires relay name check; identity $Relay/t/$Name", optin="--no-relay (EnclaveSetup.cs:20)",
     authority="default: Enclave relay", alternative="--no-relay", source="committed installer", deployed="outputs/windows-independence/native-review.json",
     owner="gas40c+policy354d", gap="Windows lease/heartbeat parity (gas40c); policy enforcement (policy354d)")
feat("host-liveness", "hosts", "hosts visible as live without periodic on-chain writes", "activation",
     default="registry lastSeen heartbeats", optin="authenticated off-chain liveness (network/host-liveness.mjs)",
     authority="opt-in: host-signed liveness", alternative="itself", source="integrated (offchain-heartbeats completed-source-integrated)",
     deployed="not activated", owner="heartbeat9d6a+browsera8b4", gap="activation")
feat("pvm-android", "runtimes", "Android pVM hosts and market", "unowned-gap",
     default="relay/pvm-*.mjs, pvm-market (committed c2bc3cc6)", authority="Enclave relay", alternative="none",
     source="committed relay modules", deployed="not checked", owner="NONE", gap="no independent path; not audited by any workstream")
feat("release-tooling-nan", "operations", "publishing tooling for site, relay, Android host", "unowned-gap",
     default="scripts/publish-android-host.sh and relay/deploy.sh still reference Nan/SSH (grep)", authority="retired Nan host",
     alternative="site-release tooling (site/deploy.sh no longer matched)", source="committed scripts", deployed="-",
     owner="NONE", gap="retarget or retire scripts/publish-android-host.sh and relay/deploy.sh")
feat("eyesoff-attestation", "apps", "in-app attestation display (EyesOff)", "owned",
     default="DEFAULT_SOURCE https://api.enclave.host (eyesoff-ai/src/attest.rs:50); sources configurable", authority="Enclave API by default",
     alternative="configured record sources", source="committed enclave-apps", deployed="-", owner="appsed8f", gap="default source")
feat("hosted-mcp", "agents", "coding-agent MCP front door (read tools + build_* unsigned transactions) at mcp.enclave.host", "unowned-gap",
     default="relay/mcp.js on mcp.enclave.host: read tools go through the relay's own /v1 gateway (relay/mcp.js header)", optin="none (the CLI covers the same actions, but not over MCP)",
     authority="Enclave relay + mcp.enclave.host", alternative="CLI --independent (not an MCP server); enclave-apps api-mcp-adapter turns arbitrary HTTP APIs into MCP, it is NOT the platform-tools server",
     source="dirty relay/mcp.js", deployed="hosted", owner="NONE", gap="no locally runnable or profile-driven platform MCP server (quorum reads, unsigned build_* from pinned profile)")
feat("lease-recovery-moves", "deployments", "move a deployment / recover after host loss", "implemented",
     default="relay evacuate + claim hint", optin="management release + owner-named claim hint (independent move)",
     authority="ledger lease holder ends leases", alternative="wait out leaseSec",
     source="dirty cli move; work/independent-move-interface.txt", deployed="-", owner="root+gas40c", gap="commit/release; app-paid claim/renew for running self-hosted deployments is gas40c's scope")

def main():
    ev = {}
    p = os.path.join(HERE, "evidence/deployed-site-apex.json")
    if os.path.exists(p):
        ev["deployedSite"] = json.load(open(p))
    q = os.path.join(HERE, "evidence/deployed-site-partial.json")
    if os.path.exists(q):
        ev["deployedSitePartial"] = json.load(open(q))
    cats = {}
    for f in F: cats.setdefault(f["category"], []).append(f["id"])
    rank = ["native-websocket", "private-app-access", "app-zone-certificates", "hosted-mcp", "windows-updates", "custom-domains-direct-snp", "custom-domains-windows-shield",
            "native-writes-streaming", "account-billing-card-credit", "native-browser", "release-tooling-nan", "pvm-android",
            "encrypted-volumes", "model-volumes", "cli-device-login"]
    out = {
        "kind": "current-feature-parity-audit", "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "readOnly": True, "requirements": "work/effective-goal-requirements.txt (admin governance, original contracts and abuse enforcement retained; removal of required centralized SERVER dependencies)",
        "snapshot": {"enclave": "fd1cc627 + 233 uncommitted/untracked entries", "enclaveApps": "50f93d74", "historicalAudit": "outputs/decentralization-audit/feature-parity.md (2026-10-19, 48390694) - superseded where it treated admin powers/book as authorities to remove"},
        "categories": cats, "rankedUnownedOrUnprovenGaps": rank, "features": F, "evidence": ev,
        "owners": OWNERS,
    }
    json.dump(out, open(os.path.join(HERE, "feature-parity.json"), "w"), indent=2)
    print(json.dumps({k: len(v) for k, v in cats.items()}))

if __name__ == "__main__":
    main()

def render():
    d = json.load(open(os.path.join(HERE, "feature-parity.json")))
    by = {f["id"]: f for f in d["features"]}
    L = []
    w = L.append
    w("CURRENT FEATURE-PARITY AUDIT (read-only) - " + d["generatedAt"])
    w("Requirements: " + d["requirements"])
    w("Snapshot: enclave " + d["snapshot"]["enclave"] + "; enclave-apps " + d["snapshot"]["enclaveApps"])
    w("Supersedes: " + d["snapshot"]["historicalAudit"])
    w("")
    w("RULES APPLIED")
    w("  - Source != deployed. 'committed' = in HEAD; 'dirty' = in the uncommitted main integration tree; 'candidate' = a")
    w("    worker tree. A helper, doc, test name or green unit test is not end-to-end proof; receipts are cited where they exist.")
    w("  - EnclaveAddressBook and the admin wallet are legitimate authorities (not server dependencies); admin moderation,")
    w("    catalog delisting and host bans are retained, never counted as gaps.")
    w("  - No feature is excluded as 'hosted-by-nature': each keeps its prior semantics, and the missing owner-held path is named.")
    w("")
    part = d.get("evidence", {}).get("deployedSitePartial")
    if part:
        w("DEPLOYED SITE (partial, read-only): " + part["method"])
        w("  chunk-35X5LJ5N.js references api.enclave.host/v1; no independent-mode, profile, passkey-profile, startup-package or owner-name")
        w("  markers in the boot chunks. " + part["limits"])
        w("")
    site = d.get("evidence", {}).get("deployedSite")
    if site:
        w("DEPLOYED SITE CHECK (apex " + site["cid"] + ", complete CAR verified, " + str(site["verifiedFiles"]) + " files, " + str(site["jsFiles"]) + " .js)")
        for k, v in site["markers"].items():
            w(f"  {k:18} in {v['files']} files {('e.g. ' + ', '.join(v['hits'][:3])) if v['hits'] else ''}")
        w("")
    w("RANKED GAPS: unowned or unproven (highest first)")
    for i, fid in enumerate(d["rankedUnownedOrUnprovenGaps"], 1):
        f = by[fid]
        w(f"{i:2}. [{f['category']}] {fid} ({f['area']}) - owner: {f['owner']}")
        w(f"    prior feature: {f['priorSemantics']}")
        w(f"    default: {f['defaultPath']}")
        if f.get("optInPath"): w(f"    opt-in : {f['optInPath']}")
        w(f"    gap    : {f['gap']}")
        if f.get("trustBoundary"): w(f"    boundary: {f['trustBoundary']}")
    w("")
    for cat, title in [("unowned-gap", "INCOMPLETE / UNOWNED"), ("activation", "ACTIVATION PENDING"), ("owned", "ACTIVELY OWNED ELSEWHERE"),
                       ("implemented", "CURRENT SOURCE PATH IMPLEMENTED (not deployed unless a receipt says so)"), ("evidence-missing", "EVIDENCE MISSING")]:
        w(title)
        for fid in d["categories"].get(cat, []):
            f = by[fid]
            w(f"  - {fid} [{f['owner']}]: {f['priorSemantics']}")
            w(f"      authority now: {f['requiredServerOrAuthority']}")
            w(f"      alternative  : {f['availableAlternative']}")
            w(f"      source       : {f['sourceEvidence']}")
            w(f"      deployed     : {f['deployedEvidence']}")
            w(f"      remaining    : {f['gap']}")
        w("")
    w("OWNERS REFERENCED")
    for k, v in d["owners"].items(): w(f"  {k:14} {v}")
    w("")
    w("GENUINE TRUST BOUNDARIES (not removable by software; stated, not counted as gaps)")
    for f in d["features"]:
        if f.get("trustBoundary"): w(f"  - {f['id']}: {f['trustBoundary']}")
    open(os.path.join(HERE, "feature-parity.txt"), "w").write("\n".join(L) + "\n")

if __name__ == "__main__":
    render()
