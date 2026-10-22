# Site release without Nan: result (2026-10-19)

The interface was written first: `work/site-release-interface.txt`. User documentation is `enclave/docs/site-release.md`.

Repo: `work/enclave`, HEAD `d0676ff3`. Nothing is committed.

**What I did not do:**
- no production use, SSH, remote chain writes, GitHub settings, commits or wallet operations;
- I did not run the old `site/deploy.sh`;
- I did not run `npm run build:site`, because it rewrites `site/css/site.css`, which another worker has modified.

**What I did not edit:** browser/CLI runtime, Windows, storage SDK or custody files.

The previous CLI move/release work is unchanged; its report is `work/claude-cli-release-result.md`.

## What was replaced

The old `site/deploy.sh` and its CI site job:
- SSHed to the alias `nan` (vars.SITE_SSH_HOST);
- `rm -rf /opt/nan-site`, then untarred over it: a destructive live overwrite with no staging or rollback;
- patched `/etc/caddy/Caddyfile` in place;
- ran `nan-deploy.sh`, which publishes with a box-held IPNS key and hands the CID to the enclave ipns-publisher through a
  mutable `site-root` URL.

None of that remains in the site path. The site job holds no SSH key and names no host.

## Implemented

### Content identity (pure JS)

**`scripts/site-release/unixfs.mjs`** is a UnixFS directory importer with kubo 0.42's `ipfs add -r --hidden --cid-version 1`
profile: CIDv1 sha2-256, 256 KiB raw leaves, balanced 174-link files, and basic dag-pb directories sorted by name.
It refuses:
- a directory kubo would shard (HAMT);
- symlinks and special files;
- unrepresentable names.

**`scripts/site-release/car.mjs`** writes and verifies CARv1. Verification works from the bytes alone:
- one root, equal to the expected CID;
- every block hashes to its CID;
- every reachable block is present, and nothing is extra;
- every file is reassembled and its sha256 checked.

**Measured against production:** for `work/logo-site-hotfix/final/site` the importer gives exactly
`bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y` (716 files, 614 blocks). The written CAR is
**byte-identical** to the production `site.car` (sha256 `16c498f3…`), and the root block equals `site-root.block`.

### The release (`scripts/site-release/release.mjs`)

**`prepare`** builds one union tree:
- the build;
- the installers, at `/get/{install.sh,install.ps1,host.ps1}`, content-addressed with the site;
- the base's `js/chunks/**` that the build dropped, while they are within **48h of their last build**;
- an in-tree ledger, `/.well-known/enclave-site-release.json`, carrying retention dates, the CSP hash union (48h), the
  header policy and `previous`.

It refuses:
- a hashed name whose bytes differ from the base's;
- a release with no base, unless `--no-base-i-accept-dropping-old-chunks` is given.

A base without a ledger, such as current production, has its files and hashes dated to `--base-built-at` or to now
(conservative). The release is staged, the CAR is round-tripped and verified, and the staging directory is renamed to
`OUT/<CID>`. An existing release dir is verified and reused, never overwritten.

**Derived from the tree alone,** so any mirror rebuilt from the CID has the same bytes:
- `release.json`, the reviewable manifest: CID, CAR and root-block hashes, every file's path, size, sha256 and CID,
  retention, the effective headers, the installers;
- `headers.caddy`: CSP with the `script-src` union, COOP, Permissions-Policy, Referrer-Policy, HSTS and nosniff, from
  `scripts/site-release/headers.json` (the production values);
- `installers/`, `site.car`, `site-root.block`, `site-root.txt`.

**Other commands:**
- `verify` re-derives and compares everything;
- `review` prints a summary and the `--approve <CID>` to use;
- `fetch --cid --gateway …` takes the CAR from untrusted gateways. The bytes must verify to the CID, and the release dir
  is rebuilt byte-identically; `--as-base` fetches a base.

### Targets (`scripts/site-release/targets.mjs`; the operator's targets file; unknown keys refused)

**`local-root`:**
- **Mirror:**
  - a lock;
  - a stage under `.incoming-*`, a full verification there, then `rename` to `root/<CID>`;
  - an existing CID dir is verified, and a different `release.json` is refused;
  - an interrupted run leaves only `.incoming-*`, which the next run removes.
- **Activate:**
  - an atomic link swap of `root/current` (rename), recorded in `releases.jsonl`;
  - reload (an argv, no shell);
  - a probe of the live bytes **and** headers;
  - all-or-nothing rollback across targets.
- **Rollback:** the same swap.
- **Prune:** never current or previous, never inside 48h, never an unrecorded release.

