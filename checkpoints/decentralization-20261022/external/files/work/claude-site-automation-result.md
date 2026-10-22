# Site automation: delivery, activation and publication (2026-10-19)

The interface was written first: `work/site-automation-interface.txt`. User docs are `enclave/docs/site-release.md`.
The protocol proposal is `enclave/docs/ipns-release-pointer-proposal.md`.

Repo: `work/enclave` at HEAD `a40c5f99`. Nothing is committed.

**What I did not do:**
- no live SSH to any real host (only a loopback test sshd), no production use, no wallet writes, no GitHub settings, no
  commits;
- no edits to browser/CLI runtime, Windows, custody, storage, ipns-publisher Rust or contracts.

The previous round's release work, the immutable CID and the 48h retention, is unchanged; it is extended here.

## What was missing, and what now exists

The last round's CI built and uploaded an artifact but never delivered it. That did not preserve the old automated
delivery. Now the **same tool** delivers, activates and publishes, from CI or from an operator's machine, to targets
the operator configures.

### End-to-end behaviour

```
site/deploy.sh prepare --out DIR --base BASE        # build: one CID (as before)
site/deploy.sh deliver --release DIR/<CID> --targets targets.json --approve <CID> [--publish publication.json --plan-out P]
```

1. **Verify.** The release is re-verified, and `--approve` must equal its CID.
2. **Mirror every target.** The run stops, and activates nothing, unless **every** target verified the **same** CID.
   - `local-root`: staged in `.incoming-*`, verified, then renamed; never overwritten.
   - `kubo`: `dag/import?pin-roots=true` through the RPC, then the recursive pin and `block/get` of the root.
   - `ssh` (new): real OpenSSH to the operator's host, where the same tool runs as `agent` under a forced command.
     - `site.car` goes over stdin.
     - The agent verifies it to the CID, re-derives the whole release dir from the tree, and requires its
       `release.json` to equal the sender's byte for byte.
