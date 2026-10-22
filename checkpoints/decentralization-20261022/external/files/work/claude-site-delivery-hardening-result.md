# Site delivery hardening: result (2026-10-19)

The interface was written first: `work/site-delivery-hardening-interface.txt`.

The hash inventory is `work/site-release-final-source-inventory.json`. It covers 20 owned files, 5 dependencies, the
interface documents and reports, the production payload used, and tool versions.

Repo: `work/enclave`, HEAD `ee8beb38`. **Nothing is committed**: every site-release file is untracked or modified in the
working tree.

**What I did not do:**
- no staging, production, SSH to real hosts, GitHub settings, wallet writes, GUI or Wine;
- no edits to browser, CLI core, Windows, custody, storage, ipns-publisher Rust or contracts.

## Findings, and what changed

### F1: an unknown SSH outcome was labelled "unchanged" or "rolled back"

**Fixed with operation identity, a durable journal, and reconciliation.**

- **Per root** (`scripts/site-release/root-state.mjs`, the same code for local roots and the SSH agent):
  - `root/state.json` is the single atomic commit point (tmp, fsync, rename), holding `{generation, current, pending,
    lastOp}`;
  - `root/ops/<opId>.json` records every operation's result, once;
  - a durable `pending` intent is written before any change, and `recover()` restores an interrupted change before the
    next operation runs.
- **Per rollout** (`scripts/site-release/rollout.mjs`): `--journal DIR` is required. The journal records each target's
  state **before** each send.
  - A lost answer or a timeout becomes `unknown`, followed by **one `result <opId>` read**. The activation itself is
    never re-sent; a replayed opId would return its recorded result anyway.
  - Outcomes:

    | Outcome | Exit | Meaning |
    | --- | --- | --- |
    | `active` | 0 | every target committed |
    | `reverted` | 1 | nothing of this rollout is in effect: each target refused, rolled back, undone, superseded or skipped |
    | `pending` | 5 | an unknown outcome or an undo that did not land |

    A pending result prints the journal path and the exact
    `site-release resolve --journal … --rollout … --targets …` command.
  - The words "unchanged" and "all rolled back" are no longer produced for an unknown outcome; a test asserts it.
- **`resolve`** works after any restart, from any machine with the journal. It reads each unsettled result, then
  completes the rollout or compensates. It never re-sends an activation.
- **The agent** reports `definite: true` only when it did not run the operation (its grammar, its config, its lock held).
  Anything else is treated as unknown and settled by reading the result.

### F2: rollbacks were not fenced

**Fixed with generation fencing held durably on each root.**

- **Activation** is a compare-and-swap on the generation the rollout observed in its plan phase.
- **Undo** reverts only that operation, and only while `generation` and `current` still equal what it committed.
  Otherwise the result is `superseded` and nothing changes. A same-CID A-B-A case is caught, because the check is on
  the generation, not the CID.
- **An undo is a new generation,** never a rewind.
- **Explicit rollback** (`rollback --to CID`) is a fenced rollout to the earlier CID. The interface's separate
  `rollback-to` agent operation was folded into `activate`, which has identical fencing.
- **A lock left by a dead process on the same host** is taken over, and the takeover is logged. A live holder is never
  broken.

### F3: receive buffered up to 2 GiB

- The agent now streams stdin to `.incoming-*/upload.car` under `maxCarBytes` (default 128 MiB, at most 1 GiB) and
  refuses a larger CAR while it is still streaming.
- It reads the file once; there is no `Buffer.concat` doubling.
- It refuses an `agent.json` or root that is not owned by the agent's user, or that is group- or world-writable.
- A wrong-root CAR, or a release whose derived `release.json` differs, is rejected, and `.incoming` is removed.
- `activate` of a CID the host never received is refused.

### F4: the pointer proposal overclaimed cold-restart anti-rollback

`docs/ipns-release-pointer-proposal.md` was rewritten from `main.rs`:
- `load_state` needs `/data`. `enqueue_publish` runs `RecoverDht` only when there are no delegates and no durable
  state. `do_recover` ignores failures, and `Sign` uses sequence 0 when nothing was recovered. So after total state
  loss, an old, unexpired pointer passes.
