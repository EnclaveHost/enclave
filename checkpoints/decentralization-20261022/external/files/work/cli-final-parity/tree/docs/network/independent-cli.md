# Independent CLI mode

`enclave --independent …` runs the CLI without Enclave's hosted services:
- no `api.enclave.host`;
- no fleet tunnel;
- no mutable `EnclaveAddressBook`;
- no first-answer RPC.

Every chain fact the CLI acts on comes from **explicit authorities** and from **k of n RPCs returning identical answers at
the same confirmed, fresh block**. The code is in `cli/independent.mjs` and `cli/independent-host.mjs`, wired into
`cli/enclave.mjs`.

**Scope.** This is a client mode. It does not make any contract owner, host, directory or RPC operator independent; see
"Trust and limits".

## Trust inputs

| Flag | Meaning |
| --- | --- |
| `--profile FILE --profile-digest sha256:…` | A reviewed authority profile (`docs/network/authority-profile.md`). It is used only when its bytes match the digest you supply. Its contract pins and USDC address are used. With a profile, every contract a command relies on must carry the reviewed code hash at the agreed block. |
| `--contract-pins FILE` | The alternative: the strict pin document (`network/contract-pins.mjs`). If you also pass a profile, the two must be identical. |
| `--usdc-token ADDR` | The payment token with pins only (default: Base USDC). It must match the profile if one is given. |
| `--rpc A,B[,C…]` | Required: 2–8 URLs under the URL policy every independent reader shares (`network/rpc-identity.mjs`): HTTPS, plain HTTP only on loopback, no credentials or fragment. Each must be a distinct vote: one public host is one vote however it is addressed, and loopback counts by port. There is no default set. Messages and peer failures show only redacted labels (scheme, host, port), so a key in a path or query never reaches output. |
| `--quorum N` | How many RPCs must agree (default 2; at most the number of RPCs). |
| `--confirmations N` | How deep the agreed block is (default 2). A record written in the last N blocks is not visible yet. |
| `--max-block-age SEC` | An agreed block older than this is refused (default 120). |
| `--max-fee-gwei G` | Refuse to sign above this fee per gas (default 5). |

**How a read works.**
1. Every RPC is asked for its chain id and head.
2. The block is the `quorum`-th highest head minus the confirmations, and never lower than a block already used.
3. Every candidate peer reads at that block. Its timestamp must be fresh, and its hash must be unchanged after the read.
4. `quorum` peers must return identical answers.

**What fails.** The following fail with an error and a nonzero exit:
- too few peers;
- a wrong chain id;
- a stale block;
- disagreement.

A failed read is **never** shown as an empty list or a zero balance. A fallback for an absent getter or record is
allowed only when the quorum agrees that the call reverted.

## Commands

| Command | Independent behaviour |
| --- | --- |
| `ls [--owner ADDR]` | The wallet's records, plus its pinned-factory session vault's, from `count()`/`getPage()` at one agreed block. `claimed` is a ledger fact, not proof the app answers. |
| `status <id>` | The record, cap, fee and proof state at one block. When leased, also the runner's registry entry, including whether its operator matches the lease's. |
| `status <id> --host` | Adds the host-reported status from the runner's signed management endpoint (see below). |
| `hosts [--all]` | Every registered host from the **deployed schema-4 registry**: endpoint, operator, posted prices, heartbeat age and proof key. "Live" means active, priced, and a heartbeat within one hour. |
| `pricing` | The cheapest posted node and card prices among live hosts. Hardware sizes are not on chain. |
| `apps`, `whoami` | Catalog and balances through the quorum. Account sessions (passkey) are a hosted service and are not used. |
| `deploy <app> --cpu --gpu [--max-rate] [--fund …] [--prepare-only]` | Always chain-only. Without `--max-rate`, the ceiling is the cheapest live registry price for the chosen shares. |
| `fund`, `stop`/`suspend`, `resume`, `rate-cap`, `refund`/`cancel`, `transfer`, `upgrade`/`set-version`, `resize` | Preconditions are read through the quorum, and the transaction is sent as described below. For `resize`, the lease holder's posted registry price is used, otherwise the cheapest live price. The version's hardware floors are not checked here, because sizes are not on chain; the host refuses a version that does not fit. |
| `bootstrap prepare\|publish\|activate … [--target snp\|shield]`, `publish … --storage-plan` | The pinned paths, with reads through the quorum. `--target` defaults to SEV-SNP; see "Startup targets". |
| `session inspect [<sid> \| --vault V --sid S]`, `session status` | The session as the chain holds it on the **pinned** factory: live or revoked/ended/expired, scopes, environments, balance. No relay is asked. `session list` and `session use` stay local. |
| `session new --preset P [--app] [--budget] [--days] [--label] [--owner ADDR]`, `session open <pending> --owner-signature SIG` | A relay-free grant on the pinned factory; see "Sessions". |
| `session terminate`, `session top-up [<sid>] --usdc N`, `session revoke-all [--vault V] [--withdraw]`, `session delegate` | Session key ends its own session; owner-signed USDC top-up; owner's DIRECT revoke of every session; the owner's ledger delegation. |
| `logs <id> [--tail N]`, `restart <id>`, `app-token <id> --out NEW_FILE`, `cpu-profile start <id> --seconds N \| stop <id> \| get <id> --out NEW_FILE` | Owner management through `network/management-client.mjs` (see below). |
| `gpu <id>` | The GPU state of that deployment's CURRENT host (`ManagementClient.gpu()`, scope `api.status`). The deployment id is required: the host comes from its lease, and there is no host lookup by name. The answer is host-reported capacity, not an attestation or a reservation; a CPU-only host's `no_gpu` is printed as "reports no GPU". Hosted `enclave gpu` is unchanged. |
| `attest <id> --native-profile FILE` | App attestation through the native client's own SNP verification. |
| `attest <id> --host-report` | The host's attestation document, labelled NOT VERIFIED, exit 3. |

