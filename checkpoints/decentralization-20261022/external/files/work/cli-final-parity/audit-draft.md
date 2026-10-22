## Command-by-command audit: independent mode vs the hosted CLI (final tree, `cli/enclave.mjs` `6f965f11`)

**Command-word coverage**
- **Every hosted command word routes in independent mode.**
  - All 42 keys of `COMMANDS` are in `INDEPENDENT_COMMANDS` (42 names).
  - `INDEPENDENT_REFUSALS = {}`, so no command word is refused.
  - `secrets` was the last refusal; it routes to the frozen owner-read glue (`cli/custody-independent.mjs` `db712c1d`).
- **Every hosted `session` subcommand has an independent path:** new, resume-wait, status, list/ls, use, terminate/end,
  top-up-link and delegate, plus independent-only open, inspect, top-up and revoke-all. The catch-all refusal
  (`enclave.mjs:3906`) only names the independent set for an unknown subcommand.
- **Every hosted `host` subcommand has an independent path:**
  - init, build, install, run, check and referral, through `hostLifecycle`;
  - declare-payout, clear-payout, fund and status;
  - the new `guarded-release on|off` (`enclave.mjs:4774`).

**What remains is flag-level or data-level, and deliberate.**

| command / form | independent behaviour (refusal text location) | why | implementation owner |
|---|---|---|---|
| `hosts --relays / --caps / --region / --cap` | refused, `REGISTRY_UNSUPPORTED` (`enclave.mjs:5243`, `independent.mjs:203`) | the deployed EnclaveRegistry is schema 4; capability bits, regions, registerRelay and setCaps exist only in the undeployed schema-5 source | contracts / registry deployment (root governance); no CLI work until a schema-5 registry is deployed and pinned |
| `deploy` without `--cpu`/`--gpu` | refused, "independent mode requires explicit --cpu and --gpu" (`enclave.mjs:2080`) | hardware sizes are not on chain (the hosted API fills them from the catalog service) | catalog/registry contract owner, if sizes are ever published on chain; otherwise final |
| `stop <non-bytes32 id>` | refused, "stops on-chain deployments (bytes32 ids) only" (`enclave.mjs:1524`) | non-bytes32 ids are hosted-service records with no ledger row | final (hosted-only objects) |
| short id prefixes (`status`, `gpu`, `attest`, `custody`, `secrets`) | refused: "needs an on-chain deployment id" / "the full bytes32 deployment id (no prefix lookup)" | a prefix lookup needs the hosted index or an unbounded scan | final (could be a bounded owner-scan in `ls`; CLI owner, low priority) |
| any hosted API call (`api()`) | refused, "independent mode never contacts the Enclave API" (`enclave.mjs:763`) | the trust boundary of independent mode | final |
| `login` / `account`: hosted credit balance and order history | not available; independent login is the on-chain session and its top-up link | credit and orders are hosted-service data | hosted service (not reproducible from chain) |
| first deployment by passkey only (no wallet) | needs a wallet key or an external signer (`enclave.mjs:1248`) | a passkey account is a hosted identity | hosted service / web passkey wallet owner |
| `custody … --rules-from-relay / --admit / --v2`, custody v1 | refused (`custody-independent.mjs:185`) | independent custody is v2 only, with no relay prediction | final (v1 is the hosted path) |
| `custody` / `secrets` for a CONTRACT owner (ERC-1271) | the CLI signs as an EOA: the key, or `--signer URL --from` | contract-owner OwnerRead signatures go through the shared module and browser flow (`test/custody-owner-read.test.mjs`, 13/13 here) | owner-secrets worker / web client; CLI integration would need a 1271 signing hand-off |
| `availability` | needs a reviewed `--profile` and a named source (`enclave.mjs:2943-2947`) | explicit pins carry no registry code hash; there is no default capacity directory | final (capacity directories are operator-run) |
| `attest` | needs `--native-profile` (`enclave.mjs:5570`) | it verifies the app guest itself | final |
| `gpu` | needs `--directories` (`enclave.mjs:5473`) | there is no hosted directory | final |
| `ls` without a key | needs `--owner ADDRESS` (`enclave.mjs:5186`) | there is no hosted account | final |
| sessions relay | never contacted (`enclave.mjs:3648`) | the independent sessions path is on chain | final |
| `move` with the same operator | allowed only on `deploymentsSchema() >= 17` AND `guardedReleaseOnly(sourceOperator)` at one agreed block; otherwise refused | live ledger 16 cannot tell a re-claimed lease from the one being released | ledger17 migration (activation) and the operator's explicit `host guarded-release on` |
