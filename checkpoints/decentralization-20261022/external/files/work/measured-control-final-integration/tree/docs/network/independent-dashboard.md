# Independent dashboard mode

The dashboard can run from an explicit network profile instead of Enclave's API,
upload-token service and mutable address book. With an active profile, the browser
reads and writes the chain through the profile's RPCs, uploads to the profile's
storage adapters with a wallet signature for each, and pins every contract it signs
against. It does not contact `api.enclave.host`, `ipfs.enclave.host` or the address
book, and a refused or failed read is never replaced by a call to them.

This is a client mode. It does not make any operator independent. The contracts it
pins keep their own governance, and the RPCs, adapters and directories it uses are
only as independent as their actual operators.

## Profile format

A profile is one JSON document (at most 32 KiB, no duplicate keys):

```json
{
  "format": "enclave-browser-profile",
  "version": 1,
  "name": "my network",
  "chainId": 8453,
  "rpcs": ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"],
  "quorum": 2,
  "confirmations": 2,
  "maxBlockAgeSeconds": 600,
  "contractPins": {
    "version": 1, "chainId": 8453,
    "contracts": {
      "registry": "0x…", "deployments": "0x…", "appCatalog": "0x…", "proofOfTime": "0x…",
      "enclavePay": "0x0000000000000000000000000000000000000000",
      "verificationFees": "0x0000000000000000000000000000000000000000",
      "sessionVaultFactory": "0x…",
      "secretVaultV2": "0x0000000000000000000000000000000000000000"
    }
  },
  "usdc": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "storage": {
    "version": 1, "minimumCopies": 2,
    "replicas": [
      {"upload": "https://storage-a.example/add-json", "audience": "0x<adapter deployment id>", "gateway": "https://storage-a.example/ipfs"},
      {"upload": "https://storage-b.example/add-json", "audience": "0x<adapter deployment id>", "gateway": "https://storage-b.example/ipfs"}
    ]
  },
  "directories": ["https://directory-a.example"]
}
```

| Field | Rule |
| --- | --- |
| `chainId` | 8453 (Base). |
| `rpcs` | 2–8 distinct origins. HTTPS, or plain HTTP on `localhost`, `127.0.0.1` or `[::1]` only. No credentials, query or fragment. |
| `quorum` | 2 up to the number of RPCs (default 2): how many origins must agree. |
| `confirmations` | 0–64 (default 2). |
| `maxBlockAgeSeconds` | 30–86400 (default 600): an agreed block older than this is refused. |
| `contractPins` | Exactly the CLI's `--contract-pins` document (`network/contract-pins.mjs`). Zero optional pins disable that feature; a zero `sessionVaultFactory` turns wallet sessions off. |
| `usdc` | The payment token. Its EIP-712 name and version are read from the chain at an agreed block. |
| `storage` | Exactly the CLI/host storage plan (`--storage-plan`, `GUEST_BOOTSTRAP_STORAGE_PLAN_FILE`): 2–8 adapters with distinct hostnames and deployment audiences, `/add-json` upload and `/ipfs` readback on the same HTTPS origin, and at least 2 required copies. Optional; without it, uploads are off. |
| `directories` | Optional, up to 8 bare `http(s)` origins of public network directories. A page served over HTTPS can only reach HTTPS directories. |
| `ethUsdFeed` | Optional. The ETH/USD feed a reviewer recorded for the ledger. When set, ETH funding refuses any other feed the ledger reports. |
| `source` | Optional provenance: `authorityProfileDigest` (`sha256:<64 hex>`) and `reviewBlock` of the reviewed authority profile the browser profile was derived from. |

**From a reviewed authority profile.** `scripts/network/browser-profile.mjs` converts a reviewed
`enclave.authority-profile` (for example `contracts/deployments/network-profile-base.json`):

```sh
node scripts/network/browser-profile.mjs --authority contracts/deployments/network-profile-base.json \
  --expect-digest sha256:<digest obtained out of band> --expect-pins <contract pins obtained out of band> \
  --rpc https://rpc-a.example --rpc https://rpc-b.example --rpc https://rpc-c.example \
  [--storage-plan storage.json] [--directory https://directory-a.example] [--verify-chain] --out browser-profile.json
```

