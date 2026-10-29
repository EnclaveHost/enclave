# migration-cutover-fault-r2: REPORT (author; UNREVIEWED, NOTHING RUN)

Everything here is SOURCE ONLY. I ran nothing: no generator, no node, no browser, no anvil, no network. I did not sign
anything, touch production, or change the qualified SDK, page or core. All runtime, terms, approval and activation records
are TEST-only. Nothing here is a human or production approval. Production original30 is untouched; no grant approval
and no relay activation. The operational relay checkpoint qualification is separate and still pending.

## Exact commands (unrun; ROOT reviews first, then runs in this order)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028
python3 migration-cutover-fault-r2/fixture/generate_fixture.py
python3 migration-cutover-fault-r2/run-build-r2.py
node --test migration-cutover-fault-r2/test/fault-r2.test.mjs
node migration-cutover-fault-r2/out/server.mjs 0 1800
#   Chromium: open the printed http://127.0.0.1:<port>/ and click the enabled phase buttons in order. At C8c allow the
#   popup; if it is blocked, open http://127.0.0.1:<port>/#peer in a second window of the SAME browser profile.
#   The DB names are fresh and random. Run pCleanup only after the run (it deletes only this run's TEST DBs).
```

## Source and pins

- **Source:** the ROOT snapshot `migration-cutover-site-review-r1` (out/server.mjs, shell/*, build driver, page shell).
  I did not use the author's final generator.
- **Pins:** `generated/FIXTURE-GEN-PINS.json`. I copied every hash from root's own review-r1 manifests (`out/GENERATED.json`,
  `generated/BUILD-PINS.json`, `generated/HARNESS-INPUTS.json`). None was computed or invented by me. The generator
  re-reads those manifests and refuses unless each pin equals both the manifest value and the file's actual sha256.
- **Code under test:** not copied. It is imported from review-r1 and pinned again under `unchangedUnderTest`:
  - pages/funding.js 635cdcc1…
  - flows.js 88d2e23a…
  - state.js 010d864f…
  - util.js 71a896f1…
  - vendor funding.js f23ba2d79661ade43ed484e186d0347b95756dbe70a9735c4b3152da653dd957
  - sessions dist 9dda76f6…
- **Hashes root must still produce:** only build outputs that do not exist yet (this dir's BUILD-PINS, bundle,
  HARNESS-INPUTS). `run-build-r2.py` computes them from the files at run time and asserts that every non-shell pin equals
  review-r1's.

## Edits

All edits are labelled `migration-cutover-fault-r2`. Each is an exact anchored edit, and reversing them must give back the
pinned input exactly.

**out/server.mjs (8 edits)**
1. Lost terminate reply: an armed one-shot. The NEXT `POST /v1/sessions/owner` is really processed by the composed relay;
   then its reply is lost after the headers (the same technique as the qualified execute "body" fault). Counted in
   `ownerReplyFaults`.
2. Time advance: `POST /test/fixture/advance-time {seconds}`. It is one-shot and bounded to 60..1200 s. It refuses while
   the anvil txpool has pending or queued transactions. It runs `evm_increaseTime` + `evm_mine` on the owned anvil, checks
   the new latest timestamp, and then offsets this process's `Date.now`. That keeps the composed relay's clock (request
   timestamps, deadlines, intake notAfter) on the chain's time. The intake manifest `notAfter` gains the 1200 s bound.
   The result is counted in `clockAdvanceS` / `advance`.
3. Everything else is the qualified fixture: prompt cap 24, tick cap 250, maxSeconds ≤ 1800, loopback/Host pin, owned-PID
   cleanup, public Anvil keys only, no code-size override.

**shell/main.mjs (12 edits).** Phase order:
pStart → C1 → C2 → C3 → **C4** → **C5** → **C6** → C7 → C8 → **C8b** → **C8c** → **C9** → **C10** → 5 → 6 → **7** → 8, 9, 12–16, 10, 11, 11b.

- **Gap 1 (C4–C6)**
  - **C4:** signs the whole plan (7 prompts), arms the owner fault, then Send. Asserts:
    - exactly 1 `/owner` POST, no `/open` or funding POST;
    - journal terminate = `admitted`, no txHash, `observed`, no pause marker;
    - exactly ONE original-vault transaction on chain since admission, with the exact refund already on chain;
    - the page shows "Outcome unknown", not Paused.
  - **C5:** real reload.
  - **C6:** asserts the UNKNOWN survived the reload, then 4 ticks and page **Check status**. Asserts:
    - terminate proven as THAT tx, `proof.final === true`;
    - pause written with that proof; exact refund;
    - zero prompts and zero POSTs (no resend, no replacement, no gas).
- **Gap 2 (C8b, C9, C10)**
  - **C8b:** advances by `max(60, maxSignBefore − chainTs + 60)` s. Guard: the owned anvil's ACTUAL latest timestamp is past
    every remaining `signBefore`. Then it reloads; the page's `Date.now` follows the same offset, applied before the page
    module evaluates and shown in `#hclock`.
  - **C9:** paused + expired shows NO Prepare again, no Sign, no Send.
  - **C10:** after activation only Prepare again ×3 is offered. After the three re-arms it asserts:
    - unchanged: terms, termsHash (so the same TEST approval), the cutover pause, the termination evidence, the activation
      record, and the proven terminate step;
    - each step is attempt+1 with a new digest, and the old review is in history (planned, txHash null);
    - every grant field except nonce/window is unchanged: the replacement keeps the SAME old key and `["*"]`; the gas parts
      keep the same key/record and finite scope;
    - the same two gas key records; no prompt or POST.

    Then a forced click on the disabled Send must admit nothing. Then a fresh Sign (6 prompts) and Send, as qualified.
