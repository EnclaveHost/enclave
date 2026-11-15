# The agent's signature check, kept for ten minutes (2026-11-15)

**What happened.** At 11:35Z the KVM Box's owner signed its first network policy (one hop, `ops/one-hop-20261115/`).
The app is held by a session vault, so checking that signature reads the chain at an agreed block, and the NucBox's
agent does that through its own circuits: five times per refresh round (each of four directories' copies, then once
more to admit it). Read from the agent's log (one idle app writes a line each round):

| window (Z) | rounds | apart, median / most |
|---|---|---|
| 10:30-11:00, no signed policy | 118 | 15 s / 25 s |
| 11:40-12:10, the policy signed | 37 | 46 s / 60 s |
| 14:01-14:11, the KVM Box without a lease (its policy is not read) | 20 | 30 s / 31 s |
| 15:00-16:00 | 61 | 59 s / 96 s |
| 19:00-19:59 | 67 | 47 s / 113 s |

A lease counts as current for 90 s after the chain snapshot it was read in (`network/lease-reader.mjs`), and a round
that runs long delays the next snapshot. So with rounds near a minute every app on the box was close to the edge, and
past it the agent withdrew every app's network at once ("authorization lapsed (lease or guest proof)") and built every
circuit again, which made the next round long too. After the desktop image switch of 14:00Z
(`ops/stream-flow-20261115/`) that went round seven times between 14:21:58Z and 14:37:29Z, each about a minute
without routes for the seven apps, and again at 19:24Z and 19:30Z; the loopback exemption list went from 252 to 433 of
682 entries on the way. The KVM Box's own circuits came back through Toronto and Frankfurt, not us-west.

**The change** (main): `rememberVerified` in `network/owner-signature.mjs`, used for the agent's verify in
`network/enclave-network-host.mjs`. A check that succeeded is not repeated for ten minutes for that owner, message
and signature; a check that fails is repeated each time; the same question asked while it is being answered is asked
once. An owner that changes on chain is believed for at most ten minutes more.

**For the NucBox** the function is carried onto the bundle that runs there (`agent-bundle.py`: 14 lines added, one
changed; 2,961,488 bytes, 018082345a1058f0…927b8) and installed with `agent-policy-check.sh` (`stage`, `swap`,
`revert`, `status`).

Not addressed: a round still waits for every app's policy and for the circuits to be configured before the next chain
read can start, so anything else that makes a round long has the same effect.

## Activation

(Staged on the NucBox 2026-11-15 20:02Z; not swapped at the time of this commit.)