- The authority profile must hash to `--expect-digest` and be canonically encoded.
  Its eight contract pins must equal `--expect-pins` exactly. Nothing is discovered
  from the address book or from live observations.
- `usdc` and `ethUsdFeed` come from the reviewed file. `source` records its digest
  and review block.
- RPCs and directories must be HTTPS. The storage plan is validated as the dashboard
  validates it.
- `--verify-chain` additionally checks every reviewed fact against agreeing RPCs.
- The command refuses to overwrite and prints the output's SHA-256 fingerprint for the
  publisher to announce.

Ledger, catalog and registry addresses must be the live ones. The site's built-in
fallback addresses are not a substitute.

## Turning it on

On the dashboard, open **Use your own network profile**, paste or choose the file,
and select **Check**. The check makes no writes. It confirms that:
- the RPCs agree on a recent block;
- every pinned contract and the payment token have code at that block;
- the ledger and registry report their schemas.

It also computes the profile's SHA-256 fingerprint. **Use this profile** stays
disabled until the user enters the full fingerprint the profile's publisher announced
and it matches exactly.

A saved profile decides which contracts the wallet signs for, and `localStorage`
outlives whatever wrote it. Each new tab therefore asks the user to confirm the saved
profile, by typing at least the first 16 characters of the publisher's fingerprint,
before it pins anything. Until then, no contract or RPC is configured and
nothing can be signed.

An invalid saved profile is reported and pins nothing. It never falls back to the
hosted defaults. **Stop using this profile** removes it.

A site operator can ship a mirror that starts in this mode by building it with
`BUILT_IN_PROFILE_TEXT` in `site/js/core/independent.js` set to the profile's exact
text. That profile is part of the served code, so it needs no per-tab confirmation.

## What works

- **Publish** (store → publish).
  1. The component's CID is computed locally (same importer as the CLI).
  2. The wallet signs once per adapter, bound to that adapter's deployment, route,
     SHA-256, size and expiry.
  3. Each adapter's answer must be the local CID.
  4. Every byte is read back from that adapter's gateway.
  5. The upload succeeds only with `minimumCopies` verified copies. Images and large
     configs work the same way. The catalog transaction is the wallet's own, as
     before.
- **Deploy and fund.**
  - **Per-host quotes.** For the shares being bought, each registered host gets its
    own total: its posted GPU price × GPU share plus its posted CPU price × CPU share,
    rounded up as `create()` rounds. One host's CPU price is never combined with another
    host's GPU price. Prices are read from the pinned registry at an agreed block, and
    any registered host counts, not only hosts an API follows.
    - A host can quote only if it sent a heartbeat within the last hour and, for a
      GPU request, posts a GPU price.
    - A host whose payout wallet is the owner's is marked free for the owner (ledger
      rev 12+). It never sets the suggested ceiling.
  - **The spend ceiling is the owner's choice.** The deploy dialog shows the eligible
    hosts with their totals, an optional host choice and a ceiling in $/hr.
    - Suggested ceiling: the chosen host's total, otherwise the cheapest charging
      host's total. Once the owner types a ceiling, it is never overwritten.
    - Choosing a host priced above the ceiling is flagged in the dialog and refused
      before any signature.
    - Nothing raises a ceiling automatically, at deploy or later.
  - **A posted price is not reserved capacity.** A host may be full or may decline.
    If no host claims the deployment, its **Host & price** tab offers the retry, with
    no API involved:
    - every host's total for that record's shares, and whether it is within the
      current ceiling (`capOf`, read at an agreed block);
    - a new ceiling (`setMaxRate`) and/or a host pin (`setConfig` with the placement
      pin), each one owner transaction. Session-vault rows go through the vault.
    - The record is re-read before saving. A host above the new ceiling is refused.
  - Funding signs an EIP-3009 authorization against the profile's token.
  - No claim hint is sent: hosts claim funded work from the ledger themselves.
  - ETH funding uses the ledger's own ETH/USD feed. At one agreed block the dashboard
    reads `ethUsdFeed()`, then that feed's `decimals()` and `latestRoundData()`. It
    refuses before any value is sent if:
    - the feed is zero (ETH funding is disabled);
    - the feed differs from the profile's reviewed feed;
    - the feed does not report 8 decimals (the deployed ledger credits
      `wei × answer / 1e20`);
    - the answer is not positive;
    - the round is unfinished;
    - the answer is within ten minutes of the ledger's two-hour staleness limit.

    The amount keeps the existing 9-decimal rounding, and the ledger credits at its own
    read when the transaction lands.
  - **Host choice.** Choosing a host writes a strict placement pin
    (`placement.hostId`) into the record. Unless the owner sets one, the ceiling is that
    host's own total.
    - Posted prices and heartbeats are chain facts. Free capacity is not: a chosen host
      that is full leaves the deployment queued.
    - The pin is honored by hosts that follow placement pins; the ledger does not
      enforce it.
