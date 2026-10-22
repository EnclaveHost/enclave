# Moving the eu-central DigitalOcean lease relay into the warden (metal0) Linux host role

Status: PREPARED, NOT EXECUTED. Nothing in this workspace has touched production. It made no probe, no write, no
signature and no key, env, DB or backup read. Root owns every step below.

Update 2026-10-21, later: the TARGET is now the USER-SERVICE variant (`work/eu-relay-user-target`, RUNBOOK.md).
- Root's readiness found no `/opt/enclave` checkout and no non-interactive sudo on warden-host, so the root-only target
  scripts in `root/warden-*.sh` stay as tested evidence and are not the activation path.
- The source side (`root/eu-source-*.sh`) is unchanged and is reused byte for byte.

Update 2026-10-21 (root review 57471):
- Root accepted D1: the funded C5 key moves by the opaque one-active-key journal migration.
- P1 now has a source candidate, `work/pinned-host-relay`. It adds an explicit pinned host-local relay mode, using the
  existing signed-statement and platform-admission proof. It is source only until root composes it, rebuilds once and
  runs a canary.
- Section 2b gives the exact reach paths: Linux at `http://10.0.2.2:8549`; the Windows fallback through a tightly
  bound LAN listener. It also gives the binds, the exposure and root's preflight.
- The cutover stays blocked until that candidate is composed, its image is canaried, and the preflight passes.

## 1. What has to move, and what depends on it (public evidence only)

- **The relay.**
  - App-funded lease relay, payee `0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a`, on DO eu-central `134.209.248.172`.
  - It runs the same reviewed kit as us-west (`work/lease-relay-activation/final-94f4ebdf`):
    - unit `enclave-lease-relay.service` 4b3e5ac7 (credential copy), relay.env 7c05d44a, artifact 94f4ebdf;
    - key `/var/lib/enclave-lease-relay/relay.key`;
    - journal `/var/lib/private/enclave-lease-relay-state/relay-send.json`.
  - Its https front is the enclave-bootstrap-tls Caddy, which serves an IP certificate for 134.209.248.172
    (`work/lease-relay-activation/caddy/*`, tlsVerified).
- **Its consumers.**
  - **Linux (metal0 control CVM).** This is its ONLY relay. Root removed the retired us-west entry from
    `leaseGas.relays`, so the list is just `https://134.209.248.172`
    (`work/linux-post-adoption-release/activation/ROOT-STAGING-STATE.txt`). Linux activation root18996 is in progress;
    it is not touched here.
  - **Windows (minipc).** It uses its local relay `0x51ff…` first, and eu-central only as a fallback
    (`work/windows-local-relay-postcutover`, ACCEPTED).

## 2. The finding that decides the order: no existing path lets the CVM reach a relay on warden

I checked the code, current main, against the public evidence:

| path | what the code does | usable for the CVM → warden relay? |
| --- | --- | --- |
| configured relays (`ENCLAVE_LEASE_GAS_RELAYS`) | `client/lease-executor-client.mjs validateRelayUrl`: https only (http only on loopback), default Node trust. `network/lease-gas-conduit.mjs` carries exactly six names into the guest: no CA, no `LOCAL_RELAY`, no `SERVICE_INDEX` | needs a **WebPKI certificate** for a name or IP the CVM reaches on warden. None exists (below) |
| `LOCAL_RELAY` | `validateLocalRelayUrl`: 127.0.0.1/[::1] only. Inside the CVM that is the CVM itself, and the conduit does not carry it | no |
| designated relays via the service index (`SERVICE_INDEX`, `lease-relay-discovery.mjs`) | authenticated by the relay's signed statement plus the platform policy admission, "over https or plain http alike" | **no**: `network/service-index.mjs` drops loopback, private and link-local endpoints, and the conduit does not carry `SERVICE_INDEX`. The ad itself also needs a public endpoint (`lease-relay-host.mjs advertise`: "a public address; not a DigitalOcean one"). The S4 review found none: one site, one ISP NAT, every interface private (`outputs/decentralization-audit/host-relay-s4-feasibility*.json`, `non-do-ingress-*-observation.json`) |
| integrated certificate hosting (27 paths, `certificate-hosted-integration.json`) | `app-zone-challenge.mjs`, `challenge-replica-host.mjs`, `isolation/m2/front/appzone.go`: DNS-01 is answered only for `_acme-challenge.<deployment label>.<appZone>` pushes from **attested direct guests** bound to a live lease | **no**: it has no host-role subject, and the CA reaches it through the app zone's NS delegation, which is only `ns-{us-west,eu-central,ap-southeast,ca-east}.enclave.host` (`outputs/provider-dns-delegation.json`), all DO |
| any other DNS-01 / HTTP-01 issuance for a name pointing at warden (10.0.100.1 / LAN) | no code exists for it. `app.` and `ip.enclave.host` are delegated only to the DO NS. The apex's DNS host is not in the evidence. HTTP-01 / TLS-ALPN-01 would need public non-DO ingress, which does not exist | **unavailable** |

