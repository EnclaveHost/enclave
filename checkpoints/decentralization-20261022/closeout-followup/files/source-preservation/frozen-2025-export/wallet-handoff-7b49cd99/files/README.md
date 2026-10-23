# metal0 host-owner enrollment: loopback MetaMask handoff (SOURCE ONLY, INACTIVE)

This repository holds source and tests only. Nothing here has been served, signed, sent or funded. No live preflight has been run
from this repository yet. Root owns activation: root reviews the code, runs the read-only preflight, and serves one stage.

## What it does

There are two administrator stages for the **one-time host-owner enrollment** of metal0 on the active `EnclaveHostOwnership`
`0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7` (Base 8453; this is not the 0xf5e9 variant). The host is metal0,
`hostId 0x4dde6d1b…68be`. The Enclave administrator `0x0b2d009c0c9af05b12100d77f3c815fea822ee61` signs both stages in
MetaMask.

| stage | transaction (frozen in `stages.mjs` `frozen()`) | when it prepares |
|---|---|---|
| `fund` (optional) | admin → operator `0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab`; value exactly 5000000000000 wei (0.000005 ETH); data `0x`; gas 21000 | No proposal or owner exists yet. The operator has no code. Neither the operator nor the admin has a pending transaction. The operator holds less than 0.000005 ETH and cannot already pay for its proposal. The fixed amount would cover the proposal. The acceptance journal has not started. |
| `accept` | admin → ownership `acceptOwner(hostId)` = `0x0d85eb49…68be` (evidence tx2, byte-identical); value 0 | `authority(hostId)` has owner 0 and pendingOwner **exactly the admin**, at an anchor two blocks below the head. The funding journal is `ready` or `confirmed`. |

The operator's `proposeOwner(hostId, admin)` (evidence tx1) is **not** in this repository. Root sends it separately, after the
optional funding. Until that proposal is two blocks deep, the accept stage answers `NOT READY…` and does not ask MetaMask for
anything.

The scope is narrow:

- This is not recurring app lease gas.
- metal0 is the single Enclave-operated custody seat (one seat, threshold 1). This is a bootstrap, not decentralized custody.
- The custody vault, its committee, shares and policies, and the address book are untouched.
- The book activation (`book-activation-unsigned-20261023.json`) is deliberately EXCLUDED until the hardware lifecycle and
  dashboard checks pass. A test proves that no stage can target the book or the vault.

## Start requirements and commands (for root)

1. Review all the code. `handoff-server.mjs` is the reviewed transport, byte-identical to
   `work/lease-enrollment-signing/handoff-server.mjs` and `work/lease-gas-wallet-signing/handoff-server.mjs` (sha256
   `fb189e4610c8579739fb59fe385b91b461bc5bfb06d95780e94ec92e53d95b75`; a test asserts it).
2. Run the fresh live preflight. It is read-only: no journal write, no browser, no key. It uses two public providers,
   `mainnet.base.org` and `base.public.blockpi.network`:
   `node preflight.mjs`
   It prints the observed state at the agreed anchor, then for each stage either `ready: true` with the exact unsigned
   request, or the reason it refuses. **The registry code hash** (`0x39911d6f…`, taken from
   `work/lease-gas-wallet-signing/trust.mjs`) **is pinned here but is not in the enrollment evidence.** Confirm it on this run.
   Also confirm that both providers answer `eth_estimateGas` with a block tag and `eth_maxPriorityFeePerGas`.
3. Serve ONE stage, explicitly, in the foreground: `node serve.mjs --stage fund --serve`, then later
   `node serve.mjs --stage accept --serve`. Both use 127.0.0.1:39671, so only one can run at a time. The journals are
   `journals/fund.json` and `journals/accept.json` (mode 0600, gitignored). Each stage only reads the other stage's journal.
4. The human opens `http://127.0.0.1:39671/` in the browser that has MetaMask, with the administrator account selected on
   Base, and then:
   1. clicks **Connect MetaMask** (`eth_requestAccounts`);
   2. clicks **Review transaction in MetaMask**. The server re-checks everything on both providers, journals the attempt,
      and only then does the page pass the exact transaction to `eth_sendTransaction`;
   3. confirms in MetaMask without editing gas, fees or nonce.

   The page then checks the pending transaction automatically for about 2 minutes. **Check pending transaction** repeats the
   check on demand. A transaction counts only with two later blocks, canonical on both providers.
5. Stop the server with Ctrl-C after `confirmed`.

The sequence is: (optional) `fund` confirmed → root's operator proposal, two blocks deep → `accept` confirmed.

## State rules (no early, duplicate or lost-response transactions)

- MetaMask is asked only inside the Connect, Review and Check click handlers. A test checks this statically and in the
  browser. Nothing signs automatically.
- Transport rules (unchanged):
  - The journal is written as `awaiting-wallet` before the transaction reaches the browser.
  - There is one attempt per journal.
  - Only the page's own explicit wallet 4001 resets an unsent attempt.
  - A recorded hash is never replaced.
  - Origin, Host, token, CSP, `no-store` and the 2 KiB body limit are enforced.
