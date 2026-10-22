# Site release

The site ships as **one content-addressed release**. One UnixFS directory CID covers the whole tree, so every host that
serves it, mirrors it or pins it holds the same verified bytes. Every destination is chosen by the operator; nothing in
the repository names a host, a path or a key.

- **Commands:** `site/deploy.sh <command>`, a thin wrapper over `scripts/site-release/cli.mjs`. The same tool runs on an
  operator's machine, in CI and, as `agent`, on each SSH-reached host.
- **Interfaces:** `work/site-release-interface.txt` (the release), `work/site-automation-interface.txt` (delivery,
  activation, publication).
- **Tests:**
  - `test/site-release.test.mjs` (unit, with stand-in fronts);
  - `test/site-delivery.test.mjs` (actual Caddy, kubo RPC and OpenSSH);
  - `test/site-publish.test.mjs` (the real CLI on anvil).

Four steps, each with its own authority:

| Step | Authority |
| --- | --- |
| **Build** | None; deterministic |
| **Delivery** | Each target's own credential |
| **Activation** | The same per-target credential |
| **Publication** | The publisher record's on-chain config holder |

Every step after build needs the CID explicitly: `--approve <CID>`.

## The steps

| Step | Command | What it does |
| --- | --- | --- |
| Build and prepare | `site/deploy.sh prepare --out DIR --base BASE_DIR` | Builds `site/dist` and makes the release `DIR/<CID>/`: a staged copy, verified, then renamed into place. It prints a review and the CID to approve. |
| Fetch | `site/deploy.sh fetch --cid CID --gateway URL[,URL] --out DIR [--as-base]` | The same release, or a base, from any gateway. The CAR must verify to the CID; gateways are untrusted. |
| Review, verify | `site/deploy.sh review DIR`, `site/deploy.sh verify DIR` | Re-hashes everything from scratch. Writes nothing. |
| **Deliver** | `site/deploy.sh deliver --release DIR --targets FILE --approve CID --journal DIR [--publish FILE --plan-out DIR]` | Mirror, then a journalled rollout, then (optionally) publish, in one run. It stops before activating if any target lacks the verified release, and publishes only when the rollout is `active`. |
| Mirror | `site/deploy.sh mirror --release DIR --targets FILE --approve CID` | Copies the release to every target. The run succeeds only if **every** target verified the **same** CID. |
| Activate | `site/deploy.sh activate --release DIR --targets FILE --approve CID --journal DIR` | A journalled rollout. On every activatable target (local and SSH), in order: headers, reload, an atomic link swap, then a probe of the live bytes and headers. Each is a fenced operation; see "Rollouts". |
| Resolve | `site/deploy.sh resolve --targets FILE --journal DIR --rollout ID` | Settles an interrupted rollout from its journal, from any machine. It reads each recorded result, then completes the rollout or compensates. It never re-sends an activation. |
| Publish (session) | `site/deploy.sh publish --release DIR --publish FILE --approve CID --plan-out DIR` | Moves the IPNS name to `/ipfs/<CID>` through the enclave CLI and an owner-approved session, or reports it pending with the owner's exact plan. |
| Roll back | `site/deploy.sh rollback --targets FILE --to CID --approve CID --journal DIR` | A rollout to an earlier release that is present and verified on every target, with the same fencing. |
| Prune | `site/deploy.sh prune --targets FILE [--keep-hours N]` | Removes releases superseded more than N hours ago (at least 48). Never `current` or the previous release. |
| Publish | `site/deploy.sh publish-plan --release DIR --publisher-config FILE --deployment ID [--owner ADDR] --out DIR` | Prepares the owner's change of the IPNS publisher's value to `/ipfs/<CID>`. Nothing is signed or sent. |

## What a release keeps

- **Cached tabs.** Hashed chunks (`js/chunks/**`) of the base release stay in the tree, and inline-script hashes stay in
  the CSP `script-src`, for **48 hours after the last build that produced them**.
  - That state travels inside the tree, at `/.well-known/enclave-site-release.json`, so a release fetched by CID alone
    still knows what to keep.
  - A base without that file, such as the current production tree, has everything dated conservatively: to
    `--base-built-at`, or to now.
  - A hashed name whose bytes differ from the base's refuses the release.
- **Installers.** `cli/install.sh`, `install.ps1` and `host.ps1` ride in the tree at `/get/`, so they are content-addressed
  with the site. `installers/` beside the tree is derived from them, for the `/install.sh` and `/install.ps1` routes.
- **Headers.** `headers.caddy` is generated from the ledger: CSP (with the 48h `script-src` union), COOP,
  Permissions-Policy, Referrer-Policy, HSTS and nosniff. The policy is `scripts/site-release/headers.json`; override it
  with `--headers FILE`.
