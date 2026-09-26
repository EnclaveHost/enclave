# TEST 2: the delegation path on the NucBox hv node, 2026-09-26 (during the v42 12 h soak)

**Verdict: PASS.** An owner who is NOT the box's operator (our agent wallet `0x29479bf0…`) had a
`hyperv-partition-per-app` deployment served by nucbox-k11 ONLY through a signed delegation to the operator, and only while
that consent held. This is the path Steven's apps will take, with his own delegation signed in his Trezor.
- Procedure: windows/hv-node-rollout `test2/TEST2.md` @ 319e224f (reviewed by b4 and d1).
- Executed by enclave-d1; enclave-5d on call and reading independently from outside (~/enclave-bench/test2-5d/row.log).
- The agent key reached ONE process per command through `bash -ic`. It appears in no file here: a scan of every file,
  done from inside the key-loaded shell without printing the key, found it in none.
- Test 1 (`0x31136008`) and the soak were untouched throughout. R4 on 4d80b956 passed after every re-attach (r4-test1-checks.txt).

| step | result | when (UTC, read) |
|---|---|---|
| 1. delegation | PASS. `delegation-sign.mjs` gives VALID, and e3's `scripts/host-delegation.mjs verify` (main 335b0d8e) gives VALID. agent-2947.json (sha256 `2f1560d3…`, 1 day). The node re-attached `v2, 1 delegation(s)`, and the relay served `[0x2947 (until 2026-09-27T04:22:26Z), op]` | 04:22:26–04:23:18 |
| 2. positive | PASS after a node fix, below. ID2 `0x958ae6e9…`: hello-world 1.0.4, `--isolation hyperv-partition-per-app`, funded $0.01. `claimed` (tx `0x490bdf4e…`), a partition on image 0891c740, `certificate: 958ae6e9.app.enclave.host installed` (Let's Encrypt). The watch reads `served=yes`, `x=open ca=200 k=200 spki=78ddc685…`, runner nucbox-k11, **rate=0** (free self-hosting: the box's payout wallet is the owner). Box accept for ID2: ALL PASS (A4 owners = op + 0x2947; A7 = one VM, T0-hv, key 78ddc685; A9 401/404) | 04:58:53–05:01:53 |
| (a) snp-required | SKIPPED by enclave-87's ruling: E4 is already proven live by enclave-bf's **E15** item 1 (hookbin, owner 0x2947 delegated, snp-required → 503 at the relay), and by the node's scan-level refusal lines (`ledger: not taking …: this node runs only the isolated backend`). A new snp-required deployment would have launched a needless SNP guest on metal-iso0 | — |
| (c) file removed | PASS. Moved out at 05:06:32.8Z. `the owners this node serves changed … attaching again`, then `attach v2, 0 delegation(s)` (05:06:58). The relay then read `served=no`, `x=refused(503)`. ID2 was **held** ("not started, not renewed, not released"), with **0 renewals**. At the lease end (05:28:55) the node logged `05:29:24 stopped 0x958ae6e9: its lease lapsed while held for an owner this box does not serve (0x29479Bf0…)`, and the VM was gone. No release tx | 05:06:32–05:30:36 |
| (b) 10-min expiry | PASS. agent-2947-10m.json (`b892883f…`, expires 05:41:02) re-claimed ID2 (tx `0xde4ea49c…`) onto a NEW partition. The relay read `served=yes until=05:41:02` (the DELEGATION's expiry, before the lease end). Probe every ~5 s: the last `x=open` at 05:40:57.7, **the first `x=refused(503)` at 05:41:05.1**, 3 s after the expiry and BEFORE the node noticed (05:41:19 `delegation … ignored: expired at 1790401262` → re-attach v2, 0 delegations). ID2 was held with 0 renewals; `06:01:53 stopped 0x958ae6e9: its lease lapsed while held …` at the lease end (06:01:25). No release tx | 05:31:02–06:02:44 |
| teardown | `refund` returned $0.01 to the agent wallet, and ID2 is cancelled (active=false, balance6 0). delegations\ is empty (both files kept in `state\delegations-removed\`); owners = [op] | 06:03:54–06:04:09 |

## The node fix this test forced (head-of-line starvation), and its install
- **Found:** scanLedger allows one new claim per pass. An abandoned agent-wallet row with no envelope (`0xca141665…`, from 09-21)
  passed the scan-level claimPolicy, used the claim slot, and was then refused by consider(). It was re-taken every pass, so ID2 was
  never reached. The delegation had made its owner a served owner. No gas was spent.
- **Must-fix before Steven's delegation:** any older Steven deployment without the hv envelope would have starved all his
  hv deployments.
- **Fixed:** enclave-b4 `317b3152` (bf and 5d GO). Installed with the new `hvnode-install.ps1 -NodeOnly` (enclave-5d; manager
  and test 1 untouched; one agent restart; node-installs/). The first pass after it logged `not taking 0xca141665` at the
  scan, then `considering 0x958ae6e9` and `claimed`.
- `-NodeOnly` efd1ac677 printed a FALSE `NOT UP`: PowerShell 5.1 unrolls a one-element `@()` to a bare CimInstance whose `.Count`
  is null, which also made its "gone" check vacuous. Fixed in 14dc123d and verified on the box.
- Then node `f1461271` (b4's owner-change re-attach fix plus per-image judge-hv) was installed the same way at 06:02:59Z, after (b):
  one restart, test 1 adopted, R4 `ca=200 k=200 4d80b956` at 06:03:44Z.
- 0xca141665 was then CANCELLED (setActive tx `0xded9430d…`). Its `refundableOf` is 0 (the CLI finding went to 5d).

## Observations for Steven's apps
- Every delegation change makes the node re-attach, which REPLACES the tunnel: about 10 s during which the box serves nothing.
  enclave-5d measured this from outside. Node f1461271 makes an ADDED owner make-before-break (no gap) and keeps
  break-before-make for a REMOVED one.
- The relay enforces a delegation's expiry at decision time, within seconds and without an attach. The node follows at its
  next tick.
