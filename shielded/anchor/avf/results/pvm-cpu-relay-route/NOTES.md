# The pVM runner through the REAL relay on the Pixel 10 (2026-09-25 10:09Z-10:22:21Z): the runner at 43601dee

**LAB end-to-end, not production.** This is the first run where the phone's pVM is reached through the relay's own code
(relay/api-relay.js, its tunnel hub and relay/pvm-serving.mjs) instead of the lab hub. Everything around it is a lab:
- **The chain:** a LOCAL anvil chain (id 31337, a block every 2 s) with the real contracts. No Base transaction, and no
  funds.
- **The operators:** two fresh random keys, the owner's and a "wrong operator", held in memory only. The run's own scan
  found neither key anywhere in the results. The registration values (`repo lab/pvm-relay-route`, price 834) are
  synthetic lab values.
- **The relay:** a LAB relay process on 127.0.0.1:18443. It was started four times, each from an allowlisted
  environment (relay-env.jsonl: 19 names, none secret-bearing), with a scratch cwd outside the repository and
  `RPC_FALLBACKS=0`, reading the anvil chain. The pVM serving switch `PVM_SERVING` was on in this lab process only. The
  production relay, its environment and `PVM_SERVING` in production are UNCHANGED.
- **The phone:** the owner's authorized Pixel 10, over adb. The APK (sha256 `88b0403e…`, code hash `58ec3675…48d2a`) was
  installed over the previous build with app data kept. It was built from the committed payload and host: those are
  unchanged from e47314d9 to 43601dee.
- **The code exercised:** before the run, the harness confirmed that `runner/` and `relay/` equal the committed
  **43601dee**. That revision is e47314d9 (the design enclave-99 approved) plus 99's one fix (the co-signer reserves the
  nonce before its signing await).
- **The client:** the built pVM client 0.5.0 (the pinned dist) ran from a PATH-only environment, with lab policy keys in
  the scratch dir.

## Steps (25 of 25 as expected; steps.jsonl)

**A. Attach, bootstrap, register, serve**
- **A-attach:** the VM booted (102 s) and attached UNREGISTERED, first-come and without a co-signature. It logged the
  owner's out-of-band instance `ccd79db1…`.
