# dns-01 push credentials: retiring the fleet HMAC

Status: design plus Stage 1 code for review. Branch `security/relay-txt-key`, stacked on U7 (`security/u7-eligible-routing` @ `18772bf7`). Nothing is deployed. No key was generated, read or rotated, no certificate was minted, and no DNS was pushed. Every key in the tests is synthetic.

## The problem

The DNS relay (`relay/dns-relay.js`, `POST /v1/txt`) publishes `_acme-challenge` TXT records, and a CA issues a certificate to whoever can put one there. One credential it accepts is the **fleet HMAC**:
- the key is `DNS_TXT_KEY = HMAC(fleet SECRET, "enclave dns-txt v1")`;
- every first-party box derives it from the fleet `SECRET`, and on metal that secret sits in an operator-readable file outside the CVM;
- it names no box.

U7 narrowed it:
- a deployment's name needs a live lease with an eligible holder;
- zone apexes are refused.

A holder of the fleet SECRET can still answer dns-01 for:
- a deployment whose holder IS eligible, i.e. another tenant;
- a non-deployment label;
- a deeper name;
- any box hostname.

Goal: a fleet SECRET holder authorizes **nothing** at the DNS relay. Every legitimate writer keeps working.

## Every legitimate TXT writer today (traced from source)

| writer | where | names it pushes | credential it sends | live today |
|---|---|---|---|---|
| **W1: platform certificate service** | `relay/certs.js` `dnsTxt` (api relay) | app/tcp deployment labels; a verified custom domain's alias (the deployment's own label) | `x-relay-sig` with `DNS_TXT_KEY` (the api relay's env holds the fleet-derived key) | **yes**: it issues for metal-iso0 |
| **W2: supervisor, in-enclave ACME** | `supervisor.js` `dnsTxt`, CA slots 1-3 (ZeroSSL with EAB, Let's Encrypt) | app-zone deployment labels and custom-domain aliases | `x-relay-sig` with the fleet-derived key, **plus** `x-operator-sig` and `deploymentId` when the name maps to a local 64-hex deployment and `REGISTRY_PRIVATE_KEY` is set | configured only on the Tinfoil images (`enclaves/{cpu,gpu,gpu8}`); **no Tinfoil box is live** (per 5d's preflight: `/enclaves` lists metal-iso0 and us-west) |
| metal guests | `metal/enclave-metal.mjs`, `metal/guest/gsup.mjs` | none: the launcher forwards `certsApi` (and a ZeroSSL pair only under `acmeBringYourOwn`) but never `DNS_API`, so its in-enclave slots cannot push TXT | none | never push |
| Windows node | `windows/node/apptls.mjs` | none: it uses `/v1/certs/issue`, operator-signed | none | never pushes |
| box-zone names | none found (supervisor, metal, windows, certs.js) | n/a | the DNS relay's operator "box zone" branch exists but nothing calls it | n/a |

How the supervisor chooses a path (`acmeSlotsFor`, `acmeWalkSlots`):
- **Slot 0**, for own-zone names and verified custom domains, is the platform service (`POST {CERTS_API}/v1/certs/issue`).
  - It requires an operator signature (`opSig`).
  - The fleet-derived `CERTS_KEY` HMAC is only an optional extra factor.
  - The relay then checks that the lease's runner equals the caller's endpoint, and that the holder is eligible (U7 step 6b). The relay itself answers dns-01, as W1.
- The in-enclave CAs (W2) run only in three cases:
  - after a slot-0 **refusal** (4xx);
  - after a 5xx or network failure has cooled slot 0 off;
  - when `CERTS_API` is unset.
- A 202 waits and asks again with the same key.
- `TCP_CERT_DOMAIN` is unset in every Tinfoil config, so W2 issues no tcp-zone names. (Its `certNameDeployment` matches only `APP_CERT_DOMAIN`, so it would send no operator signature for them anyway.)

## End state

The DNS relay accepts exactly two kinds of authority:
1. **`RELAY_TXT_KEY`**: the relays' own key.
   - 64 hex characters, generated for the api relay and the DNS relay, and **never** derived from the fleet SECRET, so no box holds it.
   - It carries what the fleet HMAC carries today, under the same U7 rules: a deployment's name needs an eligible, live holder, and apexes are refused.
   - W1 signs with it.
2. **Operator signatures** (unchanged): a box's registry operator can answer only for the deployments whose live lease it holds with an eligible runner, and for its own registered box name.

`FLEET_TXT_HMAC=off` then makes the fleet HMAC authorize nothing.

## Staged migration

**Stage 1: code (this branch). Inert until configured; one relay push; no supervisor release.**
- `relay/dns-relay.js`:
  - `RELAY_TXT_KEY` is verified from the `x-relay-txt-sig` header, checked first, and passes through the same U7 gate as the fleet HMAC.
  - It is disabled with an error if it is malformed or equal to `DNS_TXT_KEY`.
  - `FLEET_TXT_HMAC` takes `on` (the default: today's behaviour) or `off`. Only the exact word `off` turns it off; an unknown word leaves it on and logs an error.
  - `/health` gains non-secret `pushAuth` fields: `relayKey`, `fleetHmac`, and `authorizedBy` counters (`relayKey`, `operator`, `fleetHmac`, `fleetHmacOnly`, `fleetHmacIgnored`).
  - `fleetHmacOnly` counts pushes that nothing but the fleet HMAC could authorize: there's no relay key, and no operator signature that verifies. Each one is logged with its name.
- `relay/certs.js`:
  - signs with `RELAY_TXT_KEY` (`x-relay-txt-sig`) when it is set, and adds `x-relay-sig` only while `DNS_TXT_KEY` is still configured;
  - needs either key at init;
  - ignores, with an error, a relay key equal to `DNS_TXT_KEY`.
- Unset, both behave exactly as before.

**Stage 2: config (operator; no code).**
1. Generate a fresh random 32-byte `RELAY_TXT_KEY` **on a relay host**. It must never be derived from the fleet SECRET, and never go into git or a CI log.
2. Put it in `/etc/nan-relay/dns.env` (nan-relay) and `/etc/nan-relay/api-relay.env` (nan), mode 600.
3. Restart the **DNS relay first** so it accepts the header, then the api relay so it starts sending it.
4. Check:
   - DNS `/health` shows `pushAuth.relayKey: true`;
   - the api relay logs `[certs] dns-01 pushes signed with the relay key and the fleet-derived DNS_TXT_KEY`.

**Stage 3: observe.** `authorizedBy.fleetHmacOnly` must stay **0** across a window that includes:
- at least one organic platform issuance or renewal (`relayKey` > 0);
- whatever in-enclave fallback happens. Today, with no Tinfoil box, none does.

A non-zero count logs the name: that is a writer this trace missed, so stop and look.

**Stage 4: flip.** Set `FLEET_TXT_HMAC=off` in `dns.env` and restart the DNS relay.
- From then on the fleet HMAC authorizes nothing. `/health` shows `fleetHmac: "off"`.
- Verify on the next organic issuance: `relayKey` increments. No synthetic TXT is pushed in production.

**Stage 5: retire.**
- Only after the flip has held through a renewal cycle, remove `DNS_TXT_KEY` from `api-relay.env` (certs.js then sends the relay key alone) and from `dns.env`.
- Later, in any supervisor release, not needed for security:
  - stop deriving `DNS_TXT_KEY` and sending `x-relay-sig`;
  - make `certNameDeployment` also match tcp-zone names;
  - update the Tinfoil config comments.
- Code cleanup: drop the `x-relay-sig` path and the switch.

## Compatibility after the flip, per writer

- **W1** (the platform service, the only live writer): unaffected, because it signs with the relay key.
- **W2** (Tinfoil in-enclave fallback; none live):
  - App-zone deployment names and custom-domain aliases keep working through the operator signature. All three Tinfoil configs carry `REGISTRY_PRIVATE_KEY`, and the supervisor sends that signature, with `deploymentId`, for exactly these names.
  - What stops is a fallback push with no operator signature:
    - a tcp-zone name (not configured);
    - a deployment missing from the box's local map (transient);
    - a failed co-sign (logged as `operator co-sign failed; HMAC only`).
  - W2 runs only when the platform service refuses or is down, so the practical loss is limited to the fallback for those cases during a platform-service outage. **Impact today: none.**
- Metal and Windows: none, since they never push.

## Rollback

| stage | rollback |
|---|---|
| 1 | Revert and redeploy. It's inert anyway. |
| 2 | Remove `RELAY_TXT_KEY` from both env files and restart. certs.js falls back to `DNS_TXT_KEY`, which is why that key stays until Stage 5. |
| 4 | Set `FLEET_TXT_HMAC=on` and restart the DNS relay: seconds. |
| 5 | **The point of no easy return.** Undoing the flip after `DNS_TXT_KEY` has been removed means re-deriving it from the fleet SECRET, an operator action with the secret. So Stage 5 happens only after the flip has held. |

## Tests (synthetic keys only)

- `test/dns-relay-txt-key.test.mjs` (new, the real DNS relay against a stub ledger and feed):
  - The relay key authorizes an eligible holder's deployment name and a non-deployment name.
  - It is refused for an ineligible holder (U7), for the apex, and for a wrong key.
  - With the fleet HMAC on, it still works, and the counters separate "fleet HMAC alone" from "fleet HMAC plus a verifying operator signature".
  - **Off**:
    - The fleet HMAC alone is refused, for POST and DELETE, for a tenant's name, a non-deployment label, a box hostname and a deeper name.
    - A supervisor-shaped push (fleet HMAC plus operator signature) is authorized only for the signer's own eligible lease: another operator's tenant is refused, and so is an ineligible holder.
    - The relay key still works.
    - With no relay key, a fleet-only push gets `503 no_key` while operator signatures still verify.
  - **Misconfiguration**:
    - A relay key equal to the fleet-derived key is disabled, so a fleet-key holder can't pose as the relay.
    - A malformed relay key is disabled.
    - An unknown `FLEET_TXT_HMAC` word leaves it on.
  - **Every refusal also asserts that nothing was stored.**
- `test/certs.test.mjs`, one new test covering five configurations:
  - relay key alone: only `x-relay-txt-sig` on the wire;
  - both keys: both signatures, both verify;
  - a relay key equal to the fleet key: ignored, and issuance continues on the fleet HMAC;
  - a malformed relay key: disabled;
  - no push key: disabled.
- `test/dns-relay-u7.test.mjs`: its HMAC refusals now also assert that nothing was stored.
- Mutations: 11 of 11 caught.
  - One of them is a real fall-through this branch's first draft had: a refusal answered 403 and then stored the record.
  - The U7 test's new check catches that class too.
- Neighbouring suites (DNS, certs, secrets, fleet, api relay, U7, mcp, tunnel, deploy closure, metal launcher certs): 161/161.

## What this does not close

- **The relays hold the relay key**: the api-relay and DNS-relay hosts can answer for any non-apex name in our zones. That's where the fleet-derived key is today; what changes is that no box holds the relay key.
- **Operator signatures are per operator, not per box.**
  - Boxes that share one registry key (each Tinfoil config names one `REGISTRY_PRIVATE_KEY`) can answer for each other's leased deployments.
  - A metal operator who can read its own registry key can answer for deployments leased to its own box, whose traffic it already carries.
  - Closing that means keeping registry keys inside the CVM. That's separate work.
- `CERTS_KEY` (fleet-derived) stays an optional extra factor at `/v1/certs/issue`. It is never sufficient on its own: `opSig` and the lease are required. It can retire in the same supervisor release as `DNS_TXT_KEY`.
- `secrets.js` already requires the operator signature for a registered endpoint, so this doesn't change it.

## Decisions for Codex / Steven (not taken here)

1. Whether to flip (Stage 4) before any Tinfoil box returns. Recommended: yes. Their fallback keeps deployment names through operator signatures, and nothing live depends on the fleet HMAC.
2. The length of the observation window in Stage 3. It needs at least one organic platform issuance or renewal.
3. Which relay host generates `RELAY_TXT_KEY`, and how the operator copies it to the other one.
4. Whether Stage 1 rides U7's relay push or a separate one. Recommended: a separate, later push, since both restart every relay unit.