- **Listing and status** (`site/js/core/independent-list.js`). There is no indexer.
  - The ledger keeps every record ID in an append-only array. A record's owner changes
    only at create/import or through `transferDeployment`, which emits
    `DeploymentTransferred`. Both the deployed rev 16d and HEAD behave this way.
  - Each refresh is one bounded step at a fresh agreed block:
    1. Apply every `DeploymentTransferred` event since the block the tab's index was
       last synchronized to. Logs are read in 2,000-block ranges, and `quorum` RPCs
       must return the identical set.
    2. Read up to 40 more `getPage()` pages of 100 records, within 8 s.
    3. Re-read every candidate with `get(id)` at that block. Candidates are index
       entries owned by the wallet or its session vault, plus IDs the user added.
       Rows come only from these re-reads.
  - The index is per tab (sessionStorage). It only nominates candidates, so a planted
    entry cannot add a row.
  - **Incomplete is labeled.** Until every record is covered, the list says "Partial
    list: checked X of Y" and keeps reading every 1.5 s. A partial scan with nothing
    found yet says so instead of showing an empty state.
  - If the RPCs cannot serve event history, or too many blocks have passed, the index
    starts over: a full re-read with a larger budget (200 pages, 30 s), labeled with
    the reason. It counts as complete only when one step covers every record.
  - **Add by id** looks up any deployment by its full ID. One owned by someone else is
    named as such and is never listed as the wallet's.
  - A failed or disagreeing read shows as a failed read, never as an empty list.
  - A live lease reads **claimed**. Whether the app answers is a host fact, not a
    ledger fact.
- **Row actions on the ledger:** Top up, Version, Resources, Config, Protect, rate
  ceiling, Suspend/Resume, Cancel and Transfer.
- **Startup tab**, the CLI's `bootstrap prepare / publish / activate`:
  - The package is byte-identical to `sdk/bootstrap/package.mjs` and the activation
    envelope is identical to the CLI's.
  - The package is published to the storage plan and read back.
  - The record is re-read at an agreed block, then committed with the owner's own
    `setConfig`.
  - The deploy dialog can also create a record whose startup is disabled until that
    commit, like the CLI's `deploy --chain-only --prepare-only`.
  - App ID and Runtime ID come from the host's direct runtime. A custody-v2 pointer
    can be supplied; plaintext secrets never can.
  - **Custom names: create, edit and delete.** The browser check is the SDK's and the
    measured guest's (`test/site-independent-names.test.mjs` runs it over the shared
    Go/JS vectors in `isolation/m2/bootstrap/testdata/names-vectors.json`). There is no
    default CA, responder or zone: a CA selection needs all three fields, typed by the
    owner. A selection that points at `enclave.host` is accepted by the schema but named
    in the preview as Enclave-run, which is not independence. The form starts from the committed
    package's `names` (the naming worker's schema, `docs/network/independent-names.md`).
    - The owner edits the names (1–10, not under `enclave.host`), plus an optional CA
      selection: CA directory, challenge responder and zone, and optional EAB secret
      names (custody-v2 only).
    - The member is built as the CLI builds it from `--names`/`--acme-*`: deduplicated,
      sorted, with the CLI's key order. It is validated exactly as the guest and CLI
      validate it, so the package is byte-identical to `preparePackage` of the same
      manifest. Deleting every name drops the member entirely.
    - A live preview lists the names being added and removed. With a CA selection, it
      shows the owner-bound DNS records to publish:
      `_acme-challenge.<name>.  CNAME  _acme-challenge.<label>.<zone>.`, where the label
      commits to the deployment and its current owner, so a transfer needs new records.
      A listed name is the owner's claim, not proof.
    - Every change is an owner commit: publish to the storage plan, re-read, then
      `setConfig`. If the committed settings cannot be read back from storage,
      replacing them needs an explicit confirmation.
