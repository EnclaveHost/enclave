# metal0 protected-lease keeper (temporary, finite; SOURCE ONLY - root reviews, root runs; nothing installed or started)

**Why it exists.** The 23:36Z cutover rolled back automatically at 23:43:19. The 5db control had registered (tx 12d7…, nonce
23759, 7 mwei) and adopted both original guests, but the gate failed on one EyesOff URLError. The old control is unregistered
again, and the operator's 1.45e11 wei cannot pay another update. The two protected app guests keep running, and someone must
keep their leases app-renewed until a control adopts them again.

## What one cycle does (`keeper-cycle.mjs`, logic in `lib.mjs`, production I/O in `deps.mjs` = root's renew-protected-2331.mjs)
It runs for exactly the two pinned deployments and nothing else (no claims, no other id). The pins are:

| Deployment | Guest |
|---|---|
| image-generator `0xda09d0f2…` | gd9d4a391d |
| EyesOff `0x9eb4e600…` | gdd0646f2c |

Pinned for both: runner `0x4dde6d1b…`, operator `0xc9d0…e6ab`, per-op ceiling 31092172031561 wei.

In order; every refusal renews nothing:
1. **Pins, stop, TTL.** `state/keeper.json` (written once by `--init`) must carry exactly these pins.
   - A `state/STOP` file (root) ends the keeper.
   - So does 4 h after `--init`.
2. **Ambiguous attempts.** Any signed intent without its verified result STOPS the keeper (exit 3): root reconciles. It never
   re-signs.
3. **Per app: lease and guest.**
   - The lease must be active and held by metal0's runner and operator, read through the quorum-verified authority (3 public
     RPCs, quorum 2, digest-pinned record).
   - guestd, over the authenticated pairing key, must show the ORIGINAL guest running under the deployment's name.
   - Anything else means REFUSE (exit 4).
4. **Adoption by the control.** If public `/availability` shows the control ADOPTED the original guest (exactly one live row,
   running, owned), the keeper renews nothing for that app, so there is never a second signer.
   - A later lease extension the keeper did not make is recorded as the control's normal renewal.
   - **Done (exit 10)** once both apps show it.
   - Mere attachment, or adoption without a normal renewal, is not done.
   - A held row with ANOTHER guest means REFUSE.
5. **Renewal.** Otherwise, renew only when:
   - the reserve's own `statusOf` is `Ready` (the client's renew window; the unchanged lease client checks it again before
     signing);
   - and fewer than 8 keeper renewals exist for the app.

   The renewal goes through the unchanged production lease client:
   - Its `onSigned` hook checks kind renew, this id, and the ceiling.
   - It then writes `state/<id>/NNN.intent.json` (0600, O_EXCL, fsync of the file and directory) BEFORE any relay sees the
     lease.
   - The verified receipt becomes `NNN.result.json`: hash, charged wei, `operatorEthSpent: false`, lease before and after.
   - A failure after signing leaves the intent, so the next cycle stops (exit 3).
   - A refusal before signing is transient (exit 5).
6. **Key exposure and logging.**
   - The operator key is read only inside a due renewal; the guestd pair key is zeroed after use.
   - Output carries ids, statuses, hashes and wei, never a key, signature or raw lease.
   - There is a hard 240 s per-cycle deadline, and an O_EXCL per-cycle lock (a live holder gives exit 6).

## The loop (`keeper-loop.sh`)
- **One instance:** `flock` on `state/loop.lock`.
- **Cadence:** one cycle every 60 s, each through the UNCHANGED queue at 256 MiB.
- **Not-started cycles:** a queue answer 98 is retried every 15 s, at most 40 times, and only while the lowest known lease
  (`state/last.json`) is valid.
- **Stop codes:** it stops on 3, 4 or 10, and continues on 0 or 5.
- **Hard deadline:** 4 h 10 min, exit 11, even if the queue never starts a cycle.
- **No retry loop inside a cycle;** the lease client's own timeouts apply.

## Root runs it (after review)
```
cd work/custody-protected-lease-keeper-20261023
node keeper-cycle.mjs --init                     # pins + start time; the 4 h TTL starts here
systemd-run --user --unit=protected-lease-keeper --collect bash "$PWD/keeper-loop.sh"   # or tmux; nothing is installed
touch state/STOP                                  # root's explicit stop (takes effect at the next cycle)
```
Watch `state/cycles.log` (one JSON line per cycle), `state/last.json`, and `state/<id>/NNN.result.json`.

## Review points for root
- **Availability unreadable:** if `/availability` cannot be read, the keeper treats the app as not adopted and may renew.
  During a cutover, either STOP the keeper first or accept that the lease client's policy (window/nonce) arbitrates a
  simultaneous control renewal.
- **Gap after adoption:** while the control has adopted an app but has not yet renewed it, the keeper does not renew it either.
  If that control then fails to renew, root must act, or STOP the control.
- **Tests: 8/8** (`evidence/tests.out`, queue 256, peak 143 MiB). They run the ACTUAL cycle, entry and loop with fake deps and a
  fake clock:
  - window-only renewal, with the intent before the POST;
  - ambiguous intent stops every later cycle;
  - pre-sign refusal is transient;
  - scope checks (kind, id, ceiling);
  - lease, runner, operator and guest refusals;
  - TTL, STOP, cap and pins;
  - adoption, then normal renewal, then done (attach alone is not enough);
  - lock and stale lock, uninitialized state;
  - loop single instance, bounded 98 retries, stop codes and loop deadline.
  `deps.mjs` (the live I/O) is syntax-checked only: it reads production files and the key, so root runs it.
