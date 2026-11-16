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

## The NucBox on its Wi-Fi since 04:58:35Z

Done again with what the first attempt taught: the relay VM's resolver already on public servers, Wi-Fi connected
beside the Ethernet first (API and chain reads unchanged), then preferred (interface metric 20, its default route's
metric 0; Ethernet stays connected, 50 + 50). The relay VM kept its internet. Its four tunnels could not bind (the
edges held the sessions of the connections the change had cut) until those sessions were ended on the edges, by
process id and only those older than the change: tunnels active and `/rpc/base` answering at 05:00:50Z, about two
minutes after the change. The node stayed attached and admitted; no lease lapsed.

Six test streams of 78 s since (05:07–05:31Z; two more did not start, below): at the gateway no whole-flow silence
of 120 ms in any, and 7 datagrams passed over in all (before, on the powerline path: 3–8 silences and tens to
hundreds passed over a run). At the client 0–4 video and 0–6 audio loss events a run. The test client is this
workstation, which is still behind the powerline link: what the edge sends it crosses that link with no repair.

- **Not persistent by itself.** Windows does not connect Wi-Fi on its own while Ethernet is up, so after a reboot
  the NucBox is on Ethernet again (the state before tonight), until Wi-Fi is connected again.
- **Way back:** `Set-NetIPInterface -InterfaceAlias Wi-Fi -AddressFamily IPv4 -InterfaceMetric 900`, then
  `netsh wlan disconnect interface=Wi-Fi`, then end the stale tunnel sessions on the edges as above.
- **Open: a start right after another.** Starting the test client again within about a minute of the last stream
  often hangs at its first HTTPS request (port 47984: connected at the edge, no answer; the plain request on 47989
  answers), and works again after one to two minutes. Not understood. The test client is stopped by a signal, which
  the real Moonlight is not; not tried with it. The desktop's page terminal no longer answers (it stopped during
  the night; a command of mine that ended my two measurement scripts by pattern is the likely cause), so Sunshine's
  log could not be read.
- cron (0x38f368d6) is on metal0 since the first outage and answers some of the time.

## The stream without the internet: a local adapter (05:35Z on)

Moonlight and the NucBox are on the same local network, a fraction of a millisecond apart, and the stream went out
through an edge and back, twice across the home's powerline link. The RISC Box never did: its Moonlight adapter on the
workstation reaches the VM on the NucBox directly. The KVM Box now has the same road.

- `network/wg-provider/gamestream-local.mjs`: the gateway the edges run (`gamestream.mjs`, unchanged: port tunnels,
  UDP as a flow of lanes), started on the owner's machine and reaching the app's front at an address the operator
  gives, with the SHA-256 of the front's public key pinned. For a Shield partition on a Windows host both come from
  the host's manager (`GET /vms/<id>`: `relay.port`, `transportKeySha256`), the port forwarded over ssh. A front with
  another key is refused. Test: `test/wg-provider-gamestream-local.test.mjs`.
- `network/wg-provider/gamestream-local-install.sh` (bundle from `scripts/network/build-gamestream-local.mjs`): three
  user services on the machine Moonlight runs on: the ssh forward, the adapter, and a timer that follows the VM's
  port and key (a VM restart changes both). Installed on the workstation 05:48Z as `enclave-kvm-box-tunnel`,
  `enclave-kvm-box-moonlight`, `enclave-kvm-box-refresh.timer`; the adapter listens on `127.0.0.3`.
- What this road does not pass: the edges, the provider, the host's network agent and its lease and visitor checks.
  It is the operator's own access to a VM on their own host (ssh to the host, then the VM's loopback port), as the
  RISC Box adapter is. Sunshine's pairing still decides which Moonlight may stream. The adapter takes every client
  that reaches its address for this app's, so it is bound to a loopback address.

Measured with the no-display test client through it (960x600 at 6 Mbit/s for 78 s and 300 s, 1920x1080 at 20 Mbit/s
for 180 s and three times 120 s started 8 s apart): no video or audio loss event, no frame dropped, no key-frame
request in any run; nothing passed over at the adapter; audio 12 ms late at the median and 98 ms at the most; the
longest silence of all lanes 80 ms. Every start worked, also right after another.

**Not checked:** the user's own Moonlight (GUI) through `127.0.0.3`; a VM restart followed by the timer.