- **Network tab.**
  - The owner's setting is signed by the wallet and posted to every profile
    directory, which checks the signature and nonce itself.
  - The nonce is above every nonce a directory reports, and at least the issue time.
  - Bring-your-own WireGuard is not offered, because it needs a private config
    transport. Paid-provider authorization is not offered, because the profile pins
    no connectivity contract.
- **Wallet sessions.**
  - Sessions are opened on the pinned `SessionVaultFactory` with the SDK's
    `prepareSessionOpen`. The vault address is checked against an agreed read before
    submission.
  - Session actions use `prepareCall`; the session ends with `prepareTermination`.
  - The connected wallet submits each prepared call and pays its gas; the vault
    enforces scope, budget, expiry and revocation.
  - **Owner operations** (`prepareOwnerOperation`, `prepareTopUpFromWallet` in
    `sdk/sessions`) exactly as `SessionVault` defines them:
    - extend, terminate, end all (`revokeAll`), withdraw, promote, adopt, environment
      and release are vault calls the owner's wallet sends itself. `_ownerAuth`
      authorizes `msg.sender == owner` in the executing block.
    - The SDK can also produce an owner-signed form that any gas payer submits once,
      before `signBefore`.
    - Adding budget is one USDC authorization whose nonce is the vault's TopUp digest,
      submitted as `topUpWithAuthorization`.
    - A version or config change on a production record the vault holds becomes the
      owner's Promote. The label is read from the catalog, and the vault checks it
      (`LabelMismatch`).
  - The dashboard shows the session with **Add budget**, **Extend**, **End session**
    and **End all sessions**.
  - **Passkey account** (`site/js/core/passkey-account.js`, `account-ui.js`;
    `work/passkey-aa-interface.txt`). It is a Safe v1.4.1 that the owner's passkeys and
    recovery keys own, using only pinned, already-deployed code: Safe passkey signers
    v0.2.1 and Safe4337Module v0.3.0 with EntryPoint v0.7.
    - **Creation.** The owner creates a passkey on this dashboard's RP, or imports one
      made on another dashboard's RP, adds recovery keys, and picks the threshold and
      salt. The address is computed from agreed reads, and the profile is saved only on
      an explicit click.
    - **Deploy.** Any gas payer sends the calls, and the payer gains no power over the
      account: the connected wallet, or anyone given the calldata.
    - **Sign in.** It opens a session the Safe owns. The passkeys sign the SessionGrant,
      and for a budget the USDC authorization, as Safe-format ERC-1271 signatures. The
      vault and USDC accept them in an agreed simulation before anything is sent.
    - **Recovery.** Owners and threshold are managed by the account's own owners.
    - **Optional ERC-4337 transport.** The owner's own bundlers and paymaster only; never
      a default, never Enclave-only.
    - **Capability text.** It states plainly:
      - one key is no recovery;
      - "any single owner controls" at threshold 1;
      - "every passkey is under one RP" when that is true.
    - **The account as the dashboard identity** (`site/js/core/identity.js`;
      `work/passkey-dashboard-interface.txt`). Only on an explicit click, "Use this
      account as my dashboard identity". It is verified at ONE agreed block:
      - every passkey signer re-derived by the pinned factory;
      - the Safe deployed on the pinned singleton, with exactly the description's owners
        and threshold;
      - no module but the pinned 4337 module, no guard, and a pinned fallback handler.

      The selection is stored and re-verified on every page load. Until it verifies it is
      "pending"; when it fails it is "refused", with the reason. Neither state lists rows
      or sends anything, and neither falls back to the wallet. A bar above the list says
      "Acting as passkey account … · gas paid by …", and the payer is never shown as the
      owner. "Use my connected wallet" switches back.

      Under the account identity the account owns and pays, and the connected wallet only
      sends transactions and pays gas:
      - **Listing.** The Safe's rows and its session vault's.
      - **Sessions.** One session pointer per identity, so a session serves only the
        owner it was opened for. **Start a session** (session controls) or **Sign in**
        (account panel) has the passkeys approve the grant and, for a budget, the USDC.
        Add budget, Extend and End all sessions are the account's own signed operations.
      - **Create** (the Apps deploy dialog and the dashboard's deploy flow):
        - with a live account session, a fee-free app funded in USDC is created by the
          session: the account's vault holds it as staging, and the budget funds it;
        - otherwise the Safe creates it itself, with one passkey approval: a paid app, a
          record waiting for startup settings you commit, ETH funding, or no session.
          The Safe holds the record and funds it from its own USDC or ETH.
      - **Funding** (Top up, deploy funding) always comes from the account: a vault-held
        record from the session budget; a Safe-held record from the Safe's USDC (an
        authorization the Safe signs) or its ETH. The wallet's money is never used.
      - **Row actions.**
        - Vault-held rows: through the session. Their **Environment** tab adopts, moves
          between staging and production, or releases to the account; on production a
          version change is the account's own approval (Promote).
        - Safe-held rows: a Safe transaction the passkeys approve. It is simulated at an
          agreed block, then sent by the wallet as gas payer only.
        - A ledger call is never sent as the wallet.
      - **Manage** signs with the account's session. A record the Safe holds itself needs
        the Safe to let its vault act for it on the ledger (one passkey approval, offered
        in the Manage panel). Only a ledger with `setDelegate` supports that: the deployed
        Base ledger rev 16d does, the repository's ledger source does not.
      - **Unchanged.** The wallet identity and the hosted mode are unchanged.
    - **Account-first: no wallet at all** (`site/js/core/account-transport.js`).
      - **The built-in passkey.** The account's first passkey can be its built-in signer,
        Safe's pinned shared signer. `Safe.setup` writes the key into the account's own
        storage through the pinned MultiSend in the same initializer that enables the 4337
        module. The initializer is part of the CREATE2 salt, so whoever deploys that
        address deploys exactly that key and module. One built-in passkey per account;
        further passkeys (other RPs) and recovery keys are their own owners as before.
      - **Gas, chosen explicitly.** In the account panel's **Gas** setting, either your
        connected wallet pays, or the account pays its own gas through the bundler you name
        in **Gas transport**. With a transport named, nothing is sent until you choose.
      - **Funding the gas.** Gas is not free: either the account's own ETH (send it to the
        account's address first, even before it exists), or a paymaster you name
        (ERC-7677). Only the named paymaster is accepted, and its EntryPoint deposit must
        cover the operation.
      - **Every action is one user operation.** The account then creates itself, opens
        sessions, deploys, funds and acts on its records this way, one passkey approval
        each:
        - the exact call is simulated from the account, and the account's own call is
          measured, so a bundler's low gas estimate cannot make it fail;
        - the signed operation is simulated through the EntryPoint at an agreed block;
        - the outcome is the EntryPoint's own event for that operation, not the bundler's
          word.
      - **Unknown outcomes.** An operation whose outcome is unknown stays pending. Nothing
        is resent, and nothing new is signed until **Check the pending operation**
        settles it.
    - **Also under the account identity:**
      - a record its session vault holds can be funded in ETH: the account pays the
        ledger's `fundEth` itself;
      - the **Startup** tab works on records the account holds. Your connected wallet signs
        the storage uploads as uploader only, and the account commits the settings;
      - `/grant` acts for the account. **Sign only** hands a signature for the account
        (ERC-1271) to the command that asked. **Approve and open** is sent by the wallet
        or by the account's own bundler.
    - **Not yet:**
      - **Startup settings with no wallet at all.** The storage adapters authorize uploads
        by an EIP-191 signature only, which a passkey account cannot make. The adapters
        would need to accept ERC-1271 upload signatures.
      - **Managing records the account holds itself, on a ledger without `setDelegate`.**
        The repository's ledger source lacks `setDelegate`; the deployed rev-16d ledger has
        it.
      - **Real bundlers.** Account-first was exercised with a local test bundler that
        submits to the real EntryPoint, not with a production bundler's ERC-7562
        validation rules.
  - **Contract-account owners** (`site/js/core/owner-signature.js`).
    - The owner may be a contract account: a Safe with its own M-of-N signers and
      recovery, an EIP-7702 account, or a passkey smart account.
    - The pinned SessionVault accepts its ERC-1271 signatures; USDC's EIP-3009 deposit
      does too.
    - Before sign-in submits, and before `/grant` submits or hands a signature to the
      CLI, the exact factory call is simulated at a block the profile's RPCs agree on.
      The vault's own ECDSA/ERC-1271 check decides, and nothing is re-implemented in
      the page.
    - An ERC-6492 (undeployed-account) signature is refused with "deploy the account
      first".
    - Account creation, an owner-chosen bundler and paymaster, and recovery are planned
      in `work/passkey-independence-interface.txt`.
  - **A session the CLI asked for** (`enclave --independent session new --owner
    <wallet>`). The CLI holds the session key and prints the exact EIP-712
    SessionGrant. Paste it into `/grant`, or open a request link there.
    - The page rebuilds the grant from the SDK's own `SessionGrant` type. It refuses an
      extra or missing field, another chain, another domain or type list, or a
      different vault than this wallet's on the pinned factory (an agreed read).
    - It shows the grant in plain language and the check code.
    - **Approve and open:** the wallet signs and submits `openFor` itself (with the USDC
      authorization for a budget). Then `enclave --independent session open
      <pending-id>` records the session, which is already live.
    - **Sign only** (no budget): the signature goes back to `session open <pending-id>
      --owner-signature 0x…`, which verifies it and submits.
