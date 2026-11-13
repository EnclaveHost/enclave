# metal0 control image 66335ab: no proof-of-time checkpoints for a free lease

Status: **ACTIVE on metal0** since 2026-11-13 00:11:42Z (the operator ran `control-image.sh apply`). No checkpoint
has been posted for Enclave RPC since; see "The run".

## Why

metal0's operator key `0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB` pays the box's own transactions. The supervisor
posted a proof-of-time checkpoint for every lease it holds every `PROOF_INTERVAL_SEC` (300 s). Its only lease is
Enclave RPC (`0x5ff56a4d…454f`), which the owner's host runs for the owner at rate 0. A checkpoint advances
`provenUntil`; the ledger credits the runner rate × proven time, which at rate 0 is nothing, and nothing else reads
the watermark of a lease that pays nothing. Each one cost the key about 9e-7 ETH (151k gas), about 2.6e-4 ETH a day.
That emptied the key on 2026-11-12 (checkpoints refused from 03:51Z) and left too little for the registration the
14:47Z restart needed: metal0 held no lease from 15:04:39Z to 16:18:34Z (`../release-r13/README.md`). The owner's
0.001 ETH top-up at 18:09Z would be gone about 2026-11-16 at the same rate.

Main 1186ab801: the metal supervisor proves no lease whose mirrored rate is exactly 0 (steady clock and final
period), says so once per deployment, and measures the operator key's runway (`[gas] operator key … is low`, and
`operatorGas` on the host record). A paid lease, and one whose rate is not known, is proven as before. The Windows
node already followed the same rule (`windows/node/host.mjs` proveAll).

## The image

`/home/steven/enclave-prod/dist-snpvm-66335ab`, the tree of 16520ea with `metal/free-lease-proof-patch.py` applied
to the supervisor that image overlays (the patch's six anchors exist in both generations; `test/free-lease-proof.test.mjs`
checks that the deployed generation gets main's text).

| | 16520ea (previous) | 66335ab |
|---|---|---|
| initramfs sha256 | a6b7e1a7694087ef2e00c1f8d53d90923bd68aaaf1b55d7891a6451b7e3d51e0 | 1a6e0cf05e28fb983619df35e721f8455c84225e29852892076070b961679ae1 |
| launch measurement | a74528dc6910b64656f5c9e5126e2f4eb04b39232a5358c1248c206ea03a9fbe10c0a4d509f2d8d22ed08cea3e0ee1e8 | 5d91b40202371dd8ece935953f2d353d8587eda0e9c87f1772858077c8d1f6fae21f26e65e8c0cace007342ef63a536a |

Differences inside the initramfs, compared file by file: `/app/supervisor.js` (sha256 8f44ccea…5533, carries
`freeLease` and the snpVm paths, `node --check` clean) and the added `/app/windows/node/gas-runway.mjs`
(1c89eb29…a537). Kernel, kernel command line and firmware are the same files.

Built in a scratch clone at commit 66335ab (6b054e6 export, b4446c3 snpVm, 16520ea quorum, 66335ab this patch):

    python3 metal/overlay-control-image.py ~/enclave-prod/dist-leasegas-deabf8f90 ~/enclave-prod/dist-snpvm-66335ab HEAD

Measured with the command line metal0 launches with. The image's `cmdline` file is a template; the launcher fills
`${MODE}` with `snp`, and measuring the template as it stands gives a value no host ever reports:

    sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU \
      --ovmf ~/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd --kernel $D/vmlinuz --initrd $D/initramfs.cpio.gz \
      --append "$(sed 's/\${MODE}/snp/' $D/cmdline)" --output-format hex

The same command reproduces the two measurements the relay has accepted from this host: b4446c3 → c9fe2438…12d5 and
16520ea → a74528dc…e1e8. The relay accepted the new one from metal0's launch on 2026-11-13 00:11:56Z.

## Activating it

    ops/rpc-snp-prod-r7/control-image-66335ab/control-image.sh apply
    ops/rpc-snp-prod-r7/control-image-66335ab/control-image.sh rollback

`apply`, in order, stopping at the first thing that is not as expected:

1. the image on disk is the recorded one (initramfs hash, `MEASUREMENT`);
2. the operator key can pay a registration: balance read from public Base RPCs, refused below 2e-6 ETH or when it
   cannot be read (it held 9.93e-4 ETH at 18:53Z);
3. the relay's allowlist on the control VM gets the measurement (previous file kept as
   `linux-leasegas-measurements.env.before-snpvm-66335ab`, relay restarted); the running image's measurement stays;
4. metal0's config (`config.json`, kept as `config.json.before-snpvm-66335ab`) names the new image and
   `enclave-metal.service` is restarted; if the relay does not accept the new measurement within 5 minutes the
   previous image is put back;
5. it waits for the policy admission, the registration, the adoption of the running app, then for
   `[proof] no checkpoints for 0x5ff56a4d…: a free lease`, the next lease renewal (up to 35 minutes), and reports how
   many checkpoints were posted since the restart (none expected; one is possible if a round runs before the first
   audit pass has mirrored the rate), the app address and the key's balance.

The Enclave RPC guest is not restarted: the supervisor adopts the running VM by name, as on 2026-11-12 16:18Z.
One restart costs the key one registry transaction (3.2e-7 ETH at that day's fee). After it the key is spent only on
registry writes at starts.

## The run (2026-11-13, UTC)

| | |
|---|---|
| 00:10:14 | last renewal on 16520ea (until 00:40:13); 00:10:17 its last checkpoint |
| 00:11:42 | `enclave-metal.service` restarted on `dist-snpvm-66335ab` |
| 00:11:56 | `[agent] attest ACCEPTED meas=5d91b40202371dd8…`; `[host-policy] this host is ADMITTED` |
| 00:12:02 | `[registry] registered` (`0x622baa40…9671`, block 56691736, 3.0e-7 ETH); 00:12:03 price published (`0x8981fd64…362b`, 2.0e-7 ETH) |
| 00:12:55 | `[claim] … resuming our own live lease after a restart`; 00:13:00 `[snp-vm] 0x5ff56a4d: adopted VM svc5c9c7e782de8357, already running on this host` |
| 00:17:54 | `[proof] no checkpoints for 0x5ff56a4d…454f: a free lease (rate 0) has nothing to credit` |
| 00:36:01 | lease renewed until 01:06:00 (`0x9c7e1d42…94ba`, paid by the app's reserve) |

Checked at 00:36Z: no `checkpoint(s) landed` line and no proof error since the restart (the previous image posted
one every 300 s up to 00:10:17Z); the operator key held 935902623024987 wei at 00:12Z, 00:18Z and 00:36Z, unchanged
across the proof rounds; the app address answered 200; the guest was not restarted (QEMU started 2026-11-12
10:14:59Z still running). The relay's allowlist carries the measurement (previous file kept as
`linux-leasegas-measurements.env.before-snpvm-66335ab`), metal0's previous config is kept as
`config.json.before-snpvm-66335ab`. The restart cost the key 5.0e-7 ETH; what it holds pays for about 1,800 more.

## Not covered

- Nothing refills an operator key by itself; the runway warning is a journal line and a field on the host record,
  not a payment. A top-up remains `rpc/snp/owner-sign/topup-plan.mjs` and the owner's signature.
- `hostedSec` and the proof statistics of a free lease stop advancing; nothing prices or admits on them for a lease
  at rate 0.
- Other fleet hosts' control images are older generations and are not rebuilt here.