**`kubo`:**
- `dag/import?pin-roots=true` with the CAR; the returned root must equal the CID;
- then `pin/ls` (recursive) and `block/get` of the root must match;
- auth is an environment variable **name** (`authEnv`).

A **mirror succeeds only if every target verified the same CID**.

### Publication (`scripts/site-release/publish.mjs`)

**`publish-plan`** takes the owner's `enclave config show <id> --json` of the ipns-publisher deployment.
- It changes **only** `value`, to `/ipfs/<CID>`. Every other key, including the `ipnsKey` reference `$IPNS_ED25519_SK`
  (**the same signing identity**), stays byte for byte.
- It refuses, without printing the value:
  - an `ipnsKey` or `api_key` that is not a `$NAME` reference;
  - key-like material anywhere in the config;
  - a no-op;
  - another deployment's output;
  - a startup-package or CID-pinned config.
- It warns when the old value was a mutable URL.
- It writes the new config and `publication-plan.json`:
  - the exact `enclave config set <id> --file …` for the owner's wallet;
  - the `--unsigned --from OWNER` variant for an external wallet;
  - the checks to run afterwards.

Nothing is signed or sent.

### `site/deploy.sh` and CI

**`site/deploy.sh`** is a host-free wrapper: `prepare` builds and then calls `site-release prepare`; the other commands are
passed through. Its non-comment text names no host, path, SSH, Caddy or URL; a test asserts this.

**The `.github/workflows/deploy.yml` site job:**
1. `npm ci`;
2. fetches the base by CID: `vars.SITE_RELEASE_BASE_CID`, from `vars.SITE_RELEASE_GATEWAYS`, verified. Otherwise it
   fails, unless `vars.SITE_RELEASE_BASE=none`;
3. prepares and verifies;
4. writes the review to the job summary;
5. uploads the release with the repo's already-pinned `actions/upload-artifact`, with `include-hidden-files: true`.

**Detection:**
- `site/**`, `cli/install.*` and `cli/host.ps1` still trigger the site job;
- `scripts/site-release/*` is tooling and does not.

No other job was edited.

## Exact runs

All runs were serial under `/tmp/s6/run-768.sh`. It kills only its own process group at >768 MiB own RSS,
<16384 MiB available, or after 900 s. No run was killed. The node peaks come from an in-process `maxRSS` preload,
because the guard samples once a second.

| Run | Result | Peak |
| --- | --- | --- |
| importer on the production tree | CID `bafybeig3rai…` reproduced, 716 files, 225 ms | 103 MiB in-process |
| CAR writer and reader on the production tree | CAR byte-identical (`16c498f3…`); the production `site.car` verified, with all 716 file hashes equal to its manifest | guard 40 MiB |
| `test/site-release.test.mjs`, 1st | 8/9: a test regex did not match the actual refusal text. Fixed. | guard 46 MiB |
| **`test/site-release.test.mjs`** (final, with the fetched-base and cached-tab assertions) | **9/9, 0 fail, 0 skipped** (kubo installed; production tree present) | node test process 174 MiB; guard 238–276 MiB including kubo children; min available 16997 MiB |
| smoke: `prepare` of the existing local `site/dist` (built 2026-10-18; read only) on the production base | release `bafybeie3zzfuj6b7bfwaobrsdihsrnz4iosbbiocz5ax5htprmc26hz6iy`: 802 files, **all 642 production chunks inherited**, 6 CSP hashes, the 3 installers | 242 MiB in-process |
| smoke: `site/deploy.sh verify` of that release | verified | guard 38 MiB |
| smoke: kubo 0.42 offline `add --only-hash` of the release tree | the same CID `bafybeie3zzf…` | — |
| smoke: kubo offline `dag import --pin-roots` of its CAR | "Pinned root … success" | guard 60 MiB |

The smoke release is **not a production candidate**. It was built from a stale working-tree `dist`, and per instruction
it must not replace production. It was deleted after the check.

**What the 9 tests cover:**
1. **The importer:**
   - equals the storage SDK's single-file CIDs (0 B to 700 KB);
   - equals kubo offline on a synthetic tree with dotfiles, nested and empty files, and a 3-chunk file;
   - reproduces the production CID and CAR bytes;
   - refuses symlinks and HAMT-size directories.
2. **Retention across three releases (T0, +24h, +49h):**
   - a chunk is kept 48h after its last build and then dropped; CSP hashes behave the same way;
   - installers and headers are present;
   - a differing hashed name is refused, and no staging directory survives;
   - no base without the explicit flag;
   - an identical rebuild is reused.
