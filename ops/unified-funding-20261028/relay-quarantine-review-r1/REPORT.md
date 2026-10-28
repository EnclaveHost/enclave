# relay-quarantine-prep-r1: `SESSIONS_WRITE_QUARANTINE` startup mode (source only, UNREVIEWED, NOT RUN)

Status: source only. I used only Read/Grep/Write. Nothing was executed: no python, no node, no tests, no network. I
computed no hashes. Nothing was installed, deployed, signed, sent or authorized. The originals were only read; nothing was
edited outside this directory. I did not read the old `S/api-relay`. The peer evidence I read was
`image/src/relay/api-relay.js`, for the `initSessions` / `handleSessions` / `sessionsService().route("GET", ...)` /
`verifyApiRequest` call sites, and `image/src/relay/store.js`, for `JsonStore`.

## Files

| File | What it is |
|---|---|
| `prepare.py` | The generator. It reads the five qualified inputs and `activation-r1/test/activation.test.mjs`, and writes only under `generated/` and `test/activation.test.mjs`. |
| `generated/relay/sessions.mjs` | (written by `prepare.py`) the input plus 12 marked `relay-quarantine-r1` hunks. |
| `generated/relay/{funding-route,funding-activation,fee-policy,funding-abi}.mjs` | Byte copies, unchanged. |
| `generated/relay/{sessions-abi,snp-verify}.mjs`, `generated/node_modules` | Symlinks to the same real targets activation-r1 uses. |
| `generated/PREPARE-MANIFEST.json` | sha256 of every input and output. |
| `test/activation.test.mjs` | (written by `prepare.py`) a byte copy of activation-r1's suite. It runs against this output in default mode, as the regression check. |
| `test/quarantine-default.test.mjs` | Default mode: the flag parser, wiring, unchanged surface, and static placement of the gates. |
| `test/quarantine-on.test.mjs` | Quarantine mode: it sets the flag before its first import. |

**Generator refusals.** `prepare.py` writes nothing and exits 1 if any of these holds:
- an input's sha256 does not start with its runtime prefix (`sessions.mjs` 76341ba3, `funding-route.mjs` 1989f3eb; **root:
  confirm these are sha256 prefixes**);
- an anchor is missing or not unique;
- undoing the hunks does not give the input byte for byte;
- the count of any of these changes: `new TxQueue(`, `privateKeyToAccount(`, `createWalletClient(`, `createPublicClient(`,
  `sendTransaction(`, `simulateAndSend(`, `.send(`, `SESSIONS_RELAYER_KEY`, `sessions-relayer.json`, `pc.request(`,
  `setInterval(`;
- any output names `eth_sendRawTransaction`, `eth_sendTransaction`, `sendRawTransaction`, `signTransaction` or
  `eth_sign`;
- the copied suite imports a path that would resolve differently from here.

**Pins.** The full pins (`INPUT_SHA256`, `OUTPUT_SESSIONS_SHA256`) are `None` until the root fills them. With
`--require-pinned`, the generator refuses while any pin is unset or differs. `--check` writes nothing; it compares the
existing outputs with what it would write. Reversal: put back activation-r1's `sessions.mjs`. It is the only file that
differs.

## Behaviour

The flag is read **once, when the module loads**, into a frozen `WRITE_QUARANTINE`:
- unset, empty or `"0"`: off. Every path is the input's, and the hunks are all no-ops or `if (WRITE_QUARANTINE.on)`
  branches.
- `"1"`: on.
- **Anything else** (including `"true"`, `"off"`, `" 1"`): on, with value `invalid`. It fails closed and is logged.

Nothing lifts it: there is no route, admin API, signal, setter or later env read. Only a restart can.

**When on, these layers apply.** `quarantineGate(path)` is the one gate: it throws 503 `write_quarantine` "maintenance: ...
nothing was simulated, reserved, signed or sent ...".

