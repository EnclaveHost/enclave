# Onboarding an independent host

This guide sets up a host that sells CPU on Enclave's contracts **without any
Enclave-operated service**. It needs no relay, fleet tunnel, `*.enclave.host`
name, Enclave API, Enclave artifact gateway or Enclave RPC. One tool drives the
whole lifecycle:

```sh
node cli/host-independent-lifecycle.mjs <init|build|install|run|check|referral> --dir HOST_DIR ...
```

Once the coordinator applies `work/host-onboarding-integration/01-*`, the same
commands are available as `enclave --independent ... host <command> --dir HOST_DIR`.
Status, gas and payout already have independent commands, and this tool does not
replace them: `enclave --independent host status | fund | declare-payout | clear-payout`.

The host it builds is the documented independent host:

1. **The pinned CPU release**, fetched from replicas you name and verified
   against its pin (`scripts/network/fetch-runtime.mjs`).
2. **guestd** with `-cpu-release -release -direct-bootstrap`: the per-app
   SEV-SNP guest manager ([cold-host.md](cold-host.md)).
3. **supervisor.js with `ISOLATION_DIRECT_ONLY=1`**: it accepts owner-committed
   startup deployments only, and turns every relay, secrets, domain, certificate
   and DNS service off ([direct-host-control.md](direct-host-control.md)).
4. Optionally, **your host-owner wallet's policy** (`EnclaveHostOwnership`), so a
   wallet you control can deny deployments on this host.

## What you choose, and why nothing is defaulted

Every authority comes from an input you name. The tool checks each one before
writing anything:

