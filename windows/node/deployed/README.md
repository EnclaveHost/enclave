# What is actually running on nucbox-k11, 2026-09-24

These three files are the bytes on the box, not an approximation. They are the **previously
deployed build (0e5983d7 for host.mjs and agent.mjs; the box's own newer appzone.mjs) plus the three
fixes**, and nothing else.

| file | sha256 on the box |
|---|---|
| `host.mjs` | `170a0db029fa1cb69c3b014d6eead4008d15081005f7ead4f43dfa8efce9db0b` |
| `agent.mjs` | `d2595f3581a7289e025c00a3b451e0028ecfea7dc326a89f4fe7719fd3364b93` |
| `appzone.mjs` | `6ec96d199f7778da69f54e3aec2f7e7ba078d27430efc156414dfb43557b23c1` |

Rollback copies of what they replaced are on the box in `C:\Users\claude\vbs\node\rollback-20260924-141651\`:
`host.mjs c7536e13…`, `agent.mjs 64b4af04…`, `appzone.mjs 98ba6ce7…`, with `host-state.json` and the
7.87 MB `agent.log` beside them.

## Why these are not simply the branch's files

**A first deploy of the branch's own `windows/node/` took the node into owner-only scope**, and that
is worth recording so nobody repeats it. The branch is based on `main`, and `main` carries
`meetsIsolationContract()` from `0e01901e`, whose failure answer is `scope() -> "owner-only"`. The
box does not meet that contract, so on restart it stopped considering every deployment owned by the
governance wallet:

```
21:17:50 [node] [host] ledger: 7 active deployment(s) in scope (owner-only)
```

It then claimed `0xc34499ee`, which its own payout wallet owns, and left the user's apps unclaimed.
Rebuilding the patch on the bytes that were actually running restored it:

```
21:19:50 [node] [host] ledger: 14 active deployment(s) in scope (market)
```

So shipping `main`'s node code to this box is a behaviour change in its own right, separate from any
patch, and it silently removes the box from the market. That is the flaw Steven already identified
in that gate - a failed contract should fail closed, not quietly degrade to owner-only - and it now
has a measured consequence.

## The three fixes in these bytes

1. `holdsLease()` in `host.mjs`, used by both `/x/` routes in `agent.mjs`: the box no longer answers
   the relay's ownership probe for deployments it refused.
2. The liveness block in `tick()`: `alive()` is asked every tick, a silent app is recorded
   `unreachable` with the lease still held, and it returns to `running` when the listener comes back.
3. `refuse()` in `appzone.mjs`: a connect that fails before the app speaks answers 502 with a JSON
   body, ended and left to the TLS socket's own close so the body flushes, with a 10 s backstop.

The behavioural tests for 2 and 3 are in `test/windows-node-app-unreachable.test.mjs` and
`test/windows-node-appzone-unreachable.test.mjs`.