Rejected, because each would loosen TLS, admin or pinning, or use DO silently:
- a DO proxy or keeping the Caddy front;
- `NODE_EXTRA_CA_CERTS` in the measured supervisor (a process-wide extra trust anchor for every https call it makes,
  RPCs included);
- re-serving the DO IP certificate from warden;
- a guest-side plaintext forwarder (a new transport).

**Consequence.** Stopping eu-central today would leave Linux with ZERO relays (`NotRelayed`, never operator-paid), and
Windows without its fallback. So the source stop (stage C below) is **blocked** until prerequisite P1 is met. Everything
before it is prepared and can be staged without effect.

## 2b. P1 resolved in source: the pinned host-local relay (work/pinned-host-relay), and how each host reaches it

**The mode.** Main's lease client, shared runtime and conduit, with ONE explicit opt-in addition:
- **Configuration:** `ENCLAVE_LEASE_GAS_PINNED_RELAYS="origin,payee,operator"`, or the conduit's
  `leaseGas.pinnedRelays: [{origin, payee, operator}]`.
  - The origin is a private IPv4 literal with an explicit port, written as its bare origin.
  - No DNS name, credentials, path, query, fragment or redirect is accepted.
- **Before ANY signature** (the lease, and the EIP-7702 authorization, which is now signed lazily):
  1. the relay's fresh signed statement must recover to the pinned payee for this chain, reserve and executor;
  2. the platform host policy must admit the pinned operator NOW.
  - These are the same checks as for a service-index relay.
  - With the policy off, unreadable or banning the operator, no signature is made, and the operator's ETH is never
    used.