- **Identity.** The tree is built with exactly kubo's `ipfs add -r --hidden --cid-version 1` DAG and the same CAR bytes,
  so its CIDs match what IPFS nodes compute. A directory kubo would shard (HAMT) is refused rather than guessed.

A release dir holds exactly `site/`, `site.car`, `site-root.block`, `site-root.txt`, `release.json`, `headers.caddy` and
`installers/`. Every file outside `site/` is derived from `site/` alone.

## Targets

A targets file is operator-owned. Unknown keys are refused, so no secret or host can ride in unnoticed.

```json
{"version": 1, "targets": [
  {"name": "box-1", "kind": "local-root", "root": "/srv/site-releases",
   "activate": {"reload": ["/usr/bin/systemctl", "reload", "my-web-server"],
                "probe": {"url": "https://127.0.0.1:8443/", "servername": "example.org", "caFile": "/etc/…/ca.pem",
                          "paths": ["index.html", "js/boot.js"], "headers": true}}},
  {"name": "box-2", "kind": "ssh", "host": "203.0.113.20", "port": 22, "user": "siterelease",
   "keyEnv": "SITE_DELIVERY_SSH_KEY", "knownHostsEnv": "SITE_DELIVERY_KNOWN_HOSTS",
   "agent": ["/usr/bin/node", "/opt/site-release/scripts/site-release/cli.mjs", "agent", "--config", "/etc/site-release/agent.json"],
   "activate": true},
  {"name": "pin-1", "kind": "kubo", "api": "https://kubo.example.org", "authEnv": "PIN_1_AUTH"}
]}
```

The file holds no secrets: `keyEnv`, `knownHostsEnv` and `authEnv` name environment variables, and `keyFile` and
`knownHostsFile` name files. Activation follows file order, as one journalled rollout (see "Rollouts").

### `local-root`

Each release sits at `root/<CID>/`, `root/current` is a link swapped with one `rename`, and every swap is recorded in
`root/releases.jsonl`.

- **Mirror:**
  - it stages under `root/.incoming-*`, verifies there, and renames in;
  - an existing `root/<CID>` is verified and never overwritten;
  - an interrupted run leaves only `.incoming-*`, which the next run removes;
  - a lock file stops concurrent runs.
- **Activate:**
  1. verify the release, and the previous one too;
  2. atomically replace `root/headers.caddy` with the release's;
  3. reload;
  4. atomically swap `root/current`;
  5. probe.

  Headers go first because a release's CSP union keeps every hash of the last 48h: the content still being served stays
  valid under the new headers. The other order would serve new HTML under old headers, blocking its new inline scripts.
  A rollback restores the content first, then the old headers, then reloads.

The web server serves:
- `root/current/site`;
- `root/current/installers` for `/install.sh` and `/install.ps1`;
- `import root/headers.caddy` inside the site's vhost. Create an empty `root/headers.caddy` once, before the server's
  first start.

### `ssh`

Real OpenSSH, with argv only and no shell interpolation. It uses:
- `-F /dev/null`;
- `BatchMode=yes` and `StrictHostKeyChecking=yes` against **your** known_hosts. Host keys are always checked, and
  there is no accept-new;
- `IdentitiesOnly=yes` and `IdentityAgent=none`, with no forwarding.

Every token sent matches `[A-Za-z0-9_@%+=:,./-]`, so the remote shell receives exactly the argv. A key or known_hosts
given through the environment is written to a fresh 0700 directory and removed afterwards; it is never printed.

**On each host,** install a checkout of this tool (node built-ins only) and an `agent.json` that is exactly one
`local-root` target: the host's own root, reload command and probe. Then give the delivery key only the agent:

```
restrict,command="/usr/bin/node /opt/site-release/scripts/site-release/cli.mjs agent --config /etc/site-release/agent.json" ssh-ed25519 AAAA… site-release
```

The agent reads only `site-release-agent-v1 receive|activate|undo|result|status …` from `SSH_ORIGINAL_COMMAND`, against a
fixed grammar.
- **`receive`** takes the CAR on stdin. The agent verifies it to the CID, re-derives the release dir from the tree, and
  requires its `release.json` to equal the sender's byte for byte.
- **The client** never chooses a path or a command on the host.

### `kubo`

The CAR goes to `dag/import` with the root pinned, then the recursive pin and the root block are read back. `authEnv`
names an environment variable that holds the Authorization header value. The value itself never sits in the file.

### What a mirror does not prove