3. **Activate every activatable target, in file order, all or none.** Per target:
   1. replace `root/headers.caddy` atomically **first**. The CSP union is a superset, so the content still being served
      stays valid;
   2. reload;
   3. swap `root/current` atomically;
   4. probe the live bytes and every release header.

   If target k fails, it rolls itself back, and targets 1..k-1 go back to the release they served, **SSH hosts
   included** (through the agent's `rollback`). `rollback --to CID` is the same full rollout across all kinds. A
   failed rollback is reported by name.
4. **Publish (optional).**
   - Mode `session`: the real enclave CLI does `config show`, then a `config set` that changes only `value` to
     `/ipfs/<CID>`, through an owner-approved session, then `config show` again to confirm it on chain.
   - Mode `plan`: the exact owner operation is written and the publication is reported **pending** (exit 3).
   - An unknown outcome is reported (exit 4) and never resent.

### SSH target (strict)

- **Host:** a DNS name or literal address; a `-` prefix is refused. User and port are validated.
- **Credentials:** exactly one key source (`keyFile` or `keyEnv`) and exactly one known_hosts source; host keys are
  always checked.
- **Fixed argv:** `-F /dev/null`, BatchMode, StrictHostKeyChecking=yes, IdentitiesOnly, IdentityAgent=none, no
  forwarding, and a minimal environment for ssh (PATH and HOME).
- **Tokens:** every token matches `[A-Za-z0-9_@%+=:,./-]`, so the remote shell receives exactly the argv.
- **Key handling:** a key from the environment goes to a fresh 0700 directory as a 0600 file, removed afterwards, and
  is never printed. Tests check that it does not appear in the output and that no temporary directory survives.
- **The agent** is bound to the host operator's own `agent.json`: its root, reload and probe. Its grammar is fixed:
  `receive <CID> <sha256>`, `activate <CID>`, `rollback <CID|none>`, `status`. The client chooses no path or command.

### CI

- **`site`:** as before, plus outputs `cid` and `commit`.
- **`site-deliver` (new):** needs `site`; runs in the `site-release` environment (optional protection rules make a
  person approve the CID first); permissions `actions: read`.
  1. Without `vars.SITE_DELIVERY_TARGETS` it **warns** "built and uploaded but NOT delivered". It never stays silent.
  2. Otherwise it runs `gh run download` for this run's artifact, re-verifies it, and runs `deliver --approve <cid>`.
     Only these secrets are mapped, by name: `SITE_DELIVERY_SSH_KEY`, `SITE_DELIVERY_KNOWN_HOSTS` and
     `SITE_DELIVERY_KUBO_AUTH`.
  3. With `vars.SITE_PUBLISH_CONFIG` it runs `npm ci`, then `publish`, with `secrets.SITE_PUBLISH_SESSION` as
     `ENCLAVE_SESSION` (the CLI's existing exported-session API) and `secrets.SITE_PUBLISH_GAS_KEY` as `ENCLAVE_KEY`
     (a gas payer). A pending result uploads `site-publication-plan-<CID>`; an unknown outcome fails the job.
- Nothing names Nan or an Enclave host, and GitHub is only the runner. The same files work with `site/deploy.sh deliver`
  on an operator's machine.

## Publication: what is possible without a fresh wallet ceremony (from source)

- `EnclaveDeployments.setConfig` requires `d.owner == msg.sender`; the ledger has **no delegate** for it.
- `SessionVault.execute(ACT_SET_CONFIG)` is allowed **only** for a record the **vault** holds in **ENV_STAGING**.
  Production records and wallet-held records are always production to a session. `promote` is an owner signature.
- The ipns-publisher signs `value` from ENCLAVE_CONFIG (on chain, so it survives restarts) with `ipnsKey`
  (`$IPNS_ED25519_SK`). It publishes max+1 on a change and recovers its sequence from `/data`, the delegates or the DHT.
  `POST /publish` cannot set a CID.

**Therefore:**

| Publisher record | Per-release publication | Proven here |
| --- | --- | --- |
| held by the owner's **vault** in **staging** | **automated**: a session limited to `deploy.setConfig` plus a gas payer that authorizes nothing; no owner signature per release | yes: on anvil with the real CLI, the owner's nonce unchanged |
| **wallet-held** (or production) | **one owner authorization** per release: `enclave config set` with the wallet, or `--unsigned --from OWNER` | the session is refused by the CLI and the vault; the plan is pending (exit 3) |
| either, with the proposed protocol | a release key that can only choose a CID; the replay floor is the IPNS sequence; restart-safe; owner-revocable | **not implemented**: `docs/ipns-release-pointer-proposal.md`, which needs a reviewed Rust change |

The CLI's refusal for a wallet-held record, verbatim from the test log: `… is held by the owner's wallet 0x7099…79C8, so
to a session it is a PRODUCTION …`

**Owner authorization that remains pending.** One of these is needed, and none can be done here:

1. **One-time move to automation:**
   - refund, then `transferDeployment` of the live publisher record (`d9798e4c…`) to the owner's vault;
   - `adopt "staging"`;
   - open a session with actions `[deploy.setConfig]`, budget 0 and an expiry, and export it (`--env`) into the
     operator's `SITE_PUBLISH_SESSION`.

   **Unverified precondition:** that the publisher's deployment-secret delivery continues once the vault holds the
   record. Check this with the secrets owner before migrating.
2. **Or keep the record wallet-held,** and the owner runs each release's `config set` from the plan.

Either way the identity is unchanged: the same `$IPNS_ED25519_SK` reference and the same name. A mutable-URL `value` is
reported and replaced by the fixed CID; it is never preserved silently.

**Session limits (stated in the docs):**
- a `deploy.setConfig` session can change the config of **any** staging record in that vault, so the publisher should
  be its only staging record;
- it expires, and the owner can revoke it at any time (`revokeAll` or terminate);
- calls are replay-protected by the vault's nonces.

## Tests: exact runs, serial

All runs were under `/tmp/s6/run-768.sh`. It kills only its own process group at >768 MiB, <16 GiB available, or after
900 s. No run was killed, and nothing of mine was left running. The server fixtures were made non-detached so the
guard counts their memory.

| Suite | Result | Peak (guard, whole group) | Min available |
| --- | --- | --- | --- |
| `test/site-delivery.test.mjs`, 1st | 4/5: an assertion regex expected other wording; fixed | 240 MiB (servers detached, not counted) | 19171 MiB |
| `test/site-delivery.test.mjs`, servers in the group | 5/5 | 449 MiB | 18648 MiB |
| `test/site-publish.test.mjs`, 1st and 2nd | 3/3, 3/3 | 548 / 573 MiB | 17666 / 18967 MiB |
| `test/site-release.test.mjs` after the workflow change | 8/9: my new assertion matched the comment "no default host"; narrowed | 265 MiB | 18146 MiB |
| **final `test/site-release.test.mjs`** | **9/9** | 236 MiB | 18018 MiB |
| **final `test/site-delivery.test.mjs`** | **5/5** | 436 MiB | 18035 MiB |
| **final `test/site-publish.test.mjs`** | **4/4** | 466 MiB | 17611 MiB |

### `site-delivery`: actual servers on 127.0.0.1

- **Servers:**
  - **3× actual Caddy** v2.11.7 (`work/custody-caddy/caddy`), on scratch Caddyfiles that import `root/headers.caddy`
    and serve `root/current/site` and `root/current/installers`. Reloads go through each one's admin endpoint.
  - **Actual kubo 0.42**: `ipfs daemon --offline`, a temporary repo, `Addresses.Swarm []`, no bootstrap peers,
    `Routing.Type none`, and the API and gateway on loopback.
  - **Actual OpenSSH 10.6 sshd**, on a scratch port with scratch host and client keys, `restrict,command=` running the
    agent.
- **Deliver r1** reaches a (Caddy), c (SSH host with its own Caddy), b (Caddy) and k (kubo RPC). Each Caddy serves r1's
  exact bytes, CSP, COOP and installer. Kubo pins r1 recursively, and its trustless gateway gives back a CAR that
  rebuilds a byte-identical `release.json`. The SSH host's re-derived `release.json` is byte-identical. No credential is
  printed, and no temporary key directory remains.
- **Deliver r2:**
  - a reload hook records what Caddy serves right after reload. The content is still r1 while the CSP already holds r2's
    superset: **headers before content**;
  - after activation, on all three Caddys, a tab cached on r1 gets `js/chunks/a-AAAA.js` (200, r1's bytes) under a
    live CSP that still allows r1's inline script.
- **Fault:** b's Caddy is pinned to an old tree, so its probe fails. The run reports "failed on b … rolled back c, a and
  b rolled back". All three Caddys serve r2's bytes **and** r2's headers again, and r3 stays on disk.
  `rollback --to r1` then returns all three, SSH included.
- **SSH:** `status` over real SSH works. Forged operations sent straight through ssh (`activate ../../etc`,
  `rollback $(id)`, `receive x y; rm -rf /`, `shell`) all get "unsupported agent operation". A host key not in
  known_hosts gives "Host key verification failed", and nothing is activated anywhere. Unsafe agent tokens, a host
  that looks like an option, and a missing known_hosts are refused before ssh runs.

### `site-publish`: the real CLI on anvil

The chain has the real ledger, the pinned factory and a real SessionVault.
1. A vault-held **staging** publisher with config `{ipnsKey: "$IPNS_ED25519_SK", value: "https://mutable.example/…", …}`:
   - `publishRelease` drives the real CLI;
   - the on-chain config changes only in `value`, which becomes `/ipfs/<CID>`;
   - the mutable-URL warning is given; the identity reference is unchanged;
   - the **owner's nonce is unchanged**;
   - no key material appears; a repeat reports `already-published`.
2. **The CI path:** `ENCLAVE_SESSION` holds the exported session (no session directory), through the tool's `publish`
   command. The on-chain value is updated, and neither the exported string nor any key is printed.
3. **A wallet-held record:** the session is refused (the verbatim refusal above) and the chain is unchanged. Plan mode
   gives `pending-owner` with the exact `config set` argv and the `--unsigned --from OWNER` variant, and sends nothing.
   A publication file with `--wallet`, key-like `cliArgs` or unknown keys is refused.
4. **`deliver --publish`:** mirrors, then publishes, with exit 0. The pending variant exits 3.

Every CLI run was under the network guard: zero Enclave API calls and zero non-loopback connections.

`site-release` (unit): the 9 earlier tests, with the stand-in front now reading `root/headers.caddy`. The workflow test
checks:
- the build job holds no secrets;
- the deliver job maps exactly the five named secrets;
- `gh run download` is followed by a re-verify;
- `deliver --approve "$CID"` is present;
- no Nan, `/opt`, `/etc` or ssh `Host` stanza appears.

The stand-in fronts in that suite are unit coverage only. Real-server coverage is `site-delivery`.

## Not done, and boundaries

- **The owner authorization above is pending** (the one-time vault/session setup, or a per-release wallet
  `config set`). So is the publisher's actual relaunch and IPNS publication of the new value. I did not run the
  publisher: building its wasm risks going over the memory cap, and its value-change and recovery behaviour is covered
  by its own `scripts/e2e.sh`, not here. Nothing was checked against the DHT or delegates.
- **The secret-delivery precondition** for a vault-held publisher record is unverified.
- **CI was not run on GitHub.** No settings, variables or secrets were created. `gh run download` of the same run's
  artifact and the `site-release` environment are standard Actions behaviour, but they were not exercised here.
- **Real hosts were not touched.** The SSH path was tested only against a loopback sshd. Operators must install the
  agent (node built-ins only), `agent.json`, the forced-command key and an empty `root/headers.caddy`, and move their
  vhosts to `root/current/*` plus `import root/headers.caddy`. Production still serves `bafybeig3rai…` unchanged.
- **The agent and the client must run tool versions that derive the same `release.json`.** A mismatch is refused, never
  served.
- **Distinct targets do not prove distinct operators.**
- **The release-pointer protocol** (`docs/ipns-release-pointer-proposal.md`) is a proposal only.

## Files

**New:**
- `scripts/site-release/ssh.mjs`, `scripts/site-release/agent.mjs`;
- `test/site-delivery.test.mjs`, `test/site-publish.test.mjs`;
- `docs/ipns-release-pointer-proposal.md`;
- `work/site-automation-interface.txt`.

**Changed:**
- `scripts/site-release/targets.mjs`: ssh targets, `receiveCar`, headers-before-content activation, cross-kind rollback,
  `validateTarget`;
- `scripts/site-release/publish.mjs`: `loadPublication`, `publishRelease`, `@enclave-cli`;
- `scripts/site-release/cli.mjs`: `deliver`, `publish`, `agent`;
- `site/deploy.sh`: the new commands in the pass-through;
- `.github/workflows/deploy.yml`: the `site` outputs, the new `site-deliver` job, the header comment;
- `test/site-release.test.mjs`: `root/headers.caddy`, the workflow assertions;
- `docs/site-release.md`;
- `README.md`: the two related lines.