| `config show\|set\|clear <id> [--waf …] [--storage-plan FILE]` | The owner's `setConfig` (or a session's `deploy.setConfig` on a STAGING record its vault holds), with reads through the quorum. `set` keeps the namespace you did not pass, and the isolation tier is kept verbatim. An owner-committed startup record accepts waf edits only, and a Shield (`hyperv-partition-per-app`) record refuses any waf, because the partition cannot enforce it. A config too big for the 4096-byte envelope is replicated with your own `--storage-plan`: wallet-signed per adapter, read back, at least `minimumCopies` copies, before its CID is referenced. Whether a host can fetch it depends on that host's gateways. Fleet support for config namespaces is not queried; a host that does not support them declines the claim. |
| `encvol message\|derive\|seal-creds` | Unchanged and entirely local (a wallet signature and local key derivation). |
| `host declare-payout\|clear-payout --url U`, `host fund --address A`, `host status --url U` | The payout declaration on the deployed schema-4 registry, sent from the payout wallet itself. An ETH transfer to the operator. The agreed registry entry and the operator's gas. The relay listing is not a chain fact and is not shown. |

**`move <id> <host-id> --directories IP,… [--wait SEC]`** (the target is a registry id from `hosts --all`; independent
mode has no host names). Defined in `work/independent-move-interface.txt`.
- **Before anything is sent**, the CLI checks:
  - the session is live and holds both `api.restart` and `api.placement`;
  - the holder rule;
  - the target is an active, priced schema-4 host;
  - the target is **not run by the same operator** as the current lease holder. The deployed ledger's `release(id)`
    names no lease, only the operator, so such a move is refused (temporarily; parity is open, see
    `work/lease-epoch-proposal.txt`). A queued record, which sends no release, is not affected;
  - the target's rate is within the cap, and the balance plus the refunded tail buys at least one second at it;
  - the target's own operator-signed management record resolves.
- **Release.** The current host gets **one** `release`. Whatever it answers, the CLI's quorum decides whether the lease
  was handed back.
  - If it was not, the CLI exits 1 after a definite refusal, or 4 when the outcome is unknown. Nothing is resent.
  - Re-running `move` is safe: once the lease is gone the gateway refuses a second release, and while an earlier release
    is unresolved the host refuses another (`release_in_progress`).
- **Hint.** Only after the release is confirmed does the target get a signed `claimHint`, repeated while the quorum is
  polled.
  - The result is what the quorum shows: moved, claimed by another host ("placement is a steer"), claimed back by the
    source after its stand-down, or still queued. A lease that ran out instead of being released is reported as "no
    live lease", not as released.
- **Funds.** The tail returns to the deployment's balance, and the target's claim buys time at the target's rate. No
  money moves between wallets.
- **Limit.** The ledger lets only the lease holder end a lease, so a dead or hostile source can only be waited out
  (stop, then resume, which forfeits the tail).