- **What does not change:**
  - public https relays, the Windows loopback relay and discovery (which still drops private endpoints);
  - every absent-config transit, guest env and direct-config digest (proven equal to main's).

**Linux (metal0 control CVM).**
- **Path.** The CVM runs under `metal/enclave-metal.mjs` with `-netdev user` (slirp, `netdev()`). From inside the
  guest, `10.0.2.2:<port>` is the HOST'S OWN LOOPBACK. The egress helper and the shielded GPU workers already use this
  pattern (`enclave-metal.mjs` 317–345, 496–508).
- **Bind.** The host role keeps `relay.bind 127.0.0.1`, port 8549 (config/host-relay.template.json, unchanged).
  - No firewall change, no new interface exposure, no hostfwd.
  - The guest already reaches host loopback through slirp; it gains one more loopback service, speaking the public
    relay protocol.
- **Bound value** (host config `leaseGas`, or the HOST_DATA-bound direct config, in the checked form):

  ```
  "pinnedRelays": [{ "origin": "http://10.0.2.2:8549", "payee": "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a",
                     "operator": "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB" }]
  ```

  - Keep `relays: ["https://134.209.248.172"]` until the move. Pinned relays are tried before configured https relays.
  - Before the move, `10.0.2.2:8549` refuses the connection and the DO relay serves.
  - After the move, the pinned relay serves; the DO entry is then removed in a later reviewed config.
- **Root preflight on warden (read-only):**
  - `ps -o args= -C qemu-system-x86_64` for metal0's control CVM shows `-netdev user,id=net0` with no `restrict=on`;
  - `ss -Hltn 'sport = :8549'` is empty before activation, and afterwards only `127.0.0.1:8549`;
  - Canary after activation: the CVM's supervisor log shows a claim or renewal landed "via http://10.0.2.2:8549", and
    the audit shows `LeaseGasPaid` to `0xC5D8…`.

**Windows fallback (minipc → warden LAN), optional, a separate later rollout.**
- **Templates, not installed:** `config/enclave-host-relay-lan.socket` (f73cc48c) and `.service` (4e17ba35).
  - One listener, `192.168.8.249:8549`, `BindToDevice=<warden LAN interface>`.
  - `IPAddressDeny=any` and `IPAddressAllow=192.168.8.238/32 192.168.8.148/32` (minipc only), on both the socket and
    the forwarder.
  - The forwarder is `systemd-socket-proxyd 127.0.0.1:8549`.
  - Nothing else is exposed: no 0.0.0.0 bind, no ZeroTier, no virbr exposure, no firewall ruleset change. The relay
    itself still binds loopback only.
- **minipc setting** (it needs the rebuilt Windows lease runtime bundle and a reviewed `lease-gas-config.cmd` change. Both
  are within the human's DO-removal authorization; root performs them, and this workstream only prepares them):

  ```
  ENCLAVE_LEASE_GAS_PINNED_RELAYS=http://192.168.8.249:8549,0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a,0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB
  ```

  - This sits after its own `LOCAL_RELAY` (0x51ff…).
  - `lease-gas-config-check.mjs --expect-pinned` verifies the file.
- **Root preflight (read-only):**
  - warden: `ip -4 -o addr show` names the LAN interface holding `192.168.8.249`;
  - warden: `test -x /usr/lib/systemd/systemd-socket-proxyd`;
  - warden: `systemctl --version` is 235 or later (IPAddressAllow on sockets);
  - warden: `ss -Hltn 'sport = :8549'` shows only `127.0.0.1:8549`;
  - minipc: `Get-NetIPAddress -AddressFamily IPv4` equals `.238`/`.148`;
  - the router's DHCP reservations for warden `.249` and minipc `.238`/`.148`.
  - If any address differs, the pinned fallback fails closed (connection refused, or no statement), and the templates
    are corrected before install.

**Admission authority.**
- The relay ROLE on warden is admitted by the platform host policy gate keyed by metal0's registered endpoint (ban
  stops it, admit restarts it).
- The compute host's use of it is admitted by the same platform policy, judging the pinned operator before every
  operation.
- Neither consults the host ownership extension (re-proved in `work/pinned-host-relay` tests). The metal0 owner
  enrollment (bbd885, three unsigned operations) remains a separate, missing feature.

## 3. The feasible, prepared part: the service itself as main's host role (no code change)

**Reuse, exactly** (all main, unchanged):
- `network/host-services/lease-relay-host.mjs` 05b7c409 (`init` / `check` / `run`). Its platform host policy gate
  `network/host-service-gate.mjs` STOPS the relay on a ban and restarts it on the admin's admit. The CLI `run` stays up
  under a refusal, so an unban works.
- `relay/systemd/enclave-host-relay.service` d279eb49: DynamicUser, StateDirectory, MemoryMax=512M.
- The package `scripts/build-lease-relay-host-package.mjs`, built here from main and checked reproducible:
  - pin `sha256:e3ae3c74cdc47a65a477f2f47e154bde7780bef55e893a1a15e4a64b074dc414`;
  - bundle `ae4f9127…` (447 inputs).
- The gate `network/lease-relay-migration-check.mjs`, built: `80d64e2f…`, identical to root's integrated build.
- The transfer `transfer-lib.sh copy_create_only`, byte-identical to the one used for us-west → minipc (scp -3 SFTP).
- The source stop and restore are the us-west scripts with only the names changed, plus one stricter rule (below).

**Same payee and journal.**
- The role's `init` keeps an existing `relay.key` whenever `relay.address` exists (tested). The move puts the key and
  the STOPPED journal into `/var/lib/private/enclave-host-relay/lease-relay/`, and root writes `relay.address`.
- `relay.address` is only a label: the relay serves the address derived from the key (tested with a wrong label). So
  activation checks the running `/v1/info`, not the file.
- The journal format is the same `{}` or `{nonce, raw, hash}` (`client/lease-executor-client.mjs` 354–362), and the
  gate checks it against the chain before the start.

**Root decision D1: importing the key.** The role documents its key as "generated here, never imported"
(`lease-relay-host.mjs` header, the package manifest's `secrets`, `planHostRelay`'s message). Moving the eu-central
key into it is mechanically supported, but it is a deliberate exception to that documented rule.
- The alternative is a fresh key from `init`. That needs the operator to fund a new float, which is spending and not
  authorized, and it leaves the old key's float on the stopped key (moving it out needs a signed spend).
- **Recommendation: import.** It keeps the payee, the float and the journal, and it needs no funds movement.

**Configuration** (`config/host-relay.template.json`; `root/render-host-relay-config.mjs` fills the four relay values
from eu-central's reviewed relay.env, CAS 7c05d44a):
- `host.endpoint` `https://api.enclave.host/t/metal0`. Its keccak is metal0's registry id `0x4dde6d1b…` (tested), so
  the gate judges metal0's operator `0xc9d0…`.
- `publicEndpoints: []`: there is nothing to advertise (P3).
- `platformHostPolicy "production"`, with carriers `{ importDir: /etc/enclave/platform-policy-import, serviceIndex:
  true }` on the pinned index `0x54dEcb43…` / `0x6969…`. The production mirrors are the four DO IPs, so cold start
  without DO needs a carrier. While no policy is anchored the gate admits "not-activated". Once root anchors one,
  import the admin-signed document into importDir.
- `relay.bind 127.0.0.1:8549`: host-only until P1 decides the bind.
- `heapMiB 128`; the unit's MemoryMax=512M is the real limit. The DO unit measured 192M.

### Stages (each with its own rollback)

**A. Stage on warden.** No effect; can be done now if root approves. Rollback: `warden-stage.sh --unstage`.
1. Workstation: render the configuration.

   ```
   node root/render-host-relay-config.mjs <reviewed relay.env 7c05d44a> stage/host-relay.json
   ```

   Then copy `package/lease-relay.mjs`, `package/lease-relay.package.json`,
   `package/gate/lease-relay-migration-check.mjs`, `config/lease-gas-deployment.json` (1665c218) and
   `config/enclave-host-relay.service` into `stage/`.
2. Warden: `sudo bash warden-stage.sh --check <stage>`, then `--stage <stage>`.
   - The check requires a reviewed checkout at `/opt/enclave` (lease-relay-host.mjs 05b7c409 plus `node_modules/viem`)
     and `/usr/bin/node` >= 22. Those are **prerequisite P4**: not known on warden from public evidence.
   - The **unit is deliberately NOT installed**. With no unit nothing can start the role, so `init` can never make a
     fresh key in the directory the moved key goes to. The state directory is created empty, 0700.

**B. Verify the stage** (read-only): `warden-stage.sh --check` shows the stage, and `warden-activate.sh --check` must
refuse ("moved key is not …") until the transfer.

**C. Cutover. BLOCKED until:**
1. root composes `work/pinned-host-relay`, rebuilds, and canaries a control image whose bound `leaseGas` carries the
   Linux `pinnedRelays` above (alongside the DO relay);
2. the section 2b Linux preflight passes.

Run it outside a root activation window.
1. eu-central: `sudo bash eu-source-stop.sh --check`, then `--stop`. This is the established stop: CAS on the unit
   and env, a protected rollback copy, stop verified on every channel, the stopped journal captured, disable, the
   unit moved aside, masked, the receipt.
2. Workstation: `bash transfer-to-warden.sh eu-central warden`.
   - It writes **`transfer-begun` on the source first**, then copies the journal, then the key (create-only,
     host-side sha256).
   - If the key verifiably did not arrive, it records `transfer-key-not-delivered` on the source.
3. Warden: `sudo bash warden-activate.sh --check`, then `--activate`. In order:
   - relay.address = `0xC5D8…` (create-only);
   - **the gate**, with an explicit environment: the staged public settings, the moved journal, the expected payee,
     and `SOURCE_ORIGIN=https://134.209.248.172` (must not answer as the payee);
   - **`target-ever-started`**, written before anything can start;
   - the unit installed (CAS d279eb49), started;
   - `/v1/info` must be exactly `0xC5D8…` on chain 8453 with the record's reserve and executor. Otherwise it is
     stopped, moved aside and masked (exit 4). With no answer within 120 s (a start failure or a policy refusal) it is
     stopped and disabled (exit 1);
   - then enabled, and the receipt written.
4. Consumers:
   - Linux uses the pinned relay immediately: it was configured in step 0 of the canary image.
   - Confirm with the supervisor log line "landed … via http://10.0.2.2:8549", then remove the DO entry in a later
     reviewed config.
   - Windows' fallback (P2) is a separate rollout. Root's lanes.
5. Acceptance: the established read-only audit pattern (`work/windows-local-relay-postcutover`, quorum-verified
   `LeaseGasPaid` to `0xC5D8…` after the activation block, plus warden's own relay log lines).

### Rollback, and the stale-journal rule

**The rule: the DO source never restarts from a stale journal once the target may have run.**
- `eu-source-restore.sh --abort-before-transfer` is allowed only if no transfer began, or if the transfer script
  proved the key never reached warden. Otherwise it refuses. The us-west version decided this from the absence of a
  returned record, which cannot tell "never started" from "started, journal not returned yet". This is stricter.
- After any transfer, the only way back is:
  1. warden: `warden-out-of-service.sh` (stop, disable, move aside, mask; verified inactive, no process, no :8549,
     no payee answer; receipt with the journal's sha);
  2. workstation: `transfer-journal-back.sh warden eu-central`. It refuses unless warden is out of service now and
     its journal is the one in the receipt;
  3. eu-central: `eu-source-restore.sh --after-target-start --target-out-of-service <gate>`. The gate must pass for
     the returned journal; the stale record is kept aside; then the source restarts.
- A second activation on warden, or a second transfer from the same source, refuses: a new move needs a new review.

## 4. Prerequisites (not fabricated; none is available to this workstream)

- **P1: the CVM's path to the warden relay, without DO and without loosening TLS.** RESOLVED IN SOURCE as P1-b
  (section 2b; `work/pinned-host-relay`). It awaits root's composition, rebuild and canary. Original analysis kept for
  the record:
  - **P1-a: a WebPKI certificate (no code change).** A name the CVM resolves to warden (its host DNS 10.0.100.1, or
    public DNS to a private address), with a certificate issued by DNS-01 in a zone whose authority is NOT the DO NS,
    renewed at most every 90 days. It also needs a TLS terminator on warden in front of `127.0.0.1:8549`. None of
    this exists today: the zone/DNS host, the ACME account and the terminator are all missing.
  - **P1-b: a small code change inside the existing architecture.** This is NOT implemented, as instructed. Exact
    scope:
    1. `network/lease-gas-conduit.mjs`: an optional bound transit field `pinnedRelays: [{origin, payee, operator}]`,
       with `origin` an `http://` IP literal inside the host bridge network, and one new env name
       `ENCLAVE_LEASE_GAS_PINNED_RELAYS`.
    2. `network/lease-gas-runtime.mjs`: parse it.
    3. `client/lease-executor-client.mjs createLeaseClient`: these entries take the existing **discovered-relay**
       branch: `verifyRelayStatement` against the pinned payee, plus `admitDiscoveredRelay(operator)` under the guest's
       platform host policy before every signature. That is the rule main already applies to index-discovered relays
       "over https or plain http alike", so a banned metal0 operator is refused.
    4. `metal/guest/gsup.mjs` and `measured-control.mjs` pass the new name.
    5. Rebuild the conduit and platform-api bundles: a **new measured control image** (new measurement). It must wait
       until root's Linux activation (root18996) is finished, and be released separately.
    6. Tests: transit round trip, runtime parse, wrong-payee statement refused, banned operator refused, a non-bridge
       origin refused.

    It drops WebPKI for this one host-local link in favour of the payee's signed statement plus policy admission.
    That is an **explicit TLS-rule decision** for root or the human, not something this workstream may assume.
- **P2: Windows' eu-central fallback.**
  - Once the source stops, Windows still works on its local `0x51ff…`, but it loses the fallback.
  - Re-pointing it at warden (LAN `192.168.8.249`) now uses the pinned mode and the LAN listener templates
    (section 2b), not a certificate.
  - It still needs a rebuilt Windows lease runtime bundle (a new Windows release) and a settings change. Root performs
    these under the human's DO-removal authorization; this workstream prepares them and changes no production
    setting.
- **P3: designated-relay advertisement (optional for this move).**
  - It needs a public non-DO endpoint, and none exists.
  - It also needs the operator `0xc9d0…` to sign the service-index ad (the unsigned typed data comes from
    `lease-relay-host.mjs descriptor` + `advertise`).
  - Not viable now, so no ad inputs are produced.
- **P4: warden runtime.** A reviewed main checkout at `/opt/enclave` (05b7c409 plus node_modules) and node >= 22 at
  `/usr/bin/node`, or an equivalent reviewed path change to the unit. `warden-stage.sh --check` reports both.
- **Not a prerequisite: the metal0 owner enrollment.**
  - The three unsigned operations are in `outputs/metal0-production-owner-enrollment` (ownership extension `bbd885…`,
    owner 0 / pending 0).
  - The host-role gate judges the operator under the platform policy and reads no owner (`host-service-gate.mjs` has
    no owner logic).
  - It is unchanged and stays unsigned.

## 5. Inventory

See `inventory.json` (sha256 of every file) and `logs/` (the build and test evidence).
