# Automatic gas refill activated, November 11 2026 UTC

- 20:02Z: `cli/gas-refill.mjs open` (release 17c84a55e1c6) offered the owner a refill grant over the owner's 7 NucBox deployments' 7 catalog apps: 10 USDC budget, 3 USDC and 12 refills per day, at most 0.0002 ETH and 1 USDC + 0.10 USDC fee per refill, 5,000 USDC/ETH cap, expiry 2027-02-09. Grant digest 0xcd307c13…bd6fe4.
- 20:07:51Z: the owner signed the grant and the 10 USDC deposit in the wallet; the relay's `/funding/open` landed tx 0xf51381fc82348e6dd3c645c526a3ca08c761cdcdf9271e80bc03136c41b13f02, proven on chain (session 0x7aef21e3…02ca6b, vault 0x86960ED8…F055a).
- 20:11:42Z: the user unit `enclave-gas-refill` (warden-host, release 37af082d2) paid its first refill: deployment 0xd9798e4c, 0.0002 ETH for 0.415733 USDC swap + 0.059873 USDC fee (tx 0x7ddc737121fa035a381efa9ec6abffca2faa1286941dc6bc3d95788e68f19ee9). The reserve read 0.000200591 ETH afterwards (~3 days of renewals); the session held 9.524394 USDC.
- The next refill waits until the previous one is final on Base: the first was proven final at 20:29:35Z (~18 minutes after it landed) and the service paid the second unattended at 20:29:50Z, deployment 0xa77d0c57, 0.0002 ETH for 0.415871 + 0.059860 USDC (tx 0xaa00b1f3d3f940317a10c66a61935da02b71421a5e12dfc8961acdf316720701). Refills therefore land about one per 20–25 minutes; the service checks every 5 minutes (`policy.intervalSec` 300).

At these prices one refill (~0.48 USDC) buys ~3 days for one app, so seven apps use ~1.1 USDC a day and the 10 USDC budget lasts about nine days. The owner extends it with a session top-up from the Dashboard (owner op `topUp`); the grant's daily caps are unchanged by a top-up.

## NucBox fence and VPN, metal0 operator and its apps (same day)

- 20:55Z: the owner removed LegacyTemplateFence's `Everyone ReadData Deny` from `C:\ProgramData\Enclave\shield\type1.vmgs` (applied 2026-10-31 23:11Z by the held native Windows RPC work; SDDL saved to `C:\ProgramData\Enclave\type1.vmgs.fence-acl-20261111.sddl`). The readiness witness partition started at 20:55:17Z. Earlier the same day the node had been repointed from the native router (127.0.0.1:8097, dead since the 11-10 reboot) to the Shield manager 127.0.0.1:8091 (backup `node-config.cmd.before-legacy-manager-20261111`).
- 20:54–21:08Z: Proton VPN, started on the NucBox at desktop login, routed all traffic through its tunnel and cut the host off from the `enclave-control` VM, so all of api.enclave.host was unreachable; refills paused. Disconnecting it restored the API.
- 21:19:40Z: metal0's operator 0xc9d0835c…e6ab, short of one `setProofKey` since the 11-02 reboot and EIP-7702-delegated to the lease executor (plain ETH sends revert), was funded 0.0001 ETH by the owner with a one-transaction self-destructing creation (`0x73<operator>ff`, tested on a Base fork: full value received, delegation unchanged). metal0 re-registered (tx 0x91bcbb6b4ccc28ac951ba7c51f443e70c5730f85f11cc99da3cfd83ef4b7d0cc), payout wallet the owner.
- 21:22:22Z: a second refill session for metal0's two apps (eyesoff-ai 0x9eb4e600, 0xda09d0f2; 3 USDC budget, 2 USDC and 6 refills per day) opened (tx 0x9c5c6a4f9baeaa5518e1b531521427870818186cd069a5a5742a20804582800f), run by `enclave-gas-refill@metal0`. First refill 21:23:02Z: 0x9eb4e600, 0.0002 ETH for 0.475592 USDC (tx 0x5afbc89e7e7c19ba05801eb87c84f8f9c0434b7c363dfb528477690de6926800).

Every metal0 reboot still needs one operator-paid `setProofKey`; paying it from a sponsor (as lease gas is) or persisting the proof key needs a new metal0 image.

## Routing the recovered apps (same day, 21:30–22:35Z)

- metal0's app guests died at start (`Could not open '/dev/vhost-vsock': No such device`): Warden runs kernel 7.2.11 but the 2026-11-06 upgrade to 7.2.14 removed its module tree. The owner `insmod`ed vhost_iotlb, vhost and vhost_vsock taken from the signature-verified cached `linux-7.2.11.arch1-1` package; guests then started (0xda09d0f2 serving 22:03Z, sia-s3 0xef514ed3 claimed by metal0 22:14Z). A reboot into 7.2.14 (which has nvidia, zfs, kvm-amd, vfio-pci, vhost_vsock) is still due.
- The NucBox privacy agent's `privacy-config.json` (written 10-27) also pointed at the native router 127.0.0.1:8097/8098; repointed to 8091/8092 at 22:09Z (backup `.before-legacy-manager-20261111`) and the Network task restarted. The relay's `/v1/network/routes` then routed all eight apps (previously the NucBox ones were `private_routes_unavailable`).
- 0x7ae476a3 was sticky in the NucBox's `blocked` list from a fence-era start failure; cleared with the node's forced claim-hint.
- Public Base RPCs rate-limited the hosts' shared address; the refiller now asks `https://api.enclave.host/rpc/base` first (2a000e456).
- 22:35Z: 0xda09d0f2, 0x7ae476a3, 0xd9798e4c, 0xa77d0c57, 0xa69dcbba and 0xef514ed3 answer 200 publicly. enclave-cron 0x38f368d6 and depot 0xc13d4b6a answer 503 "storage unavailable" (their storage is sia-s3, which now answers S3); 0x59f1273d needs a gas grant; 0x9a28642b needs the held native Windows manager; eyesoff-ai stays down (49.6 GiB guest).

## The two deployments left queued (2026-11-13)

0x59f1273d (enclavedns) and 0x9a28642b (kvm-box-native): `queued-apps-20261113/README.md`. A third refill session covers both; enclavedns runs since 20:20Z; kvm-box-native waits on the Shield manager loading the pinned desktop release.