- **Gap 3 (C8c, C9, phase 7)**
  - **C8c:** opens a PEER tab on the same origin with `#peer`. It is handed this run's state over a same-origin
    BroadcastChannel and uses the same random TEST DBs (asserted). Its phase buttons are all disabled. It acts only on
    `remount` / `click` (whitelist: `#fdActivate #fdRec #fdSign #fdRun`) / `close`.
  - **C9:** both tabs click Record activation at one shared instant. Exactly one "Activation recorded"; zero prompts and
    POSTs.
  - **Phase 7:** both tabs sign the same metal review (+2 prompts → total 21 ≤ 24), then both Send at one instant. Exactly
    ONE `/funding/open` POST; metal proven at the same attempt and digest (one IndexedDB CAS admission); the peer then closes.
- **Visible history:** a cumulative PASS/FAIL history is kept in sessionStorage and rendered in `#hhistory` across reloads.
  The per-phase log still resets per click.

**page/index.html:** title; the stale provenance paragraph is replaced with an accurate TEST-only one; `#hclock`;
`#hhistory`.

**build/build-harness.mjs:** one provenance comment only. It still bundles only the pinned files.

## Risks root should watch (none observed; nothing ran)

- **Possible retry on the lost terminate reply.** If the legacy relay client (SDK) retries a POST after the reply is lost,
  C4 FAILS on `/owner` hits = 2. That would be a real finding about the SDK, not a fixture bug.
- **Clocks that `Date.now` does not cover.** The offset only covers `Date.now`. Any code using `new Date()` would show up
  as FAILs, e.g. a stale-timestamp 401 in phase 7's API probe.
- **Exact grant-field comparison in C10.** It assumes the gas review `grant` JSON varies only in `grantNonce` and
  `signBefore` on re-arm. If it carries another per-nonce field, C10 FAILS visibly.
- **Background tabs.** Chromium may throttle timers in the background tab. The barrier is 1.5 s ahead and every wait is
  bounded.
- **Anvil RPC support.** C8b needs `txpool_status` and `evm_increaseTime` (hex quantity) on the pinned anvil.
- **No defect found in the qualified SDK/page.** I propose no patch to it.