- **Manage tab** (`site/js/core/independent-management.js`): host management through the
  browser transport a host operator may publish (`docs/network/independent-management.md`).
  - **Operations:** status, a log tail, the host's attestation document, restart, the
    private-app token, CPU profiles (read and download a capture, start for 1–60 s,
    stop) and GPU state.
    - GPU state is the supervisor's own GPU view: MPS, SM split, tenants and VRAM, or
      per card on Enclave Shield hosts.
    - It is labelled host-reported: not attestation and not a capacity reservation. A
      Shield card's proof fields are listed as the host's own, unverified claims.
    - A CPU-only host reads "no GPU". `api.js` `logs`/`attestation`/`restartDeployment`/`appToken` route here
    too.
  - **Before every action, the page:**
    1. reads the lease (ledger row plus the runner's registry entry) at one agreed
       block;
    2. requires the current owner to be this wallet or its session vault;
    3. reads every directory's copy of the runner's management record and keeps only
       one signed by the CURRENT runner operator;
    4. enforces the persistent per-operator rollback floor (localStorage, the native
       client's key; it only moves forward);
    5. requires this page's exact origin among the record's dashboards;
    6. then sends ONE request, signed by this browser's non-extractable WebCrypto
       session key, to the origin inside the operator's signature.
  - **No automatic retry:**
    - a restart or profile control whose answer is lost is shown as "outcome unknown:
      check status", and further mutations stay disabled until status is checked;
    - a gateway refusal before forwarding (busy, rate limited, replay capacity) says
      "try again shortly".
  - **Labels:**
    - the transport reads **browser WebPKI**: the browser checked the certificate of
      the operator-signed origin, did not check the host's TLS key (SPKI), and depends
      on DNS and a public CA;
    - status and attestation answers read **host-reported, not verified**, and the
      native client's `enclave attest --native-profile` is named as the verified path.
  - **Native fallback:** with no record, no browser transport, an unlisted dashboard, or
    a DNS or certificate failure, the panel shows the exact `enclave --independent …`
    command. The native client pins the SPKI over a literal IP.
  - **The app token** is kept in page memory only, offered as copy or save, and never
    painted, logged or stored.
  - **A deployment the wallet holds** (not its vault) needs the owner's ledger
    delegation to the session vault. The panel shows that state and offers it as one
    explicit wallet transaction.

## What is off, and why

These features depend on Enclave's hosted service and are hidden or refused in this
mode:
- card and credit payments, and account (passkey) sign-in;
- the hosted service's live log stream, its restarts and the in-browser Verify (the Manage
  tab does these through the host's own management gateway instead, with host-reported
  answers);
- private environment variables held by the relay;
- relay-held custom domains (owner-committed names are edited in the Startup tab
  instead), and the hosted service's preferred-host-with-fallback placement;
- the live route view and actual free host capacity. Posted prices are chain facts,
  free capacity is not;
- host management for a host that publishes no browser transport, or that does not list
  this dashboard's origin: the Manage tab shows the native command instead;
- phone app downloads;
- WalletConnect, whose transport is a third-party relay. Injected wallets work.

The **Connect** tab on each record builds a starting trust profile for the
attestation-pinned native client from the network profile's pins. It names the
decisions that are still the user's: provider checker keys, the SNP firmware floor,
the reviewed runtime release and the state directory. It also shows the
`native-profile.mjs` and `native-get.mjs` commands.

Apps' `*.app.enclave.host` names still depend on Enclave's DNS zone. For access that
uses neither Enclave DNS nor its CA, use the attestation-pinned native client
(`docs/network/native-client.md`) with the full deployment ID.

## Startup isolation tier

The Startup tab commits to `snp-guest-per-app` by default, exactly as the CLI's
`bootstrap activate` does: the app's own SEV-SNP guest re-reads the commitment on chain.

**Enclave Shield partition** (`hyperv-partition-per-app`, `windows/node/shield-startup.mjs`)
is an explicit, weaker choice. In that tier:
- the host node, not the partition, re-reads the commitment at an agreed block;
- the evidence is the host's TPM-quoted boot and the partition's VSM report, not SEV-SNP;
- custody-v2 secrets are never released to it, so the page refuses a custody pointer
  with it.

The package bytes are the same for both tiers; only the record's isolation requirement
differs. The CLI's `bootstrap activate` does not offer this choice yet (CLI worker
follow-up).