- Expiry alone forces continual re-signing and still leaves a replay window. The IPNS sequence alone is the very state
  that was lost.
- **The revision:**
  - an explicit threat model;
  - a fresh anchor: an owner-configured, immutable Base contract with a CID-only delegated signer, a compare-and-swap
    `seq`, and an owner `setSigner(0)`/`pin` revocation effective at the next block;
  - the publisher reads it by k-of-n RPC quorum at a fresh, confirmed block, and sets IPNS sequence = `seq` plus a fixed
    offset;
  - with the anchor unreachable after state loss, it publishes **nothing** (safety over liveness, stated);
  - the IPNS identity is preserved, and per-release owner signatures are explicitly **not** automation parity.
- Not implemented.

### F5: unqualified "all or nothing" claims

Removed everywhere. `docs/site-release.md` has a new section, "Rollouts: what is and is not guaranteed": per-root
fencing and journals, per-rollout outcomes, no atomic commit across hosts, and hosts that can differ while a rollout is
pending.

### CI

`site-deliver` passes `--journal "$RUNNER_TEMP/rollouts"`, writes the outcome (active, reverted or pending) to the
summary, and uploads `site-rollout-journal-<CID>` with `if: always()`. A pending rollout fails the job, and resolve
settles it later from that journal.

## Tests: exact serial runs

All runs were under `/tmp/s6/run-768.sh`, which kills only its own process group at >768 MiB, <16 GiB available, or
after 900 s. Every run was in the foreground. No run was killed, and nothing of mine was left running.

| Run | Result | Group peak | Min available |
| --- | --- | --- | --- |
| site-release (ported to rollouts) | 9/9 | 275 MiB | 18432 MiB |
| site-rollout (new), 1st | 3/3 | 36 MiB | 18733 MiB |
| site-delivery, 1st with the new tests | 5/8: my stdout-JSON parser was fragile and a size threshold used MiB; test-side only, fixed | 488 MiB | 17565 MiB |
| site-delivery | 8/8 | **705 MiB**: too close to the cap, so production preparation moved into a child process | 17349 MiB |
| site-delivery | 8/8 | 643 MiB; the idle Caddy a/b/c and kubo are then stopped before the production test | 18200 MiB |
| site-delivery | 8/8 | 513 MiB | 17724 MiB |
| site-publish (now `--journal`) | 4/4 | 580 MiB | 18367 MiB |
| **final site-release** | **9/9** | 231 MiB | 18696 MiB |
| **final site-rollout** | **3/3** | 38 MiB | 18881 MiB |
| **final site-delivery** | **8/8** | 517 MiB | 18302 MiB |
| **final site-publish** | **4/4** | 572 MiB | 18253 MiB |

**Swap.** System swap was already 4095/4095 MiB used when this session began, before any of my jobs. Available memory
stayed at or above 17.3 GiB throughout, so my jobs did not cause swapping, but I cannot assert "no swap" system-wide.

### Production payload

The production CAR `work/logo-site-hotfix/final/site.car` (CID `bafybeig3rai…`) was verified and extracted in a child
process, then prepared with production as the base, giving a release CAR of 39,931,034 bytes. It went through **real
OpenSSH** into an **isolated scratch root** with its own real Caddy. The agent's own peak RSS:

| Phase | Final run | Other runs |
| --- | --- | --- |
| receive | **249 MiB** | 251, 254 MiB |
| activate | **159 MiB** | 169 MiB |

Both are within the 384 MiB target and the 1 GiB provider capacity. Caddy then served production's `dashboard.html`
byte-exact, with every production inline-script CSP hash. Also refused with nothing left behind: a wrong-root CAR, an
activation of a never-received CID, and a 65 MiB stream against a 64 MiB `maxCarBytes`.

### What the tests prove