**`availability`.** Each host's own signed `/availability` record (`docs/network/independent-capacity.md`). Name a source:
`--capacity-directories URL,…` (anyone's capacity directory, not the management `--directories`), `--hosts ENDPOINT|ID,…`,
or `--cold` (every live registered host). Each record is verified against the reviewed profile's registry at one agreed
block, so `--profile` is required. The figures are self-reported by the host's registry operator and are never a
registered price; `hosts` still lists the posted prices.

**`login`, `logout`, `account`, `session resume-wait`, `session top-up-link`** (`cli/independent-login.mjs`,
`work/independent-login-interface.txt`). There is no account service. `login --frontend ORIGIN` makes a local session key
and a bounded grant, and prints an approval link to the frontend origin you chose, together with a check code.
- **Approval.** Your own account (a wallet, or a passkey Safe through ERC-1271) signs. Any gas payer opens the session
  on the pinned factory. The CLI adopts only the exact matching session, read from the agreed chain.
- **Resume.** `login --resume` and `session resume-wait` continue from the saved state.
- **logout** clears only the local pointer. It never claims a remote revocation.
- **Not available independently:** hosted credit and order history, and a passkey-only first deployment (it needs a
  gas payer or ERC-6492).

**`custody status|set|migrate|pause|resume|clear|claim <id>`** (`cli/custody-independent.mjs`,
`docs/security/custody-independent-cli.md`). Custody v2 only.
- **Reads:** quorum reads through the custody v2 reader.
- **Writes:** the independent writer, with an exact readback.
- **Trust:** the reviewed `secretVaultV2` pin, and the owner's own committee and rules files. An Enclave-seated
  committee needs `--allow-enclave-seat`. `--payer-key` pays gas for the owner's signature. `--owner-read on|off`
  writes the rules' explicit opt-in to owner reads.
- **`migrate --from FILE`.** The `--from` after `custody migrate` is the export file. An external signer's wallet,
  `--from ADDRESS`, goes before `custody`, so one invocation carries both.

**`secrets ls <id> [--show] | set <id> KEY=VALUE… [--file .env] [--replace] | rm <id> KEY… | clear <id> --yes`**
(`docs/security/custody-owner-read.md`). Owner reads go through the committee itself.
- **Protocol.** An EIP-712 `OwnerRead` signature from the policy owner (an EOA, or an ERC-1271 contract owner), one
  ephemeral recipient key per read, DLEQ-checked partials, exactly t combined.
- **Precondition.** The policy's rules must opt in (`custody set --owner-read on`).
- **Edits.** A merging `set` or `rm` writes at the revision it read; a concurrent writer is refused (`StaleRevision`),
  never overwritten. Values print only with `ls --show`; nothing is stored.
- **Refused:** while paused; after a ledger transfer until the new owner claims; and by custodians running an image
  without the owner-read routes (fail closed: "insufficient").

**`host init|build|install|run|check|referral`** (`docs/network/independent-host-onboarding.md`). The plan-driven
onboarding with no relay, tunnel or Enclave control:
- `init` records the `--profile`/`--contract-pins` and `--rpc` quorum of this invocation;
- the supervisor reads the operator key from `operator.key` (0600) and only the plan's RPCs (`BASE_RPCS`). Those
  supervisor reads are still FIRST-ANSWER (viem fallback), not this CLI's quorum; closing that belongs to the measured
  control integration.
`check` is not a readiness proof: the control guest's attestation is reported UNKNOWN until a measured control guest
boots it.

**Refused commands.** None of the hosted commands has a blanket refusal any more. A command that needs a hosted
service names that service in its own error. `work/claude-cli-final-parity-result.md` audits each command against
its hosted counterpart.

`--signer URL --from ADDR` uses an external wallet as the signing authority, never as a chain-state oracle
(`docs/network/independent-signer.md`). The quorum prepares nonce, gas and fees. The wallet signs (Clef
`account_signTransaction`, or `eth_signTransaction`). Every field of the signed bytes and the recovered sender are
checked, and the quorum broadcasts those exact bytes.
- A wallet that can only send is used in `--signer-mode auto|wallet-send`. It gets the prepared transaction once, and
  the hash is accepted only as the quorum sees it mined. That is a weaker guarantee.
- `--signer-mode handoff` prints the exact transaction for a wallet without an endpoint (MetaMask);
  `signer attach` then confirms it.
- An ambiguous outcome stays a journaled intent until `signer resolve` decides it.

### Sessions

Three principals stay distinct:

| Principal | Authorizes | Never used for |
| --- | --- | --- |
| The **owner wallet** | the SessionGrant (EIP-712, for the pinned factory's vault of that owner), USDC deposits and top-ups, `revoke-all`, `delegate` | session-scoped actions |
| The **session key** (P-256, created here, stored 0600 in the session store) | one `SessionCall` per action within its grant's scope, apps, environments, budget, period and expiry; its own termination | anything outside the grant |
| The **gas payer** (any configured wallet key) | nothing: it only submits calldata the owner or the session already signed | authorization of any kind |

- **`session new`.** Builds the grant from the same presets as the hosted flow, with no TEE measurement, so no
  key-attestation service is involved.
  - With the owner's key configured, the owner signs and submits `openFor` once. The session is recorded only after the
    quorum shows it live for that owner.
  - With `--owner ADDR` (or `--unsigned`) and no owner key, the CLI prints the exact SessionGrant typed data and keeps
    the key pending. `session open <pending> --owner-signature SIG` checks that the signature is that owner's over
    exactly this grant before anything is sent; a gas payer submits it, or `--unsigned` prints the call.
  - A budget needs a second owner signature (the USDC deposit), so the external route opens with `--budget 0`. Add
    budget with `session top-up` from the owner's key.
- **Session-signed actions** (`deploy --env`, `fund`, `stop`, `resume`, `rate-cap`, `refund`, `upgrade`, `resize`, and
  `config` on a STAGING record the vault holds). Replicated `publish --storage-plan` and `config --storage-plan` need the wallet. These go through the SDK's `prepareCall`, which reads the
  session's state, lane nonce and chain time through the quorum, never one RPC. The vault enforces scope, budget,
  revocation and replay; the gas payer is printed as paying gas only.
- **`--unsigned` with an active session and no `--from`** prints the session-signed `SessionVault.execute` call for
  any gas payer. `--unsigned --from ADDR` keeps its wallet meaning.
- **Refused before signing:** a session on another chain or another factory than the pinned one, and a revoked, ended
  or expired session. `--wallet` acts with the wallet key instead.
- **Not yet independent:** a session `deploy` waits for nothing (there is no claim hint or readiness check); verify the
  host before sending data.

### Startup targets

`bootstrap prepare|activate --target snp` (the default, unchanged) or `--target shield`. The record's own
`isolation.require` decides: preparing or activating for the other tier refuses, so activation can never silently
rewrite the tier. `deploy --prepare-only --startup-target shield` creates a Shield record.

For Shield (`hyperv-partition-per-app`), the package must carry the AppID the Windows host will derive
(`windows/node/shield-startup.mjs`), and `prepare` derives it with the host's own rule:
- `isolationPlan(...)` over this deployment, its catalog version, the config file, secrets only for a custody package,
  and no protection rules;
- the host manager's declared derivations and capabilities, from `--shield-manager FILE` (its `/health`, as the
  host's operator publishes it);
- the host's partition RuntimeID, `--runtime-id`;
- `derive()` over the catalog component, `--component-file FILE`, which must match the version's CID.

A supplied `--app-id` must equal the derived one. Owner-committed names are SNP-only. The host re-derives everything
and refuses any mismatch.

**configText is the measured bytes.** The package commits exactly what the partition measures as `/app.config`
(`plan.spawn.derive.config`), never the file's spelling: canonical JSON with `_media` removed, `""` when there is no
effective config (`{}`, or only `_media`), and `"{}"` for a secrets-only custody package. A Shield-direct front starts
only when the two are byte-equal, so any other spelling would derive the same AppID, be claimed, and then end the
partition. `prepare` says when it rewrote the file's text and prints `configSha256`, the SHA-256 of the committed
configText.

**Custody.** A custody-v2 Shield package is prepared only when `--shield-manager` states direct custody
(`supports.directBootstrap`, `custodyV2` and `secrets`) and the plan derives `enclave-catalog-bundle/6` or `/7`; this
is the host's own rule. Seal the custody bundle with the printed `configSha256`. `activate` of such a package needs the
same `--shield-manager` statement and refuses before any send without it. Otherwise prepare it `--public`.

### Transactions

In order:
1. The call is simulated at an agreed block and must not revert.
2. Every answering RPC must report the same pending nonce. A disagreement means something from this wallet may be in
   flight, so the CLI refuses.
3. Gas is the highest estimate plus 20%, within a cap. The fee must be under `--max-fee-gwei`.
4. The transaction is signed **once** with the local key.
5. The identical bytes go to every RPC.
6. The receipt must be confirmed by the quorum at an agreed block, and its block hash is re-checked.

**When no RPC confirms accepting it.** The result is **outcome unknown**, reported with the hash and a non-zero exit. It
is never re-signed or resent. Re-broadcasting the same bytes is the only safe repeat.

### Owner management (status, logs, restart, app token, CPU profile, GPU)

**Flags:**
- `--directories IP,…`: 1–8 literal-IP directory origins.
- `--state-dir DIR` (optional): default `~/.config/enclave/independent-management`. It holds the per-runner rollback
  floors.
- `--session SID` (optional): default is the active stored session or `ENCLAVE_SESSION`.

**Checks before the host is contacted** (each refusal sends nothing):
- the session is live on the pinned factory;
- it holds the operation's scope (`api.status`, `api.logs`, `api.restart` or `api.appAccess`);
- the deployment is held by that vault or by the vault's owner.

A wallet-held deployment also needs the owner's ledger `setDelegate` grant to the vault. The host gateway checks that;
the CLI cannot read it, because the deployed 16d ledger keeps it in a private mapping.

**How the host is found.** The CLI uses the management client unchanged:
- a lease from the pinned ledger, read by the same quorum peers;
- the record signed by that lease's `runnerOperator`;
- the TLS key pinned before any byte is written;
- one signature per request.

**Mutations.** `restart` and `cpu-profile start|stop` are sent exactly once. A lost answer exits **4** ("outcome
unknown: check status first").

**App tokens.** An app token opens the private app as its owner. It is written only to a new mode-0600 file and never
printed.

## Attestation

The host management endpoint is the **host**, authenticated by the record its operator signed. Its attestation
document is host-reported data and is never a pass.

`attest --native-profile FILE` runs one HEAD request through `network/native-client.mjs`, which sends nothing until two
things hold:
- a fresh SEV-SNP proof on a signed route verifies against your native trust profile (VCEK chain, TCB floor, expected
  measurement);
- the TLS key matches the attested key.

The trust profile must name this deployment and the same ledger and registry pins. Exit codes:
- 0: verified;
- 1: anything else.

## The deployed registry is schema 4

The live registry `0x868e…` is `EnclaveRegistry` at commit `b17db9a3`, source-verified in
`contracts/deployments/source-verification-base.json`. HEAD's schema-5 source appends `caps` and `region` to the host
struct and adds `registerRelay` and `setCaps`. None of that exists on the deployed contract, and the 13-field struct
does not decode the deployed 11-field one.

The CLI therefore:
- decodes exactly the schema-4 ABI (`REGISTRY_SCHEMA4_ABI`);
- refuses any registry reporting another schema;
- refuses `hosts --relays`, `--caps`, `--cap` and `--region`.

The tests run against the schema-4 registry compiled from the exact historical source
(`test/fixtures/registry-schema4/EnclaveRegistry.sol`). Its runtime hash equals the live registry's.

## Live example (read-only)

```sh
enclave hosts --all --profile contracts/deployments/network-profile-base.json \
  --profile-digest sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8 \
  --rpc https://base-rpc.publicnode.com,https://mainnet.base.org,https://base.drpc.org
```

On 2026-10-19 this listed 11 registered hosts, 2 of them live, at block 52832508, with 3 of 3 RPCs agreeing. It
checked the registry's reviewed code hash first.

## Tests

```sh
node --test --test-concurrency=1 --test-timeout=180000 test/cli-independent.test.mjs           # needs anvil, openssl, the Foundry build
node --test --test-concurrency=1 --test-timeout=180000 test/cli-independent-sessions.test.mjs  # sessions, upgrade, fund --eth, bootstrap/publish, Shield
ENCLAVE_CLI_ENTRY=/path/to/staged/enclave.mjs node --test …                                  # the same suites against a built bundle
```

**What the suite runs on:**
- the real CLI binary;
- real contracts on anvil (chain id 8453), including the schema-4 registry fixture;
- three scriptable RPC proxies;
- a stand-in Enclave API that must receive zero requests;
- a preload (`test/helpers/cli-network-guard.mjs`) that refuses and logs any non-loopback connection;
- the real management directory, signed record, gateway and session vault.

**The test-only transport override.** The signed management record names a public literal address, because production
validation requires one. The preload maps exactly that address to the loopback gateway, using `ENCLAVE_TEST_ROUTE`.
That is the suite's only transport override. Every resource registers its cleanup before the next fallible step, and
every test and CLI process is time-bounded.

## Trust and limits

- **RPC agreement is not a light client.** Colluding RPCs, or origins that front one provider, can agree on a false
  answer.
- **Pinned contracts keep their owners' powers.** See `docs/network/authority-profile.md`.
- **Registry entries and prices are self-declared.** Attestation, not the list, decides whom to trust.
- **Hardware sizes and free capacity are not on chain.** Share floors are not checked here. `availability` shows each
  host's own signed report, not proof of free hardware.
- **Directory origins are operator choices.** A literal IP does not mean an independent operator.
