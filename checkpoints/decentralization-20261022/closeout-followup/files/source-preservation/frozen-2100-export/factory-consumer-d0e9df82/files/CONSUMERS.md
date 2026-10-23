# Source consumers of the original book key `sessionVaultFactory` (non-test; work/enclave e762a9c5, custody repo ab589bf8)

**How this was made.** A read-only source sweep, by a sub-search with my spot-checks. The class A code is the same in
both trees; the release tree lacks `mcp/`, `metal/guest/measured-control.mjs`, `session-factories.mjs`,
`lease-gas-owner.mjs` and the bundles. Line numbers are main's.

**A — read the ORIGINAL mutable book key at runtime**

| consumer | book from | today (key 0) | after activation |
|---|---|---|---|
| `network/owner-signature.mjs` 19 `oneClient` (only when the caller passes no factory) | the caller's addressBook | a vault-held owner's signature is refused | the vault's owner signature verifies |
| ↳ `relay/network-api.mjs` 36 | `ADDRESS_BOOK_ADDRESS` env | owner network policy / BYO 403 for vault-held | accepted for the vault owner |
| ↳ `network/enclave-network-host.mjs` 80 (no `authorityPins`) | privacy agent `cfg.chain.addressBook` | refused | accepted |
| ↳ `network/wg-provider/main.mjs` 55 (legacy bootstrap) | `boot.addressBook` (install default 0xab21…) | refused | accepted |
| ↳ `network/directory-server.mjs` 75 (unpinned LeaseReader) | configured book | refused | accepted into the directory |
| ↳ `scripts/network/owner-policy.mjs` 27 | default 0xab21… | refused | accepted |
| `relay/sessions.mjs` 421-426 sessions service (only if `SESSIONS_FACTORY` unset) | `SESSIONS_BOOK` or 0xab21… | 503 `sessions_disabled` | sessions API on; indexer starts at about the last 5000 blocks unless `SESSIONS_START_BLOCK` |
| `relay/sessions.mjs` 1111-1119 custody gate (only if `SESSIONS_FACTORY` unset), wired at `api-relay.js` 584 | `ADDRESS_BOOK_ADDRESS` | the vault itself is the owner; no wallet signs for vault-held secrets/domains/placement; vault payments land in billing review | the vault owner signs; payments are classed as session fees; stricter `held()` gating for recognized vaults |
| `windows/node/session-api-auth.mjs` 250-259 (supervisor 3732, Windows agent 99; bypassed by contract pins) | `ADDRESS_BOOK_ADDRESS` / 0xab21… | the zero entry is skipped; `DEFAULT_FACTORIES` already has 0x1F5c… | no change, unless an operator's `SESSIONS_FACTORIES` omits 0x1F5c… |
| `cli/enclave.mjs` 4312 `session delegate` (unpinned) | book | falls back to `DEFAULTS.SESSION_VAULT_FACTORY_ADDRESS` = 0x1F5c… | no change |
| `scripts/network/capture-network-authorities.mjs` 10-17, `capture-contract-pins.mjs` 12 | book | pins capture 0 (sessions off in new pins) | pins capture 0x1f5c… |

**B — pinned or independent value (unaffected)**
- `network/reconcile-core.mjs` 15: compares chain `authorityPins` with the pin document.
- `management-auth.mjs`, `management-gateway.mjs`, `native-client.mjs`.
- `service-index.mjs` explicit bootstrap; `relay/dns-relay.js` 111 (pinned zero).
- `cli/enclave.mjs` pinned/independent paths; `cli/lease-gas.mjs`, `lease-gas-owner.mjs`.
- `mcp/independent*.mjs` (pinned factory; reads `implementation.book()` for other keys only).
- `metal/guest/measured-control.mjs` 85/190-195: requires a PINNED `contracts.sessionVaultFactory` for MCP and never
  reads the book.
- Site config and independent site, `browser-profile.mjs`, custody v2 (`custody/v2/*`, `cli/custody-independent.mjs`).

**C — validation and pins only:** `contract-pins.mjs`, `network-authorities.mjs`, `authority-profile.mjs`,
`session-factories.mjs` (0x1f5c… listed as kind "book", book 0xab21…), `verify-profile.mjs`, site independent UI,
`cli/independent-host.mjs`.

**Contracts** (my reading): v1/v2 vaults `beneficialOwnerOf`, and `SessionVault.release` 838. `PinnedSessionVaultFactory`
and the pinned vault variant use immutables.

**Running relay (root, 20:35Z, `custody-v2-live-20261023/evidence/relay-session-authority.json`; `api-relay.js` sha256
`481f0041…` = `nucbox-tls-20261021/combined/payload/api-relay.js`):**
- `SESSIONS_FACTORY` = `0x1F5c887c…`, so both `relay/sessions.mjs` rows are unchanged by activation.
- Its network API (2656-2657) passes only `addressBook`, so the `relay/network-api.mjs` row DOES change.