## Trust and limits

- **RPC agreement is not a light client.** Colluding RPCs, or origins that all front
  one provider, can agree on a false answer. Writes go to the pinned contracts, which
  enforce their own rules.
- **Wallet providers.** Ordinary display reads use the profile's RPCs in rotation.
  The wallet's own provider still estimates gas and broadcasts transactions. Balance
  reads the wallet cannot answer use only the profile's RPCs, and the chain the wallet
  is asked to add names only those RPCs.
- **Deployed code, not source.** Before relying on a method, the dashboard checks that
  the agreed runtime contains that method's selector. For example, the deployed
  registry is schema 4 and has no `registerRelay`/`setCaps`; the dashboard reads only
  schema-4 fields from it.
- **Storage.** A verified copy proves availability now, not future retention.
  Distinct hostnames and audiences are not proof of distinct operators.
- **Management bundle.** `site/vendor/management.js` is built from the committed
  management sources by `scripts/build-management-vendor.mjs`. Its manifest records each
  source's sha256 and last commit, and the build refuses uncommitted sources. It is a
  prepared site artifact, not activated in production.
- **Event history.** Following transfers relies on `eth_getLogs` agreement. RPCs that
  refuse log ranges send the listing back to full re-reads, so a very large ledger may
  stay labeled partial.