- A hash is recorded only when at least one provider already returns that transaction, and every provider that returns it
  shows exactly the request's sender, target, calldata, value, nonce, chain, type and gas, with fee caps no higher than the
  request's. The other stage's hash is refused. A mistyped or altered hash therefore cannot lock the journal.
- A journal left in `preparing` (process stopped mid-preparation) is reset to `ready` at startup. Nothing reaches the browser
  before `awaiting-wallet` is on disk. Every other state is kept.
- Chain-state guards hold even if a journal is lost:
  - `fund` refuses while any admin or operator transaction is pending or was mined in the last two blocks (pending nonce ≠
    anchor nonce).
  - `fund` refuses once the operator holds 0.000005 ETH, and once any proposal or owner exists.
  - `accept` refuses once the admin owns metal0.
- Verification is exact:
  - The receipt must be two blocks deep, canonical, and the same on both providers.
  - Sender, destination, calldata, value, nonce, gas, type and chain must match. MetaMask must not have raised either fee
    cap. Receipt status must be 1.
  - `fund`: no logs; the operator still has no code; the operator's nonce is unchanged in that block; its balance rose by
    exactly 5000000000000 wei in that block.
  - `accept`: exactly one `OwnerAccepted(hostId, admin, 1)` from the ownership contract. After it, `authority` is owner =
    admin, pendingOwner 0, revision 1 and policyHash 0. The owner is still the admin at the anchor, and the ownership code
    hash is unchanged.
  - The journaled request must still name the frozen target, calldata and value.
- Bounds:
  - Each RPC request times out after 10 s, with at most one retry.
  - A whole preparation, verification or hash lookup times out after 60 s.
  - The fee cap is 0.1 gwei maxFeePerGas. Gas limits: transfer exactly 21000; accept ≤ 120000; the operator's proposal
    estimate ≤ 150000.
  - The RPC layer refuses every method outside a read allowlist, and only https endpoints without credentials.

## Tests (fake chain; no live access)

- `test/stages.test.mjs` (11 tests, 256 MiB lane). These run against an in-memory Base model that follows
  `EnclaveHostOwnership.sol`'s rules, served as two JSON-RPC providers on 127.0.0.1 and 127.0.0.2. They cover:
  - evidence equality;
  - the transport hash;
  - the RPC read-only, https and two-host rules;
  - fund and accept preparation;
  - 14 fund refusal states;
  - provider disagreement, wrong chain and a hanging provider (bounded);
  - accept NOT READY at 0 and 1 later blocks, the wrong proposer, and an unresolved funding journal;
  - full transport runs for both stages;
  - restart, lost-journal and lost-response cases;
  - verification negatives (re-gassed, fee raised, reverted, wrong nonce, non-canonical, tampered journal);
  - the preflight and the serve usage refusal.
- `test/browser.test.mjs` (3 tests, 512 MiB lane). Headless Chromium (playwright-core from `~/Projects/enclave`, single
  process) runs the real page against the real server and fake chain, with a fake EIP-6963 MetaMask. It checks:
  - no wallet request before clicks;
  - MetaMask receives exactly the journaled transaction;
  - pending → confirmed;
  - accept NOT READY never calls `eth_sendTransaction`;
  - a 4001 reset;
  - the lost-response reload path (Review disabled, wrong hash refused, real hash confirmed, nothing re-sent);
  - no CSP refusals or page errors.
- Run both through the shared queue only:
  `./q.sh 256 stages-N ./run-tests.sh stages` and `./q.sh 512 browser-N ./run-tests.sh browser` (logs in `logs/`).

## Security limitations (read before serving)

- **Providers:** two public RPC providers are agreement checks, not a light client. If both are wrong in the same way, the
  checks pass.
- **Local access:** any local process can reach the loopback port and read the page token (the same as the reviewed
  transport). Such a process can trigger a preparation or report a hash, but it cannot sign. MetaMask confirmation by the
  human is always required.
- **Lost hash after a reload:** if the wallet's response is lost and the page reloads, the human pastes the hash from
  MetaMask's activity tab. There is no nonce-to-hash recovery (no indexer).
- **Rejection after a restart:** if the attempt really was rejected but the page was closed first, the journal stays
  `awaiting-wallet`. Root must inspect the admin nonce and then reset the journal by hand.
- **Wallet edits:** MetaMask lets the human edit gas, fees or nonce, and may choose its own nonce if it holds a local pending
  transaction. Verification then refuses, the journal stays `submitted`, and root must resolve it manually.
- **Request expiry:** a prepared request records `expiresAt` (2 min) but the open MetaMask prompt is not expired by the
  page. The fee caps bound the cost.
- **Funding duplicate guard:** the guard is state-based: no proposal or owner exists, and the operator holds less than
  0.000005 ETH. If a proposal were later cancelled and the operator's ETH spent, `fund` could prepare again. That requires
  another explicit click plus MetaMask confirmation.
- **Registry code hash:** this pin comes from the lease-gas trust file, not from this evidence. Root's preflight must
  confirm it.
- **Test coverage:** the tests use a fake chain and a fake MetaMask provider. The real extension, the real providers and
  real Base were not exercised.
