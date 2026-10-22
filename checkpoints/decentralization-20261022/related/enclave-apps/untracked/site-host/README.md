# site-host

The Enclave website as an Enclave app. One `wasi:http` component serves one content-addressed website release (the
enclave repo's `site/deploy.sh prepare` output) at the origin root of its deployment, routed and headered exactly like
the vhost it replaces.

- **The release is inside the component.** The release CAR is embedded at build time. The app's catalog CID therefore
  covers every byte of the site, and a host that runs it needs no gateway, bucket, mirror or network.
  - The component's WIT world imports nothing: no `wasi:http/outgoing-handler`, no `wasi:sockets`. The end-to-end
    test asserts this on the built binary and then serves the whole site from inside a loopback-only network
    namespace.
- **The deployment pins what it serves.** The deployment config must be `{"release": "<CID>"}`. A missing pin, a
  different CID, an unknown key or non-JSON refuses the whole site: every path answers 503, with no release byte,
  `default-src 'none'` and `no-store`.
- **Nothing in the archive is trusted because it is there.** Each request walks from the pinned root and re-hashes
  every block it serves (src/car.rs). A flipped byte in any block yields a 502 for exactly the files that need it, and
  never altered content. A fault in the root or a directory refuses the site.
- **The release must be a release.** At every instance start the component audits the tree (src/site.rs) and refuses
  it unless all of the following hold:
  - the release ledger (`/.well-known/enclave-site-release.json`) is well-formed;
  - the header policy is plain token/value pairs, with the `script-src SCRIPT_SRC` slot, and sets none of the response
    headers this app owns;
  - every file name has a known type (src/mime.rs), and nothing is served as a guessed or sniffed type;
  - nothing sits on a platform-reserved path (`/.well-known/enclave-*`, `/__enclave/`) or on this app's evidence path;
  - there are no HAMT shards, symlinks or non-file/non-directory nodes;
  - every `_redirects` rule is one the production generator accepts;
  - the installers, `404.html` and `_redirects` are present.

## Routes (the production vhost's, from work/site-recovery-endpoints/*.candidate.caddy)

| Request | Answer |
| --- | --- |
| a file of the release | its bytes. The type comes from the table; the headers come from the release ledger (the same values the release tool renders into `headers.caddy`). |
| a `_redirects` path (e.g. `/dashboard`, `/apps`, `/sso/authorize`) | the rewrite (200) or redirect (301/302, query kept). It applies only when neither the path nor `path/index.html` is a file, and matches case-insensitively, like Caddy's `path` matcher. |
| a directory | with `index.html`: `308` to the slash form, then the index. Without one: 404. |
| a file with a trailing slash | `308` to the file |
| `/install.sh`, `/install.ps1` | the release's own `get/install.*`, as `text/plain` |
| anything else | `404.html` with a real 404, `no-store` |
| `/.well-known/site-host` | JSON: the served CID, the ledger's build time, file and block counts (`no-store`). The same path names the refusal when the site is refused. |

Header details:
- `Cross-Origin-Opener-Policy` is dropped for the SSO popup documents, as on the vhost.
- `/js/boot.js` is `no-cache`; `js/chunks/**` (content-hashed names) are `public, max-age=31536000, immutable`; every
  other file is `no-cache`, revalidated through its ETag.
- The ETag is the file's own CID; there is no `Last-Modified`.
- Single `bytes=` ranges are honoured, with `If-Range`. `If-None-Match` gives a 304.
- GET and HEAD only; any other method is 405.
- A path with an encoded separator (`%2F`, `%5C`), an encoded `%`, a dot segment, an empty interior segment, a control
  byte or invalid UTF-8 is a 400. It is never cleaned into some other file.
- No compression, so no `Vary` and no encoding-keyed cache entries.

## Build and test

The release is pinned in source by `release.lock.json` (CID, CAR sha256 and size). The CAR itself, about 45 MB, is a
build INPUT and is never committed (`.gitignore`). This follows the jot convention for its model: not committed, and
reproduced by hash.

```sh
# the input, from any source. The CID is the authority; every byte is checked against the lock.
site/deploy.sh fetch --cid <CID> --gateway <url>[,<url>] --out ../releases     # (enclave repo)
# or use an existing release directory / the CAR file alone

scripts/build.sh --release ../releases/<CID>     # or: scripts/build.sh --car <path>/site.car
scripts/test.sh  ../releases/<CID>               # the built dist/site_host.wasm, end to end
```

`scripts/build.sh` takes these inputs:
- the pinned toolchain (`rust-toolchain.toml`: nightly-2026-07-25, the toolchain eyesoff-ai pins and verified against
  the fleet engine);
- `cargo build --locked`;
- build paths remapped (`--remap-path-prefix`).

The same inputs therefore give the same `dist/site_host.wasm`, whatever directory or user builds it. The script then:
1. validates the CAR against the lock (`scripts/embed-release.mjs`);
2. builds the component;
3. refuses a binary that imports `wasi:http/outgoing-handler` or `wasi:sockets`;
4. writes `dist/PACKAGE.json` (wasm hash and size, embedded release, toolchain, source digest, imports, catalog
   resources) and `dist/SOURCE.sha256`.

`scripts/test.sh` runs `test/e2e.mjs` under `wasmtime serve -Scli -Shttp`, with the wasm manager's memory cap and
`/config` preopen, inside `unshare -rn` (loopback only). That run checks:
- every release file, byte for byte;
- every route;
- hostile paths, validators and ranges;
- wrong, missing and ambiguous pins;
- the file-only config path.

`--native` adds `tests/site.rs` (the same verification and routing code on the host, including tampered archives).

For a compatibility verdict, set `WASMTIME` to the fleet engine: the `/bin/wasmtime` of the image pinned in the enclave
repo's `wasm/Dockerfile.wasm` (`ghcr.io/enclavehost/enclave-wasmtime@sha256:13bce266…`, wasmtime 49.0.0 ac0772970),
with `LD_LIBRARY_PATH` set to its `/lib`.

## Publish and deploy (root: the Enclave owner's signatures and spend)

See the package plan delivered with this app (PUBLISH-PLAN.md). In short:
- `enclave publish dist/site_host.wasm --slug enclave-site --mem 256 --cpu-gflops 10 --config '{"release":"<CID>"}'`.
  It is published by the catalog owner, so the version is approved as published; otherwise the catalog owner approves
  it.
- `enclave deploy enclave-site:<n> --fund <usd>` (public), then a strict placement pin per serving host.

A new site release is a new component (new catalog version), because the release is embedded. Rollback is the
previous version, which is still in the catalog. The `release` pin is a second, explicit statement of the CID: an owner
`enclave config set <id> '{"release":"<CID>"}'` that names anything else stops that deployment serving, and never
switches it to other content.

## Trust

- **The bytes.** The pinned CID, verified per request inside an attested guest.
- **The deployment's authority.** Its on-chain owner, plus Enclave's platform administration (catalog delisting,
  host bans, contract upgrades), all unchanged.
- **Not trusted from the name.** A name such as `enclave.host` resolving to a host gives that host no trust. What it
  serves is checkable against `/.well-known/site-host` and the release CID; which hosts receive the name stays an
  Enclave-admin DNS decision.
- **Permissions-Policy.** The release carries its own `Permissions-Policy`. That replaces the platform's default
  `publickey-credentials-*=()` for this app, as it does for any app that sets the header (supervisor.js
  `tenantHeaders`). The site needs WebAuthn.
