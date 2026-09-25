# Posting agent, device run 1 (kept as it is): `check.txt` FAIL at the reorg step

This is the posting agent on the Pixel 10, run by cpu/proof-agent-run.mjs from 2026-09-25 06:53:10Z to 07:04:52Z (UTC).
- It used the proof-key build 113ca8f8, code hash fe734cb8, already installed. App data was kept.
- The chain was a LOCAL anvil chain mining a block every 2 s, with the real contracts.
- The operator was a fresh random key held only in memory, and the run found it nowhere in the results.
- enclave-5d cleared the phone first.

All 12 planned steps reported the outcome they name, and the run exited 0. The offline checker passes every check except
one: **reorg**.

**Why the reorg check fails.** The harness's reorganization hook reverted the chain as soon as the proof transaction
(0x7b9002f2…, block 180) was MINED, before the agent's first receipt poll.
- To the agent, that transaction never mined. After its bounded receipt wait (10 s), it did what it does for a send that
  does not mine: it REPLACED the same checkpoint at the same nonce, bidding 25 % more (0xf0965b97…).
- The replacement landed in block 186, and provenUntil advanced.
- So the proof landed and the agent behaved correctly, but not through the path the step exists for: a receipt the agent
  HAD SEEN, reorganized away during the confirmation wait, then the same bytes rebroadcast. The journal has no `reorg`
  record, and the checker says so.

**The fix, in the harness only.** The hook now reverts only after the agent's own `getTransactionReceipt` has returned
that receipt. The agent did not change. The local suite already drives the confirmation-wait path: there the fake clock's
first sleep comes after the agent has seen the receipt. Run 2 is results/pvm-cpu-proof-agent.