| Layer | Where | Effect |
|---|---|---|
| route | first statement of `route()`, before the `/funding` dispatch | Every non-GET/HEAD request is refused before any RPC and before any index, revocation, `revokedVaults`, quota, opNonce or intent change. That covers legacy `/attest /quote /execute /open /owner /end`, all of `/funding/*` (including the owner controls `/funding/owner` and `/funding/end`), unknown POSTs and other methods. |
| keeper | first statement of `keeperOnce` | Admits nothing: no read, no `ended` marking, no close. |
| simulate | first statement of `simulateAndSend` | Refuses before simulation, so no `afterSimulate` (revocation, quota, `intents.reserve`) runs. |
| queue | first statement of `TxQueue.send` | Mandatory: refuses before the serial lane, so no estimate, `_nextNonce` / pending-journal preflight, record, sign or broadcast. |
| queue_inner | first statement of `TxQueue._send` | The same gate for direct callers. |
| attestor_queue | immediately before `q.send` in `attestKey` when `q !== queue` | Covers the alternate `o.attestor.queue` path. |
| wallet / account | the `TxQueue` constructor and `createSessionsService` | The wallet client and relayer account become non-writable Proxies. Data (`address`, `chain`, `type`) reads through; every method (`sendTransaction`, `signTransaction`, `signMessage`, `request`, ...) refuses through the gate. |
| journal seal | `createSessionsService` | `flush` and `saveSoon` on the relayer journal store become non-writable own no-ops. |

**Why the journal seal matters.** `JsonStore` installs a SIGTERM/SIGINT hook that calls `flush()` on *every* store, and a
2 s timer. Without the seal, a quarantined process would rewrite `sessions-relayer.json` on shutdown and could overwrite
the root's reconciliation. With it, the file is never written by this process.

**Unchanged:** every GET, including `/config`, `/session/..`, `/owner/..`, `/by-key/..`, `/funding/owner/..`,
`/funding/session/..` and `/funding/tx/..`. Also unchanged: HEAD (404, as before), OPTIONS, `verifyApiRequest`, the
index tick, the gas check, the api-relay hooks and the fleet tunnels (not touched at all).

The successor owner-control **routes are kept**. Their reads still answer; their writes get the 503 maintenance answer.

**New:** `GET /v1/sessions/quarantine`, in quarantine only. In default mode it is still 404. It returns counts only:
refusals per layer, the suppressed journal writes, and journal `{records, maxNonce, unresolved, intents}` at boot and now.
It contains no key, hash, label or body.

There is still one key, one account, one wallet client, one public client, one TxQueue and one journal. No second writer,
signer or nonce domain is added.

## Tests (NOT RUN): `python3 prepare.py && node --test --test-concurrency=1 test/*.test.mjs`

These need node's default per-file process isolation. Do not pass `--test-isolation=none`, and do not export the flag in
the shell; the default-mode file asserts that it is unset. There are no skips and no size or limit overrides.

**Default mode:**
- `activation.test.mjs` (copied verbatim) runs against the patched module.
- `quarantine-default` checks the parser.
- Wiring, dynamic: legacy `/execute`, `/open`, `/owner` withdraw, `/owner` terminate, `/end` and the keeper's `close` each
  reach the **one** `svc.queue.send`, through a spy.
- Unchanged surface: `/quarantine` gives 404, `/quote` answers, and a real `TxQueue` still estimates, takes the nonce,
  journals, broadcasts and returns `tx_pending`.
- Static: the gate is the first statement of `route`, `simulateAndSend`, `keeperOnce`, `send` and `_send`, and sits
  directly before the attestor's `q.send`. The only `.send(` sites are `queue` and `q`. There is one `sendTransaction(`,
  inside `_send` after the gate. The four other modules are byte copies with no send, sign or wallet tokens. The funding
  route writes only through the host's `simulateAndSend`.

**Quarantine mode:**
- The flag is frozen. Assigning to it throws, and a later `env=0` changes nothing.
- All 15 write method/route pairs, plus 3 more through the actual `handle()` HTTP adapter, give 503 with **zero RPC
  calls**, an unchanged store and journal, no wallet calls and no store writes. GETs still answer, and the status carries
  no body marker.
