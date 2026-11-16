# The edge provider held its event loop verifying signatures (2026-11-16)

**What it was.** About once a minute a stream through an edge stood still for 300–500 ms (twice in a row for a
second), with no packet lost anywhere and the app still sending. The edge's provider process was on the processor
flat out for exactly that time. A profile of its main thread (`perf record -t`, 199 Hz, during a test stream) puts
the stretch in V8's big-number modulus (`Builtins_BigIntModulusNoThrow`, `bigint::ProcessorImpl::Modulo`,
`DivideSchoolbook`): pure-JS secp256k1 recovery. Every 30 s the provider reads the provider list from the public
directories and recovers the signer of every record and every checker's qualification again
(`DirectoryClient.providers`), one after another with nothing between them that lets the event loop run. Every
connection to an app on that edge passes this process, so for that time nothing moved; the app's front, hearing no
reports for more than 100 ms, dropped what the app sent (`tunnel_flow.go`, `late`).

**The change (main).** `recoverSigner(text, signature)` in `network/provider-directory.mjs`: a signer already
recovered for the same text and signature is remembered (4096 entries, least recently used out first), and after
each new recovery the caller yields to the event loop. Only the recovery is remembered; a record's validity, expiry,
operator and who may sign are checked by the caller every time as before. Used by `verifyProviderRecord`, both
qualification checks and `DirectoryClient.providers`. `test/recover-signer.test.mjs`.
`network/wg-provider/install.sh` gives the provider's unit `CPUWeight=400`.

**What runs on the edges.** No edge runs a build of main (ops/one-hop-20261115/README.md), so the change is carried
onto the bundles they run, as the one-hop change was: `signers-bundles.py` replaces the bundle's one copy of viem's
`recoverMessageAddress` with the remembering, yielding one (all its callers in the bundle get it), and nothing else.

| edge | installed (one-hop release) | this release |
|---|---|---|
| eu-central, us-west, ap-southeast `provider.mjs` | 378,619 `03cb11f6…95640d26` | 378,909 `2f18d800…24e30cd6` |
| ca-east `wg-provider.mjs` | 878,501 `0c201bd7…7ee130e8` | 878,964 `4a0d8d75…802cf42e` |

`signers-edges.sh activate` (installer `signers-edge-install.sh`, made from the one-hop installer: same guards, the
provider only, drop-in `zzzzzzz-signers.conf`, taken back by itself when the new process does not hold): ca-east
02:53Z, eu-central 03:01Z, us-west 03:03Z, ap-southeast 03:05Z; every name that answered through an edge before
answered after. `signers-edges.sh revert` puts the one-hop bundle back. The payload is outside the repository
(`provider-signers-20261116/payload` beside the one-hop payload).

Also set on each edge, with no restart (`systemctl set-property`, kept in `/etc/systemd/system.control`):
`enclave-network-provider` `CPUWeight=400`, `enclave-public-directory` `CPUWeight=20`. The directory uses 40% of an
edge's one processor (a `/v1/network/routes` request takes 4–6 s there, several a minute); that is not changed here,
only that it now waits behind the provider and the gateway. No installer in main makes the directory's unit.

**Checked.** The replacement text by itself against viem (`qualify/replacement-check.mjs`: same signer, remembered,
loop not held, both builds). The one-hop tunnel qualification with the new bundles as guard and exit, both ways
round: 17 of 17 lines each. On ca-east after the install, four test streams with the provider's main thread
sampled: no stretch flat out, and no whole-flow silence of the gateway away from the home line's own losses
(before: one in most 80-second runs, 350–620 ms).

**Not checked:** the three minified-build edges under a stream (the app's name led to ca-east in every run since).

## The same night: a third start got one lane

Three test streams within about 100 s: the third got 1 of 16 video lanes (`tunnel refused: 503`, the front's limit
of 32 tunnels a port) and dropped 1,637 frames in 78 s. A client that starts again comes from a new UDP port, and the
gateway kept the old association and its lanes until 90 s of silence, which the app's own sending postponed. Now an
association of the same client and app that the client has not written to for 5 s ends when a new one starts
(`gamestream.mjs`, `supersedeMs`; a live client writes twice a second on each port). Gateway bundle
`4ca5fffb…3ef0224b` on the four edges since 03:14Z (`ops/stream-flow-20261115/edges.sh activate`); four starts back
to back each got 16 of 16.