3. **A production-format base** (the real hotfix tree, no ledger): all its chunks and CSP hashes are kept, dated 48h
   from now, and `previous` = the production CID.
4. **Tampering refused:** a tree byte, a CAR byte, `headers.caddy`, a stray file, an installer; also a CAR block that
   doesn't hash, and a wrong root.
5. **Fetching by CID:**
   - a lying gateway is refused;
   - an honest one rebuilds a **byte-identical** release dir;
   - no gateway means no default;
   - `--as-base` records `previous` and carries retention forward.
6. **Mirror and activate:**
   - two local roots and a fake kubo RPC (which itself verifies the CAR);
   - a strict targets file (a smuggled `token` key is refused);
   - an **interrupted copy** (power cut after 5 files) leaves nothing under the CID, a stale `.incoming` is cleaned, and
     the rerun completes;
   - a repeat is idempotent; a different `release.json` under the same CID is refused;
   - a lying kubo root block fails that target, and the run is not ok; a held lock refuses a second run;
   - **activation with real reloads** (argv), with probes against loopback fronts that serve `current/site` with the
     headers of `current/headers.caddy`;
   - **the second target serving stale bytes rolls back BOTH**;
   - the `releases.jsonl` history, then rollback;
   - **a tab cached on release 1 loads its old chunk, under a live CSP that includes its inline-script hash, after
     release 2 is active**;
   - prune keeps everything inside 48h and refuses fewer than 48h.
7. **Publication plan:**
   - only `value` changes, and the identity reference is unchanged;
   - the mutable-URL warning; the owner and external-wallet argv;
   - a literal key, a non-reference `api_key` and key-like material in `ipni` are refused **without echoing them**;
   - the wrong deployment, a no-op and a missing config are refused; refusals write no files.
8. **Real kubo (offline):** imports and pins the release CAR, and `ipfs get` reads back every file with its manifest
   sha256.
9. **`site/deploy.sh`** passes `bash -n` and names no host, path, SSH or URL. The site job has no ssh, nan,
   DEPLOY_SSH_KEY or /opt; it fails without a configured base, keeps hidden files in the artifact, and detection still
   ships site and installer changes.

## Publication authority boundary (not claimed done)

- **Publishing needs the deployment owner's wallet.** `setConfig` is owner-only. This task produces the exact config
  file and argv, but signs and sends nothing. Afterwards, the live instance (`d9798e4c…`) relaunches with
  `value: /ipfs/<CID>` and signs with its existing key. That was **not exercised here** (no network or wallet).
- **No proof of the DHT or delegate result.** The plan lists the checks: the publisher's `/api/status`, and an
  independent resolver. Running them needs the network.
- **CI does not push anywhere.** Operators download or `fetch` the release, then `mirror` and `activate` with
  `--approve <CID>` on their own machines. `vars.SITE_RELEASE_BASE_CID` must be advanced by the operator after each
  publication; automating that from the signed IPNS record is not implemented.
- **Production migration is not performed.** Production still serves `bafybeig3rai…` through per-CID paths in each
  Caddyfile. The one-time change to `root/current/site`, `root/current/installers` and
  `import root/current/headers.caddy` is documented (docs §"Moving production onto this"), not applied.
- **The `kubo` RPC target** is tested against a fake RPC that verifies CARs like a node. A real kubo was used offline
  through its CLI (import, pin, get), not through a running RPC daemon.
- **Independence is not proven.** Distinct targets, gateways or URLs do not prove distinct operators; reports list which
  targets verified the CID, never who runs them. A storage adapter's `add-file` of the CAR would be a FILE CID, and is
  deliberately not offered as site-root replication.
- **HAMT-sharded directories are refused.** At about 66 bytes per link, a directory reaches kubo's 256 KiB sharding
  threshold near 3,900 entries. `js/chunks` holds 732 files in the smoke release, bounded by the 48h retention.
- **The ledger is public:** it carries the commit, build times and the headers.

**Remaining Nan references outside my scope (not edited):**
- the `relay` job's SSH config (`Host nan`);
- `scripts/nan-deploy.sh`, `scripts/deploy-nan-deploy.sh` and `scripts/deploy-ipfs-gateway.sh`. The site path no longer
  calls any of them.

## Files

**New:**
- `scripts/site-release/{unixfs,car,release,targets,publish,cli}.mjs`, `scripts/site-release/headers.json`;
- `test/site-release.test.mjs`;
- `docs/site-release.md`;
- `work/site-release-interface.txt`.

**Changed:**
- `site/deploy.sh` (rewritten);
- `.github/workflows/deploy.yml` (the site job, the site detection, the header comment);
- `README.md` (the two site-deploy lines).