- **Config edits.** Config edits cannot be checked against host capabilities without
  asking the hosts. A host that does not take an edit declines the claim under its own
  policy.
- **Pinned contracts keep their governance.** For example, the catalog owner can
  still transfer an app lineage until the catalog is sealed.

## Tests

```sh
node --test test/site-independent-profile.test.mjs test/site-independent-quorum.test.mjs test/site-independent-review.test.mjs \
  test/site-independent-storage.test.mjs test/site-independent-network.test.mjs test/site-independent-bundle.test.mjs \
  test/browser-profile.test.mjs
node --test test/sessions-owner-ops.test.mjs          # anvil + forge: owner operations on the real pinned vault
node --test test/site-independent-management-unit.test.mjs   # the Manage module on the source AND the shipped bundle
node --test test/site-independent-browser.test.mjs   # anvil, openssl and Playwright's Chromium (cd e2e && npm ci)
node --test test/site-independent-identity.test.mjs  # the dashboard-identity rules (selection, re-verification, refusal)
node --test test/site-independent-account-sessions.test.mjs  # a session serves only its own account; refusals never reach the wallet
node --test test/site-independent-account-transport.test.mjs  # account-first: explicit gas choice, prefund, simulation, paymaster, pending/unknown
# account-first in Chromium with NO wallet (virtual authenticator, Base fork, the real EntryPoint, a local test bundler and test paymaster):
node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --max-old-space-size=256 test/site-independent-account-first.test.mjs
# the Startup tab on a record a passkey account holds (local rig with storage adapters, pinned Safe code copied from Base):
node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --max-old-space-size=256 test/site-independent-account-startup.test.mjs
# the passkey account panel and the account as the dashboard identity (owner operations, funding, the Apps deploy dialog),
# in Chromium with a virtual authenticator, against an anvil fork of Base (read-only upstream; ~1.1 GiB for the whole tree):
node test/helpers/memory-guard.mjs --max-rss-mib 1408 --floor-available-mib 16384 -- node --max-old-space-size=256 test/site-independent-passkey-ui.test.mjs
node --test test/site-independent-management.test.mjs   # + NSS certutil: the real gateway, WebPKI test CA, Chromium
ENCLAVE_LIVE_READS=1 node --test test/site-independent-live-reads.test.mjs   # read-only, public Base RPCs
```