| Input | Flag | Checked |
|---|---|---|
| Contract authorities | `--profile FILE --profile-digest sha256:…` (reviewed), or `--contract-pins FILE` | The digest you supply must match the file; a profile never vouches for itself. Contract pins are validated. |
| Chain reads | `--rpc A,B[,…]` (2-8) and `--quorum N` (default 2) | Each RPC must be a distinct host. The listed number must agree at one confirmed, fresh block. There is no default RPC set. |
| Your endpoint | `--public-url https://…` | It is your registry identity (id = keccak256 of the URL). `*.enclave.host` is refused. |
| Attested source | `--repo OWNER/NAME` | What callers check your image against. |
| Runtime | `--release-id <64 hex>` | The CPU release pin you reviewed. |
| Replicas | `--gateways ORIGIN[,…]` (1-8) | These serve the release, components and packages. Plain HTTP is accepted only for a literal IP. `/ipfs` is added where a tool needs it. |
| Package plan | `--storage-plan FILE` (optional) | Use it instead of gateways for owner packages. |
| Guest budget | `--guest-mem-mib N --guest-cpus N` (`--host-floor-mib`, default 16384) | guestd refuses every create without a budget. |
| Price and payout | `--price-cpu USD_PER_HOUR`, `--payout 0x…` (optional) | `SELL_CPU_PRICE6` is derived from the price. |
| Host-owner policy | `--policy-dir DIR [--policy-origins https://…]` (optional) | Needs a reviewed profile: its `hostOwnership` contract is the authority, and its code hash is checked on chain. |
| Referral | `--referral CODE` (optional) | See [Referral](#referral). |

Everything else is derived from those choices and never typed:

- the contract pin file;
- the registry host id;
- every `/ipfs` form;
- guestd's flags;
- the supervisor's environment;
- the systemd units.

`HOST_DIR/host-plan.json` (format `enclave-independent-host/v1`, mode 0600)
records the choices and holds no secret. Reviewing the host means reading that
one file.

## 1. init

```sh
node cli/host-independent-lifecycle.mjs init --dir /srv/enclave/host \
  --profile contracts/deployments/network-profile-base.json \
  --profile-digest sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8 \
  --rpc https://<your-rpc-a>,https://<your-rpc-b> \
  --public-url https://host.example.org --repo <owner>/<repo> \
  --release-id <64-hex release you reviewed> --gateways http://<replica-ip>:8189,https://<replica-b> \
  --guest-mem-mib 65536 --guest-cpus 16 --price-cpu 0.05 [--policy-dir /srv/enclave/policies]
```

`--dry-run` shows the result and writes nothing. A real run creates:

- `HOST_DIR` with mode 0700;
- `host-plan.json`;
- `contract-pins.json`;
- `operator.key`: a new key, 0600. It is generated on this machine and never
  printed; only its address is shown.
- `supervisor.secret`: 32 random bytes, 0600.

Fund the printed operator address with a little Base ETH:
`enclave --independent ... host fund --address 0x…`.

Re-running `init` on an existing host refuses. `--replace-plan` rewrites only
the plan and lists the fields it changes. Keys are never replaced, and a
different `contract-pins.json` is never overwritten.

## 2. build

```sh
node cli/host-independent-lifecycle.mjs build --dir /srv/enclave/host [--only release,guestd,pair-key,collateral] [--dry-run]
```

| Step | What happens |
|---|---|
| `release` | `fetchRuntime` downloads the release from your gateways into a new `release-<id>/`. It checks the firmware pin and runs `release-manifest.py verify`. A present release is re-checked against its manifest pin. |
| `guestd` | `go build -trimpath` from your checkout's `isolation/m4/guestd`, into `HOST_DIR/bin/guestd`. |
| `pair-key` | `guestd -gen-key HOST_DIR/pair.key`: guestd makes its own pairing key. This tool never makes one, and never regenerates one. |
| `collateral` | **Needs the SEV host itself**, so the tool prints the exact commands rather than running them. You build `sev-inventory`, run it as root, then run `host-collateral.mjs inventory --firmware` and `prepare --statement … --min-tcb <your floor> --fetch-vcek --fetch-crl --out HOST_DIR/collateral` ([cold-host-collateral.md](cold-host-collateral.md)). The minimum TCB is your policy and is never derived from the chip. |

Each step skips outputs that already exist and verify. Nothing is overwritten.

## 3. install

```sh
node cli/host-independent-lifecycle.mjs install --dir /srv/enclave/host                 # print (default)
node cli/host-independent-lifecycle.mjs install --dir /srv/enclave/host --apply [--enable]
```

By default, `install` prints two systemd **user** units and the supervisor
environment, with secrets redacted:

- `enclave-independent-<name>-guestd.service`
- `enclave-independent-<name>-supervisor.service`

The environment is checked against the same rules `supervisor.js` applies at
startup. The supervisor exits 2 on any of them, and the tests start the real
supervisor with this environment.

`--apply` writes the units and `HOST_DIR/supervisor.env` (0600). It refuses to
replace any existing file with different content. `--enable` runs
`systemctl --user daemon-reload` and `enable --now`. `--unit-dir` picks another
unit directory.

The environment turns these off: `SECRETS_API`, `DOMAINS_API`, `CERTS_API`,
`DNS_API`, `APP_CERT_DOMAIN`, the address book and the release ticket. It names
your pins, replicas, guestd and identity. With `--policy-dir`, it also sets the
`ENCLAVE_HOST_*` wallet-policy pins from the reviewed profile.

## 4. run (foreground, for testing)

```sh
node cli/host-independent-lifecycle.mjs run --dir /srv/enclave/host --component guestd|supervisor [--dry-run]
```

This runs the exact command and environment the unit uses. `--dry-run` prints
them, with secrets redacted.

## 5. check

```sh
node cli/host-independent-lifecycle.mjs check --dir /srv/enclave/host [--deep] [--probe-public] [--json]
```

`check` is read-only and prints one row per item:

| Area | Rows |
|---|---|
| Local | plan; authorities (digest); pin file; key files and their modes; release (`--deep` verifies every file); collateral; guestd binary; pairing key; direct-only environment; installed units (match, absent or **differs**) |
| Chain | reviewed code on chain; registry entry (registered, active, operator is this key, proof key, payout); operator gas; host-owner policy (owner, committed hash, document resolved through the host's own loader) |
| Live | guestd `/health` over the authenticated `guestd-control/1`; supervisor `/v1/health` on loopback; your public endpoint (`--probe-public`) |

Each row is `READY`, `MISSING`, `FAILED` or `UNKNOWN`. Every chain read goes
through the agreeing quorum. **A read that fails or does not reach agreement is
`UNKNOWN`, never ready.** A service that answers but is not a supervisor counts
as failed.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every required row is ready. |
| 3 | Something is missing or failed. |
| 4 | Nothing is missing or failed, but a read could not be completed. |
| 1 | Bad input. |

## Referral

Referral attribution is optional and needs no Enclave service.

```sh
node cli/host-independent-lifecycle.mjs referral --dir /srv/enclave/host friend-1
```

This writes `HOST_DIR/referral.json`: a statement signed by the operator key and
bound to chain 8453, the pinned registry, this host's id and endpoint, and the
code. It is never replaced with a different code.

Anyone can verify it with **their own** plan, meaning their own authorities and
RPCs:

```sh
node cli/host-independent-lifecycle.mjs referral --dir <their plan dir> --verify referral.json
```

Verification recovers the signer and reads the registry entry through the
quorum. It accepts the statement only if the signer is the registered operator
of that endpoint.

**No on-chain referral exists yet, and this tool does not pretend one does.**

- The deployed `EnclaveRegistry` (schema 4) has no referral field, setter or
  event.
- The relay's `/v1/referrals/host` store is an Enclave service.

Recording referrals on chain would need a reviewed, deployed interface such as:

- `setReferral(bytes32 id, string code)`, callable only by the entry's
  operator;
- `ReferralSet(bytes32 indexed id, address indexed operator, string code)`;
- a reader.

The tool prints this every time it signs.

## What cannot be completed offline

These steps need live hardware, a wallet, service endpoints or further integration.
The tool reports missing or unverified requirements explicitly:

- **SEV-SNP hardware**: collateral, guestd starting, guests running.
- **A funded operator key**: the supervisor registers the endpoint and sends
  heartbeats.
- **The host-owner wallet**: it accepts ownership and commits a policy. The
  operator nominates the owner; `scripts/network/prepare-host-policy.mjs`
  prepares that nomination unsigned. Until then, a host with `--policy-dir`
  refuses every deployment.
- **The measured control guest**: by default the generated unit launches the
  supervisor on the host, and `check` never reports that as attested (a
  configured `--attestation-url` alone stays unknown). With `--control-image DIR
  --control-measurements HEX --control-min-tcb FILE --control-ovmf FILE`, the
  supervisor instead runs inside the MEASURED control CVM
  ([measured-control-guest.md](measured-control-guest.md)):
  - `install` writes `direct-control.json`, the config the guest's HOST_DATA
    binds, and `control-launcher.json`, and a control unit running
    `metal/enclave-metal.mjs` in place of a host supervisor;
  - `check` verifies the guest end to end (report, measurement, config, TLS
    key, the running supervisor's keys, the registry through your quorum), and
    reports READY only when every check passes.
  This still needs SEV-SNP hardware, a reviewed control image whose measurement
  you recomputed, and a new deployment accepted on it before the host is
  proven.
- **Replica operators**: they serve the release and packages you pinned. A
  replica operated by Enclave is still a single organisation, not independence.

## Known residuals until the integration patches land

These are listed in `work/host-onboarding-integration/`:

- **RPCs**: closed by the measured-control final integration. In direct-only
  mode, the supervisor reads only through `CHAIN_QUORUM` of your `BASE_RPCS`,
  agreeing at one fresh confirmed block (`network/direct-chain.mjs`). This tool
  sets them from your plan's quorum, confirmations and maximum block age.
- **Operator key**: the supervisor takes the operator key only from the
  environment, so `supervisor.env` (0600) holds it. Patch 02 adds
  `REGISTRY_PRIVATE_KEY_FILE`, and patch 03 switches this tool to it so the key
  stays in `operator.key`.
- **CLI integration**: `enclave --independent host init|build|install|run|check|referral`
  is refused until patch 01 delegates it here.