- The keeper is skipped.
- **Pending preflight:** with an unresolved `sent` record at nonce 7 and a reserved intent, `send` (plain, intent,
  envelope) and `_send` all refuse with no `getTransactionCount`, estimate or receipt read. The journal is unchanged and
  the status matches its boot state.
- The disarmed wallet and account, in the service queue and in a standalone `TxQueue`, cannot be swapped back.
- **File-backed journal:** the bytes are identical after a refused send and after the exit-hook-style
  `flush`/`saveSoon`. A root edit made meanwhile is not overwritten.
- Successor owner controls ON (relay-owner-r2 fake chain plus the actual activation loader): terminate, revokeAll,
  withdraw and `/funding/end` give 503 maintenance with no pin read, no revocation, no intent and no send. The
  `/funding/owner/..` and `/funding/session/..` views still answer.
- **The actual `initSessions`** (throwaway key, RPC on closed `127.0.0.1:9`): writes are refused, and real viem
  wallet-client and account methods refuse. The journal `JsonStore` stand-in's write path is never reached, and the
  status contains no key material.

## Limits (read before deciding anything)

1. **Not key custody.** `SESSIONS_RELAYER_KEY` is still in `process.env`, and the real viem account still lives inside
   `initSessions`' wallet client, behind the Proxy. The quarantine guarantees that no sessions.mjs code path can simulate,
   sign or send. It does not stop other code in the same process from reading the env. Starting without the key would
   make every sessions route 503 `sessions_disabled`, reads included.
2. **Evidence that "this process never wrote" is in memory and resets on restart.** Before stopping the process, the root
   should capture `GET /v1/sessions/quarantine`. Expect `refused.wallet`, `refused.account` and `refused.simulate` = 0,
   and journal `records`, `maxNonce` and `intents` equal at boot and now. The root should also record the journal file's
   sha256 before start and after stop. On-chain nonce equality over the window says only that no relayer transaction was
   mined then. **It proves nothing about the old writer's earlier drain.** I make no such claim.
3. **GET routes are unchanged, so they can still change memory and the index.** `GET /funding/tx/..` and a session GET
   may mark records or intents mined/done **in memory** after a canonical receipt; with the seal, this is never persisted
   to the journal. The **index** store (`sessions-index.json`) is NOT sealed: the index tick and successor `FINISH` folds
   from a GET can write it. Root: decide whether to accept this or to seal the index too.
4. **Quotes are refused.** `POST /quote` and `/funding/quote` are refused, by the fail-closed "every non-GET/HEAD" rule.
   This changes behaviour only in quarantine.
5. **Log noise.** Each refused request logs `error on POST <path>` with a stack, which is the existing ≥500 logging. No
   body is logged.
6. **Unreachable gates are checked statically only.** The simulate, `_send` and attestor-queue gates cannot be reached in
   quarantine through public entries, because the route and keeper refuse first. `_send` is also exercised directly.
   Attestor wiring in default mode is static only: there is no passing SNP fixture here.
7. **Disarm scope.** The Proxy disarms only function-valued properties (a viem account's `nonceManager` object passes
   through, and it signs nothing). The public client is not disarmed. No module names a raw-send RPC, and the journal
   holds hashes, never raw signed transactions, so there is nothing to replay. A standalone `TxQueue` is gated, but its
   journal is sealed only by `createSessionsService`, the only constructor used in production.
8. **Fixture assumptions are unverified:**
   - the activation loader with intake off makes no `request` call (the test fails loudly otherwise);
   - the world's `pc` subset answers the owner views;
   - the legacy wiring bodies encode under the real ABIs.

   If a test fails on a fixture, fix the fixture, not a gate.
9. **Do not overlap processes.** Never run this process at the same time as the old writer on the same `AUTH_DATA_DIR`.
   Quarantine does not replace stopping the old writer and reconciling it.
10. **A later restart with the flag at `0` is not authorized by this report.** That restart loads whatever journal the
    root leaves. Whether it is safe depends on the root's reconciliation and on the evidence in limit 2.

