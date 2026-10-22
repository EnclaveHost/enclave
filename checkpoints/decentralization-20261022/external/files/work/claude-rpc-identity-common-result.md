# Shared RPC identity: INTERIM (superseded by a new task before completion)

Uncommitted source; hashes:
```
74cb965ee1ae031566ac0f060e4ebdf512089cc702c0ec54c2f98113834c5d57  network/rpc-identity.mjs
d885b303b8f860e5be1e498be0078f3cef16e4d77c84211769cc5c67839d9347  network/lease-reader.mjs
aa931eda9624e1461dccc1f094faf6bdbabf925f176f61b2a4926f2ec84776de  network/service-index.mjs
4610d416781e296a5bc81b65a8ac61d230307c966a302b0cfb2bff95ec85ce1c  scripts/network/service-index.mjs
7c6e56c7a8e2f1fff432a0380a2a770b0f405efe0e1635a294710a65dbc906bd  custody/v2/quorum.mjs
ff9e46d9bcec08ff50ab04f0f4581845050b70e5c68debb64ec3cdf255822668  windows/node/host-identity.mjs
```

## Done

- **New `network/rpc-identity.mjs`:** pure and browser-compatible (URL, regex, integer math; no imports, no DNS).
  - `rpcEndpoint(raw, {loopbackPorts})` returns `{identity, host, loopback, port, label}` or throws `RpcUrlError`
    (`code` url | scheme | secret | host). The message names no part of the URL.
  - Also exported: `canonicalHost`, `rpcLabel` (scheme, canonical host and port only) and `redactUrls`.
  - The rule:
    - lowercase, with all trailing dots stripped;
    - empty labels refused;
    - IPv4-mapped `::ffff:0:0/96` folded to IPv4, including loopback;
    - NAT64 `64:ff9b::/96` folded for the vote, never loopback;
    - https only, with plain http only on loopback;
    - no credentials or fragment.
- **Call sites now on the helper.** Each keeps its exports, return shapes and existing messages:
  - `network/lease-reader.mjs` `rpcIdentity`; failure text is now passed through `redactUrls`.
  - `network/service-index.mjs`:
    - `rpcIdentity` still returns the identity, or `null` for an unusable URL;
    - `rpcLabel` is now the safe label;
    - `peerList` now refuses a malformed or non-policy exposed `transport.url`. Before, it dropped it silently.
      URL-less test doubles are still allowed;
    - evidence `errText` is redacted.
  - `scripts/network/service-index.mjs` `peersFor`.
  - `custody/v2/quorum.mjs` `rpcIdentity` (custody reports only codes, never library messages).

## Tests (single concurrency)

| File | Result | Max RSS |
|---|---|---|
| `test/lease-reader.test.mjs` | 31/31 | 142 MB |
| `test/service-index-quorum.test.mjs` | 10/10 | 85 MB |
| `test/service-index-rpc-config.test.mjs` | 2/2 | 83 MB |
| `test/custody-v2-chain-quorum.test.mjs` | 11/11 | 83 MB |

## Not done

- **`windows/node/host-identity.mjs`: untouched.** It still does not fold mapped IPv4. `rpcPeerHost` and `httpsUrl`
  still echo `u.href` and `JSON.stringify(url)`, and with them credentials. `why()` and `main()` still print
  unredacted library messages.
- **Planned Windows change, not applied:**
  - `rpcPeerHost` returns the canonical host for public hosts. For loopback it returns `loopback` by default (the
    stricter production policy, where all loopback is one host) and `loopback:<port>` with `localFixture`.
  - Errors use `rpcLabel`, with the regex phrases the tests match (`not a URL`, `must be https`,
    `malformed host`, `one host`, `distinct hosts`).
  - `httpsUrl` names only `scheme//host`.
  - `why()` and `main()` use `redactUrls`.
- **New regressions not yet written:** mapped and NAT64 aliases in service-index, custody and Windows; credential
  redaction; and malformed exposed URLs in `peerList`.
