# guest-original-game-canary-stage (PREPARED; templates refuse until filled from FROZEN inputs; nothing run by Claude)

**Purpose:** on the guest, against the FINAL composed bytes, exercise exactly what first bootstrap will use: the capture module's
**original-game `recheck` mode**. That is the pinned initial receipt b9a90847 → game 0x343b3a99527af07d2cfb2652747b9e37715e21ac /
N 52866960 / root 0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700, followed by the module's own `verify()`.
- The on-chain recheck is captured fresh on the guest through own EL `127.0.0.1:18645` and the pinned Helios, never copied from a legacy `run-recheck.py` pair.
- It writes no admission ledger and nothing to `/etc/enclave-rpc` or any production path.

**Results:**
- `verified`;
- `refused`: for example the game has been retired or blacklisted, the anchor is not finalized, or the ASR has moved. This is reported verbatim. **No other game is ever tried.** A refusal means first bootstrap needs a reviewed SOURCE decision.
- `failed`;
- `blocked`: the contract is not filled, or the production Sources cannot supply the pinned receipt.

**Compact by reuse (nothing bundled or copied here):**
- the host flow is derived from the frozen guest canary r3 job;
- r3's `guest/canary.sh` and `guest/cleanup.sh` (r3 SUMS 9367c877) run **in place**: 512M scope, PIDs unchanged, own CL/EL, Helios 18550, pinned checkpoint and provenance, floor watchdog, owned cleanup;
- the bundle comes from the cold-proof canary assembler (61ba3daf), **imported byte-identically**, plus one extra file: the composed manifest's b9a90847 receipt.

**Files:**
| File | Role |
|---|---|
| `guest/canary_driver.py` | the only new guest logic |
| `tools/assemble.py` | bundle assembly (reuses the cold-proof assembler) |
| `jobs/root-original-game-canary.sh` | root job |
| `COMPOSED-STAGE-PINS.json` | final composition pins (null until frozen) |
| `CONSUMER-CONTRACT.json` | da0's consumer contract (null until frozen) |

**Fill both JSON files only from FROZEN stages, then re-freeze `SHA256SUMS`.**

**Root command** (from `work/rpc-production-final-20261025`, after the final composition is root-qualified):
```
python3 -u ../claude-test-queue.py --mib 512 --log guest-original-game-canary-stage/logs/root-original-game-canary.guard -- bash guest-original-game-canary-stage/jobs/root-original-game-canary.sh
```
**Preconditions:**
- no other canary is running, and port 18550 is free;
- checkpoint 2e8502e6 is valid until 2026-11-01 19:22 UTC.

Report: `../logs/claude-original-game-canary.md`.