- **A-row:** the relay lists it as `avf` / `pvm-cpu`, not eligible for app deployments ("an inference lane on its owner's
  phone"), and not serving.
- **A-bootstrap-attest:** the agent fetched the attested proof key through the BOOTSTRAP route
  `/t/<name>/pvm/evidence`, before any lease, and accepted it only under the owner's out-of-band instanceIds.
- **A-register, A-claim:** it registered exactly the attested key and build, and claimed the lease. The first checkpoint
  went through the bootstrap route too, because the lease route did not exist yet.
- **A-route:** the relay's `/x/<deployment>/pvm` route came up.
- **A-prove:** a checkpoint through /x, landed.
- **A-client:** the built client was served through /x as the bound deployment (8 inference steps, sealed).
- **Refusals before sealing** (nothing sent in any of the three):
  - A-client-wrong-instance: a policy binding another instance;
  - A-client-wrong-build: a policy pinning the old build;
  - A-client-stale: an answer to another nonce.
- **A-crash, A-recover:** a checkpoint was journaled and signed but never delivered, and the agent stopped. The
  restarted agent delivered the SAME transaction once, and it landed.

**B. Disconnect and reconnect**
- **B-disconnect:** the relay was stopped. The agent reported `carrier-failed` and sent nothing.
- **B-gone:** the relay came back, but the tunnel stays gone until the VM restarts (gap B: no in-place re-attach).
- **B1-no-cosigner:** a VM restart with no co-signer was refused: the name is registered, so the attach must carry the
  operator's signature.
- **B2-wrong-operator:** a restart co-signed by ANOTHER operator's key was refused ("registered on chain to 0xbae46…, not
  0x3ce55…").
- **B3-owner-cosigner:** a restart co-signed by the owner's co-signer was accepted: the same instance and the same proof
  key.
- **B-route, B-client, B-prove:** the route came back, the client was served as bound, and a checkpoint landed.

**C. The build pin at the relay**
- **C-wrong-build-relay:** a relay admitting only the OLD build (`fe734cb8…`) refused the attach on its build ("no APK
  component with an allowlisted codeHash"). The owner's co-signer had signed: its build pin is the owner's, and the
  relay's pin is independent.
- **C-right-relay, C-route:** the right relay admitted the co-signed attach, and the route came back.

**D. Release:** a final proof landed, then the lease was released.

## Result: `check.txt` PASS (runtime/conformance/check-relay-route.mjs)

The checker re-derives the load-bearing facts from the run's own records:
- **Every owner co-signature, re-verified offline:**
  - the rad: AVF, the build, the authority, over this nonce and transport key;
  - the instance and its signature over THIS transcript;
  - the operator signature recovers to the owner over exactly its own name and nonce.
- **The co-signer's record:** no nonce was co-signed twice. The co-signer journal holds exactly those 3 signatures. The
  wrong operator's one signature recovers to that other key.
- **Statements:** all 5 re-verify over their own nonces. The agent journaled exactly 5 accepted attestations and 1
  refusal (below).
- **Routes:** the bootstrap route was used in the pre-lease steps only (3 exchanges), and /x in every other (8).
- **Checkpoints:** all 5 re-verify, each one answer to exactly its request.
- **The client's verdicts, the relay's per-boot verdicts, and the chain against the journal:**
  - every Checkpointed event is a journaled landing, one per signed checkpoint;
  - the undelivered checkpoint is exactly the one the restarted agent landed;
  - one Released event, after the last proof.

test/pvm-relay-route-checker.test.mjs mutates this run 25 ways, and each must fail at its own check (26/26 including the
unmutated PASS).

The first checker version failed two checks on this run. Both were the checker misreading genuine records, and the fix
made each rule STRICTER, not looser:
- It demanded /x for every checkpoint, but the claim step's checkpoint predates the route. The rule is now the carrier
  per step, for every exchange.
- It counted the VM's `{"error":"one evidence answer every 2 s"}` as a statement. Refusals are now told apart, and the
  agent must have journaled each one as refused.
- The chain check `count equal OR all journaled` became AND.

## Observed, open

1. **The VM's evidence budget is shared: availability, not safety.**
   - What happened: at A-route, the harness's unrecorded route probe took the payload's one-answer-per-2-s slot. The
     agent's next PROOFKEY got the payload's refusal. The agent refused to take it as a key (journaled
     `attest ok:false`) and re-attested on its next tick, 63 s later.
   - Why it matters: any caller of the evidence route spends the same budget. Within the relay's per-client and
     per-deployment rates, a flood of evidence requests can delay the owner's proofs.
   - Options: a prompt bounded retry in the agent, or a separate budget for the proof-key and checkpoint kinds in the
     payload. The relay's per-(client, deployment) bucket is already RELAY-SERVING.md's wiring choice.
2. **The phone's log line overclaims.** "RELAY attach co-signed by the owner" is printed for whichever co-signer
   answered: in B2 it was the wrong operator's. The phone cannot know whose key signed. The next build's line should say
   "co-signed (attach signer)". The checker reads B2's verdict from the relay's refusal, not from this line.
3. **Gap B stands:** no in-place re-attach. After a relay drop the tunnel returns only when the VM restarts
   (RUNNER-AGENT.md).

## Lab end-to-end ready vs Base production activation

**What this run shows (lab):** on one Pixel 10, with the real relay code and the real contracts on a local chain, the
following work end to end, with every check at its pinned value:
- the owner's runner can bootstrap, register, claim, serve a verified client, prove, survive a crash exactly once,
  survive a relay drop by a co-signed restart, refuse wrong instances, builds and stale answers, and release;
- the pins are Google's roots, the build, the authority, the out-of-band instance, the deployment and the operator.

**What it does not show:** anything on Base, on the production relay, or with real keys, entries, leases, prices or
payout addresses. A Pixel 11, and several app VMs at once, are not validated.

**Production still needs** (the owner's and the relay owner's; none of it is invented here):
- **The runner's operator key,** and its fee cap (`maxFeePerGasWei`), for Base.
- **Register values:** `repo`, the production build's measurement and `cpuPricePerSec6`.
- **The lease choice:** whether to claim and which deployment, and a bond ceiling if the ledger asks for one.
- **The payout address** and minimum withdrawal.
- **The owner's out-of-band instanceIds,** read from the owner's own device.
- **The co-signer's channel** from the phone to the owner's agent.
- **On the production relay:**
  - `PVM_SERVING`;
  - the production `METAL_AVF_*`, `PVM_CPU_*` and `PVM_APP_*` values;
  - `TUNNEL_PUBLIC_ORIGIN` equal to the registered origin.
- **The client's production policy:** its signing key, and the release key.

See RUNNER-AGENT.md "What production still needs" and PROOF-KEY.md "Exactly what production still needs".
