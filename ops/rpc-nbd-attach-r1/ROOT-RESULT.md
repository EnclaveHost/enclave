# RPC guest NBD attach + root grant: component tests r1

Source: isolation/m3/rpcstorage/attach_linux_amd64.go, broker_grant_linux_amd64.go,
attach_test.go (pins in PINS.json, frozen copy unchanged before/after).

Harness: existing frozen pattern (systemd-run 512M hard/no swap/CPU1/150s, taskset 1,
shared claude-test-queue 512 MiB, memory-guard 450 RSS / 27648 floor, authenticated
admission read, bwrap --unshare-all uid0 private loopback). Exit 0, 2.68s.

12 PASS records: 9 qemu-nbd subcases + parent, ext4 identity table, grant refusals.
- valid: real qemu-nbd TLS1.3 mTLS + authz-simple, STARTTLS then NBD_OPT_GO, exact size,
  writable FLUSH/FUA; FUA write, flush, readback, DISC -> clean EOF.
- refused for the right reason: wrong export (0x80000006), wrong server name, foreign CA,
  unauthorized client DN (server closes), read-only export, wrong size, plaintext server
  (STARTTLS 0x80000002), stalled server (bounded by 1s deadline).
- ext4 superblock: exact UUID/magic/64-bit block count; wrong magic/UUID, oversize,
  zero blocks, bad block size refused.
- GrantRoots: refused before acknowledged+reserved+bound export and closes the session;
  non-ext4-root directories refused; one-shot even after refusal.

NOT covered: kernel NBD ioctl attach, DO_IT/proxy loss, detached ext4 mount and a
successful grant with real roots. Those need the measured guest kernel (no host root
here) and are the next qualification, inside a VM. No production data, keys, exports,
VMs or chain state were touched. Production RPC remains OFFLINE.
