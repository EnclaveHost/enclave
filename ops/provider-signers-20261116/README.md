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
`enclave-network-provider` `CPUWeight=400`. The public directory was first put behind it (`CPUWeight=20`, ca-east
02:29Z, the others 03:05Z) and is back at the default (100) since 03:26Z: the provider reads each owner's policy from
the directories with an 8 s limit while it answers a host's request, and a directory that waits for the processor
makes those requests time out (provider journal: `The operation was aborted due to timeout`, 03:25–03:35Z, when every
circuit of the NucBox asked again at once). The directory uses 40% of an edge's one processor (a
`/v1/network/routes` request takes 4–6 s there, several a minute); that is not changed here. No installer in main
makes the directory's unit.

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

## The outage of 03:26–04:21Z, caused by this night's work on the NucBox's uplink

Not part of this release, recorded here because it happened in the same session and cost every app on the NucBox.

- **What I did.** The NucBox's Ethernet reaches the home router over a powerline link that loses runs of packets
  every 10–25 s. Its Wi-Fi reaches the same router directly, and a two-path probe (500 datagrams a second by each,
  120 s, 03:22Z) lost 62 in 36 runs by Ethernet and 2 in one run by Wi-Fi. At 03:25:10Z I made Wi-Fi the preferred
  route (Ethernet left connected), and put it back at 03:29:37Z when the apps stopped answering.
- **What broke.** The relay (api.enclave.host) is a VM on the NucBox whose gateway and DNS server are the NucBox
  itself. After the change its resolver's AAAA lookups timed out (A lookups answered), every name lookup in the VM
  hung, and the relay could reach no chain RPC (`RPC upstream unavailable`). With no chain reads the relay refuses
  hosts' work: metal0's and the NucBox's circuits lost their grants, routes were withdrawn, the NucBox's node stopped
  mid-pass at 03:44:36Z and its apps' leases ran out. A restarted node (03:58Z) attached but stayed suspended
  (`owner-only starts SUSPENDED: no successful owner read within the grace`), for the same reason.
- **What ended it.** 04:15Z, in the relay's VM: `resolvectl dns eth0 1.1.1.1 9.9.9.9` (runtime only;
  `resolvectl revert eth0` or a restart of systemd-resolved undoes it). Chain reads answered at once, the NucBox
  was admitted at 04:15:47Z and claimed its apps again; all ten names answered at 04:21Z. The KVM Box's partition was
  never retired (its lease had 160 s left). cron moved to metal0 during the gap.
- **Left as it is.** The relay VM's resolver still points at the two public servers. The NucBox's Wi-Fi is
  disconnected, its interface metric is 900 (it was automatic) and the stale Wi-Fi default route has metric 0
  (as found).
- **For next time.** A change of the NucBox's uplink is a change under the relay: do it with the relay VM's resolver
  already on servers that do not depend on the NucBox, and watch `https://api.enclave.host/rpc/base` during it. The
  Wi-Fi path itself was not shown to be at fault; the measurement above stands.

## A second gap, 04:28–04:46Z, and where the stream's losses are

- **The relay's tunnels.** The relay VM reaches each edge by an ssh connection that forwards three ports back to it.
  After the first outage each edge still held an sshd session of a connection that had died on the VM's side (the
  edges' sshd has `ClientAliveInterval 0`), so the VM's new connections failed with `remote port forwarding failed for
  listen port 30443` and the tunnel units restarted every minute (16 times by 04:28Z). When the old sessions stopped
  carrying traffic the API was unreachable on all four edges. 04:35Z: I ended the sshd sessions that held the
  forwarded ports on each edge (by process id); the tunnels bound at once, the NucBox's apps answered again at
  04:46:56Z. Not changed: the edges' sshd settings. With a client-alive interval a dead session would let go of its
  ports within a minute.
- **The client's losses, with times.** The test client's log lines now carry a time (`test.sh`), and each loss is
  held against the home line's own losses in the same run (200 pings a second to the second router). Three runs of
  78 s after everything above (04:51–04:56Z): 26 loss events (5 video, 21 audio); 22 of them within 1.5 s of a
  home-line loss, 3 more within about 2 s of one, and one audio loss (04:54:52.9Z) 9 s from any. Whole-flow
  silences at the gateway: 8, all at a home-line loss. Apart from that one audio loss, nothing was found that is not the home line.
