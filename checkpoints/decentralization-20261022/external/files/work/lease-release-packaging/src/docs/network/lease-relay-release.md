# Lease relay release

A lease relay pays the gas of app-funded lease operations (claim, renew, release) for the one reviewed reserve and
executor deployment. The app's reserve reimburses it in the same transaction (`network/lease-relay-service.mjs`,
[app-funded leases](app-funded-leases.md)). Anyone may run one, and hosts fail over between relays.

This page packages the relay as a standalone release and explains how an operator installs, stages and rolls it back.
Nothing in the repository installs or starts it. Activation (which hosts run it, the deployment record, the RPC set and
the float) is a separate, reviewed decision.

## Build and verify

```sh
node scripts/build-lease-relay-release.mjs OUTDIR [--expect-sha256 <reviewed artifact sha256>]
```

`OUTDIR` receives three files:

| File | What it is |
| --- | --- |
| `lease-relay.mjs` | The whole service in one file: esbuild, `target node20`, with no `node_modules` beside it. The same repository inputs give the same bytes. |
| `lease-relay-check.mjs` | The configuration check (`network/lease-relay-check.mjs`, verbatim; node builtins only). |
| `manifest.json` | The sha256 and size of both files, plus the sha256 of every bundled input (about 450 source and npm files). |

With `--expect-sha256`, nothing is written unless the artifact is the reviewed one. `test/lease-relay-release.test.mjs`
builds the release twice and requires identical bytes.

## Install layout

| Path | Contents |
| --- | --- |
| `/opt/enclave-lease-relay/releases/<artifact sha256>/` | The three files, owned by root and read-only. |
| `/opt/enclave-lease-relay/current` | A symlink to `releases/<sha256>`: the release the unit runs. |
| `/etc/enclave-lease-relay/relay.env` | Every setting (`relay/lease-relay.env.example`). |
| `/etc/enclave-lease-relay/deployment.json` | The reviewed deployment record. |
| `/etc/enclave-lease-relay/relay.key` | The hot key: 0600, root. |
| `/etc/systemd/system/enclave-lease-relay.service` | From `relay/systemd/enclave-lease-relay.service`. |

The unit hands the key to the service only as a systemd credential (`LoadCredential`). The service runs as a dynamic
user with a read-only system and loopback-only listening.

The unit starts the artifact with `node --preserve-symlinks-main`. Without that flag, Node resolves the entry module
through `current` to `releases/<sha256>/`, and the relay's CLI guard (`import.meta.url === file://argv[1]`) no longer
matches. The relay would then exit 0 without serving; the release test demonstrates this.

## Configuration: every value explicit

`lease-relay-check.mjs` runs before every start (`ExecStartPre`) and refuses unless every setting below is valid. None
of them has a default, including the float.

| Setting | Requirement |
| --- | --- |
| `LEASE_RELAY_RECORD`, `LEASE_RELAY_DIGEST` | The reviewed record file and its `sha256:` digest. The service re-verifies it too. |
| `LEASE_RELAY_RPCS`, `LEASE_RELAY_QUORUM` | 2 to 16 https providers, each counted once, and a strict majority of them, at least 2. |
| `LEASE_RELAY_MAX_FLOAT_ETH`, `LEASE_RELAY_MIN_FLOAT_ETH` | The cap the hot key may hold (the service refuses to start above it) and the refill threshold (`min < max`, both positive). Choose them from the measured cost of operations and from how many operations may be in flight. There is no 0.005 ETH or other default. |
| `LEASE_RELAY_LISTEN` | `127.0.0.1:<port>` or `[::1]:<port>`, with an explicit port. |
| `LEASE_RELAY_KEY_FILE` | Set by the unit to the credential path. It must be owner-only. The check never reads its content. |
| `LEASE_RELAY_ARTIFACT_SHA256` | The reviewed `lease-relay.mjs`, which `current/` must hold. |

The service itself still refuses:
- a record that is not the reviewed one;
- an RPC set without a strict majority;
- a group- or world-readable key;
- a key holding more than the float cap.

## Memory

`test/lease-relay-release.test.mjs` runs the installed artifact (Node 20+, through `current`, as the unit does) against
a local anvil behind two TLS proxies. It samples `/proc/<pid>/status` every 25 ms while the relay:
- starts;
- serves `/v1/info`;
- relays a claim and a release;
- answers a burst of 48 concurrent bad requests (oversized, malformed and invalid).

On the reference machine (Node v22.23.3, x86-64 Linux), the peak resident set (`VmHWM`) was **89.4 MiB**, and 86.0 MiB after
the run. The test fails if the unit's `MemoryMax` is less than twice the measured peak. The unit sets `MemoryMax=192M`
and `TasksMax=64`, so the kernel bounds a misbehaving relay instead of the box's other services paying for it.

Before installing on a box, measure what it actually has spare (`MemAvailable` in `/proc/meminfo`, with its other
services at their normal load). Install only if 192 MiB fits with room to spare. Repeat the measurement with the
box's own Node: different Node versions use different amounts of memory.

The relay's own bounds keep its memory flat under load. It handles at most 4 requests at once (more are answered
503), and request bodies are limited to 4 KiB (larger ones are answered 413).

## TLS route: staging and rollback

Hosts accept only https relays. Put the relay behind the box's existing TLS front end (for example Caddy). Stage it
under a route of its own before anyone is told about it.

1. Install the release directory and the `current` link, the env file, the record and the key (0600). Fund the key
   below `LEASE_RELAY_MAX_FLOAT_ETH`; the relay refuses a key above its cap.
2. Run the configuration check by hand. Outside the unit, set the key path yourself; the check only stats the key file
   and never reads it:
   `sudo env $(grep -v '^#' /etc/enclave-lease-relay/relay.env) LEASE_RELAY_KEY_FILE=/etc/enclave-lease-relay/relay.key node /opt/enclave-lease-relay/current/lease-relay-check.mjs`.
   It must print `lease relay configuration ok`.
3. `systemctl start enclave-lease-relay` (not `enable` yet). Then confirm locally:
   - `curl -s http://127.0.0.1:<port>/v1/info` names the reserve, the executor and the payee (the key's address);
   - the journal shows `serving ... float ... (cap ..., min ...)`.
4. Add a NEW TLS route for it, for example a dedicated hostname such as `lease-relay.<box domain>` or a path. Change no
   existing route. Reload the front end, then check from outside: `curl -s https://<route>/v1/info` gives the same
   answer, and `POST /v1/lease` with an empty body returns 400 (malformed), not 404.
5. Only now hand the https URL to the hosts' `ENCLAVE_LEASE_GAS_RELAYS`, alongside at least one other relay.
   `systemctl enable enclave-lease-relay`.

**Rolling back a release.**
1. Point `current` back at the previous `releases/<sha256>` and set `LEASE_RELAY_ARTIFACT_SHA256` to that release.
2. `systemctl restart enclave-lease-relay`.

A failed `ExecStartPre` leaves the relay stopped; hosts fail over to their other relays.

**Withdrawing the route.**
1. Remove the URL from the hosts' relay lists first.
2. Then remove the front-end route and reload.
3. `systemctl disable --now enclave-lease-relay`.
4. Move what is left of the float off the key.

Nothing about the route or the relay touches the box's other services.

## What this does not decide

- Which boxes run a relay. A box with little spare memory should not run one without measuring first (see Memory).
- The deployment record, the RPC providers and the float amounts. These are reviewed values, not defaults.
- Funding. The key is filled by hand and never automatically: a reverted or raced transaction still costs the relay gas.