Different URLs or names do not show that different people operate the targets. The tool reports which targets verified
the CID, never who runs them.

Uploading a CAR through a storage adapter's `add-file` stores a **file** CID of the CAR bytes. That is not a copy of the
site's directory root, and the tool does not offer it as one.

## Rollouts: what is and is not guaranteed

There is no atomic commit across hosts: under a partition, hosts can serve different releases for a while. What the
tool guarantees instead:

**Per root,** with `root/state.json` (atomic) and `root/ops/<opId>.json` (the history):
- **identity:** the root has a durable `rootId`. Every operation that changes or settles anything names it, and a
  different root refuses, even under the same target name;
- every change is an operation with an id the orchestrator journalled before sending it;
- an activation applies only if the root is still at the **generation** the rollout observed (compare-and-swap);
- a replayed id returns its recorded result and never runs twice;
- **cancel:** `cancel <opId>` returns the operation's result if it ran, and otherwise records a durable tombstone. A
  delayed copy of that operation that arrives later finds the tombstone and does not run;
- an undo reverts only that same activation, and only while it is the root's latest change. A newer rollout's change,
  even one to the same CID, is reported `superseded` and left alone. A failed undo (a reload or probe that could not be
  confirmed) leaves the activation serving, and a later run may make a new numbered attempt (at most 9);
- **rollbacks are confirmed or pending:** a change interrupted by a crash, or a rollback whose reload or probe failed,
  stays pending in `state.json`. It is retried before anything else runs, and is never reported restored until it is;
- the history is published atomically (tmp, fsync, link without overwrite), so no partial file is ever final;
- **the lock** is an OS lock: `flock(2)` through util-linux `flock`, held by a helper process whose stdin is the
  holder's pipe. The kernel releases it when the holder exits or crashes, and the lock file is never removed, so no
  takeover race exists. This makes it Linux-only, and there is no fallback.

**Per rollout,** the journal (`--journal DIR`, one v2 file per rollout) records every target's state before each step:
- each entry is bound to the target's configuration (the local root path; the SSH host, port, user, agent and trusted
  host keys) and to its `rootId`. `resolve` refuses a targets file whose same-name entry differs;
- a lost answer or a timeout is settled with **cancel**, never with an absence read and never by re-sending it;
- the first target that does not commit stops the rollout, and every committed target gets a fenced undo.

| Outcome | Exit | Meaning |
| --- | --- | --- |
| **active** | 0 | Every target committed. |
| **reverted** | 1 | Nothing of this rollout is in effect: each target is unchanged, rolled back, undone, or superseded by a newer rollout. |
| **pending** | 5 | An outcome is unknown, or an undo could not be confirmed. The hosts may differ. The tool prints the journal and the exact `resolve` command. |

`resolve` run later, from any machine with the journal and the targets file, settles every lost operation with
cancel. It then completes the rollout (every target committed) or compensates with fenced undos, retrying a failed undo
with a new attempt. It never re-sends an activation.

**SSH agents** (`site-release-agent-v1 receive|activate|undo|cancel|result|status`):
- they stream the CAR to disk under the host's `maxCarBytes` (default 128 MiB, at most 1 GiB) and refuse a larger one
  while it is still streaming;
- they refuse a CAR whose root is not the claimed CID, and a release whose derived `release.json` differs from the
  sender's;
- they refuse an `agent.json` or root that is not owned by the agent's user, or that is group- or world-writable;
- every answer reports the agent's own peak RSS. On the production payload: about 250 MiB to receive a 39.9 MB CAR,
  and about 160 MiB to activate.

## Publication

The ipns-publisher app (`../enclave-apps/ipns-publisher`) signs the site's IPNS record with `ipnsKey`, a deployment
secret referenced from its config as `$IPNS_ED25519_SK`. Its `POST /publish` republishes the configured value and cannot
set a new CID. A `value` that is a URL makes whoever controls that URL the one who chooses the CID.

`publish-plan` takes the owner's `enclave config show <id> --json`, changes only `value` to `/ipfs/<CID>`, and writes
the new config and the plan. Everything else, the key reference included, is kept byte for byte. It refuses:
- a config whose `ipnsKey` or `api_key` is anything but a `$NAME` reference;
- a config carrying key-like material.

Those values are never printed.

Who can make that change is set by the contracts. `setConfig` is callable only by the record's holder, and there is no
ledger delegate for it. A SessionVault session may call `deploy.setConfig` only on a record the **vault** holds in the
**staging** environment.

**Automated, with no wallet ceremony per release (works today):**
- **The owner's one-time setup:**
  - move the publisher record into the owner's vault (`transferDeployment`; refund first);
  - adopt it as `staging`, ideally as the only staging record of that vault;
  - open a session whose actions are only `deploy.setConfig`, with budget 0 and an expiry;
  - export it (`enclave session new … --env`).