- **site-rollout (local roots, real child processes):**
  - compare-and-swap; idempotent replay; A-B-A undo `superseded`; undo as a new generation; `unknown-op`;
    unknown-CID refusal;
  - **interleaved rollouts:** rollout A commits on a, then rollouts B (z) and C (y again) run fully inside A's hook. A
    then gets `refused` at b and `superseded` at a, and both roots keep C's release, unchanged by A;
  - **killed orchestrator:** b's reload SIGKILLs the tool mid-change, leaving a committed, b pending and the journal at
    "sent". A **new** process's `resolve` restores b (recorded "interrupted", headers restored), undoes a (fenced), and
    reports `reverted`. A second resolve changes nothing.
- **site-delivery (actual Caddy x4, kubo RPC, OpenSSH sshd):** the forced command is the real agent behind a fault
  wrapper that kills the ssh session **after** the agent committed and journalled.
  - **Cut on `activate` only:** one activation is sent; the host had committed; a `result` read settles it; the rollout
    is `active` everywhere.
  - **Cut on `activate` and `result`:**
    - exit **5**, `pending`, with the journal and the resolve command, and no "unchanged";
    - real state: a undone, c **actually serving the new CID**, b skipped; a mixed state reported as such;
    - resolve while the fault persists: still pending, and it sent only one `result`;
    - after the fault clears, resolve in a new process: c committed, so a fenced undo; `reverted`; all hosts back;
    - no activation was ever re-sent.
  - The earlier real-server tests still pass under the new semantics: the stale front is now reported "reverted (a:
    undone, c: undone, b: rolled-back)"; headers go before content; cached tabs and CSP work; the wrong host key and
    forged operations are refused.
- **site-release and site-publish:** unchanged behaviour, ported to `--journal`.

## Remaining boundaries (not claimed)

- **No multi-host atomic commit.** During a partition, hosts can serve different releases until `resolve` succeeds.
  Resolve needs the journal and reachability. A journal that is lost (for example, CI without its artifact) leaves only
  each root's own `state.json` and `ops/` as the record, which an operator can read (`status`, `result`).
- **Lock takeover is same-host.** It relies on PID liveness, so a reused PID could keep a stale lock (a refusal, never a
  takeover).
- **An undo whose probe fails** is reverted to the activation it was undoing and reported `undo-failed` (pending). That
  path is implemented, but no test exercises it.
- **Not run:** real hosts, CI on GitHub, the publisher relaunch, and the IPNS/DHT result. The publication boundary from
  the last report is unchanged: the owner's one-time vault/session setup, or one owner `config set` per release.
- **Shared-CLI dependency.** Session publication runs `cli/enclave.mjs config show/set` in independent mode through a
  vault session. Those paths are part of the **uncommitted CLI parity work, pending the coordinator's move review**,
  and so is the anvil rig `test/helpers/cli-independent-rig.mjs` that site-publish uses. The inventory marks both.
- **The release-pointer proposal** needs a contract and Rust review before any implementation.

## Files

**New:**
- `scripts/site-release/root-state.mjs`, `scripts/site-release/rollout.mjs`;
- `test/site-rollout.test.mjs`;
- `work/site-delivery-hardening-interface.txt`, `work/site-release-final-source-inventory.json`.

**Changed:**
- `scripts/site-release/targets.mjs`: the unfenced activation was removed; the primitives moved to root-state;
  `receiveCar` takes a file; `maxCarBytes`;
- `scripts/site-release/agent.mjs`: the new grammar, streamed bounded receive, ownership checks, `definite`, RSS;
- `scripts/site-release/cli.mjs`: `--journal`, `resolve`, outcome exit codes;
- `scripts/site-release/rollout.mjs`, as above;
- `site/deploy.sh`;
- `.github/workflows/deploy.yml`: site-deliver only (journal, outcome handling, journal artifact);
- `test/site-release.test.mjs`, `test/site-delivery.test.mjs`, `test/site-publish.test.mjs`;
- `docs/site-release.md`, `docs/ipns-release-pointer-proposal.md`;
- `README.md`: the two related lines.

The earlier release components (`unixfs.mjs`, `car.mjs`, `release.mjs`, `headers.json`, `ssh.mjs`, `publish.mjs`) are
unchanged in this round and are listed with their hashes in the inventory.