The browser test runs the unbundled site in Chromium against:
- anvil with the Foundry-built ledger (schema 16), registry, catalog and pinned
  session factory;
- three RPC proxies;
- three HTTPS storage adapters that verify the wallet signature as the real adapter
  does;
- a real public directory.

Every `*.enclave.host` request and the upload-token path are refused. The test
covers:
1. Profile import, checking and per-tab confirmation.
2. Publishing through the real form with one adapter refusing.
3. Deploying and funding at the registry price, an independent host claiming the
   deployment, and the list showing it.
4. One lying RPC outvoted, and a split refusing.
5. Startup settings committed, and a prepare-only record.
6. A network setting published to the directory.
7. A wallet session opened, used and ended.
8. Owner operations from the dashboard: start, add budget, extend, move to
   production and Promote, end all sessions.
9. ETH funding at the ledger's feed, and refusal of a stale feed.
10. Host choice with that host's price ceiling. A pinned host above an explicit
    ceiling is refused with nothing sent.
11. A refusing cheapest host. The ceiling stays put and the dearer host cannot claim.
    The owner then sets a ceiling and pin in Host & price, and the dearer host claims at
    its own total.
12. The deploy dialog's per-host totals, the owner's ceiling (never overwritten) and
    the chosen host and ceiling on the record.
13. Resumable listing over more than one page: partial labeling, continuation,
    transfers in and out applied from events, and add by id.
14. Custom names added (with the CNAME alias shown), edited and deleted. Each package
    is byte-equal to `preparePackage`, and the blind-replace guard is checked.
15. The Connect starter profile.

The ledger in the rig is HEAD's schema-16 source, which differs from the deployed
rev 16d. The read-only live test therefore checks, against the deployed Base runtimes:
- every selector the dashboard sends;
- the reads it relies on (schema-4 registry, rev-16d ledger, the reviewed feed, USDC's
  domain, the pinned factory);
- precise refusal of methods the deployed registry lacks.

After activation the browser contacts only the local rig. These are local tests, not
production activation.