- **The operator keeps** that string in `ENCLAVE_SESSION`, and a gas-payer key holding only ETH for gas in
  `ENCLAVE_KEY`.
- **`publish`, with a publication file in mode `session`**, runs the real CLI:
  1. `config show`;
  2. only `value` changes;
  3. `config set` through the session;
  4. `config show` again, which must hold `/ipfs/<CID>`.
- **Guarantees:**
  - the IPNS key reference is unchanged, so this is the same name;
  - the owner can revoke the session at any time, and it expires;
  - an outcome-unknown transaction is reported (exit 4) and never resent.
- **Before migrating, verify** that the publisher's deployment secret still reaches it once the vault holds the record.

**Otherwise (a wallet-held or production record),** mode `plan` writes the exact owner operation and reports the
publication **pending** (exit 3). The owner then runs it:
- `enclave config set <id> --file …` with their own trust flags;
- or, with an external wallet, `--unsigned --from OWNER`, which prints the transaction.

Either way, the host relaunches the app, which signs the new value with the **same** key.

A publication file holds no secrets:

```json
{"version": 1, "deployment": "0x…", "mode": "session", "cli": ["@node", "@enclave-cli"],
 "cliArgs": ["--independent", "--profile", "network/profile.json", "--profile-digest", "sha256:…", "--rpc", "https://a.example,https://b.example"],
 "passEnv": ["ENCLAVE_SESSION", "ENCLAVE_KEY"]}
```

A signer flag (`--wallet`, `--key`, …) or key-like text in `cliArgs` is refused. `@enclave-cli` is this checkout's CLI.

`docs/ipns-release-pointer-proposal.md` is a reviewed-protocol proposal for owners who do not want a staging-held
publisher: a release key that can only choose a CID, replay-bounded by the IPNS sequence. It is not implemented.

Check afterwards:
- the publisher's `/api/status` shows the new value and a higher sequence;
- an independent resolver resolves the name to `/ipfs/<CID>`.

## CI

**`site`** (the build job; no secrets):
1. builds;
2. fetches the base by CID: `vars.SITE_RELEASE_BASE_CID`, from `vars.SITE_RELEASE_GATEWAYS`, verified;
3. prepares and verifies the release;
4. writes the review to the job summary, and uploads `site-release-<CID>`.

Without a configured base it fails, unless `vars.SITE_RELEASE_BASE` is `none`.

**`site-deliver`** (needs `site`; runs in the `site-release` environment). Add protection rules there to require a
person to approve the CID shown in the build summary.
1. Without `vars.SITE_DELIVERY_TARGETS` it warns that the release was **not delivered**, and stops.
2. Otherwise it downloads this run's artifact and re-verifies it to the build job's CID.
3. It runs `deliver --approve <CID> --journal …` against the targets JSON in that variable. The journal is uploaded as
   `site-rollout-journal-<CID>` even when the step fails; a pending rollout fails the job, and is settled later with
   `site-release resolve` from that journal. Only these secrets are mapped into the
   environment, and only by name: `SITE_DELIVERY_SSH_KEY`, `SITE_DELIVERY_KNOWN_HOSTS` and `SITE_DELIVERY_KUBO_AUTH`.
4. Publication:
   - with `vars.SITE_PUBLISH_CONFIG`, it runs `publish`, with `secrets.SITE_PUBLISH_SESSION` as `ENCLAVE_SESSION` and
     `secrets.SITE_PUBLISH_GAS_KEY` as `ENCLAVE_KEY`;
   - a pending result uploads `site-publication-plan-<CID>` for the owner;
   - an unknown outcome fails the job, and nothing is resent.

GitHub only runs these jobs. `site/deploy.sh deliver` does the same from an operator's machine, with the same files.

## Moving production onto this

The current production release, `bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y`, is served from
`/opt/enclave-site/<CID>/site`, with the CID written into each Caddyfile. To move it onto this workflow:

1. Prepare the first release with that tree as `--base`. It keeps every production chunk and CSP hash; the tests check
   this against the real tree.
2. Mirror the release into the operator's release root.
3. Change the vhost, once, to `root/current/site`, `root/current/installers` and `import root/headers.caddy`, after
   creating an empty `root/headers.caddy`. For hosts reached by SSH, install the agent and its forced-command key.
4. `deliver` the release (it activates).
5. Publish: the owner-signed config change, or the one-time vault/session setup, then `publish`.

Until an operator does that, nothing here changes what production serves.
