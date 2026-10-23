# Dependencies and provenance

Every tool used is already installed on the desktop (Arch Linux packages). Nothing was downloaded or installed for this
work. The `sha256` column is the first 16 hex digits of the binary that ran.

| Tool | Package (pacman -Qo) | sha256 (first 16) | Used for |
|---|---|---|---|
| qemu-nbd | qemu-img 11.1.2-1 | b0f16ff7225e7846 | export server (desktop); `-c` kernel client (guest) |
| qemu-io | qemu-img 11.1.2-1 | 085e254e8a64b25c | userspace NBD/TLS client in the protocol tests |
| qemu-img | qemu-img 11.1.2-1 | 3a57bce6765bfb73 | `info` probe of the export size before attach |
| qemu-system-x86_64 | qemu-system-x86 11.1.2-1 (libslirp 4.9.5-1) | a2250f5e2b3b07c7 | throwaway KVM test guest |
| openssl | openssl 3.6.5-1 | 9b81b075be7cc0d3 | PKI, chain and EKU checks |
| python3 | python 3.14.8-1 | 375532f83be62028 | the tools (standard library only) |
| mkfs.ext4, e2fsck | e2fsprogs 1.47.4-1 | 0ad4756fd858ee0a, a9ea133a844edd69 | first format; read-only fsck |
| blkid, unshare, mount | util-linux 2.42.4-1 | blkid d6938b29863a3212, unshare e4e385ae4accf4af | signature/UUID checks; unprivileged test namespace |
| guest kernel | linux 7.2.11.arch1-1 (`/boot/vmlinuz-linux` sha256 7ca8265d776950dd; modules `nbd`, `virtio_net`, `failover`, `net_failover`, `9p` from that package) | | test guest only |
| TLS library | gnutls 3.8.13-3 (linked by qemu) | | |
| other | glibc 2.44, zstd 1.5.7-3, cpio 2.15-3 | | |

## Primary documentation consulted (installed with the packages)

- **`qemu-nbd(8)`**, qemu 11.1.2 (`/usr/share/man/man8/qemu-nbd.8.gz`):
  - `--tls-creds`, `--tls-authz` (an `authz-simple` identity, with commas doubled), `--tls-hostname`, `--bind`, `--shared`,
    `--persistent`, `--handshake-limit`, `--fork`, `--pid-file`, `-c/--connect`, `-d/--disconnect`.
  - The default kernel-client control socket is `/var/lock/qemu-nbd-DEVICE`.
- **`qemu(1)`**, `-object tls-creds-x509`:
  - `verify-peer` defaults to on, and for x509 this requires valid client certificates.
  - The file names are `ca-cert.pem`, `server-cert.pem`, `server-key.pem`, `client-cert.pem` and `client-key.pem`.

## Behaviour observed in this qemu 11.1.2 that differs from first assumptions

- **`authz-simple` DN order.** It compares the subject DN in certificate (forward) order: `O=Enclave RPC HDD,CN=...`.
  That is not the RFC 4514 reversed form that `certtool -i` prints. Source: the server's own log, "TLS x509 authz check
  for O=Enclave RPC HDD,CN=enclave-rpc-l1-client is denied", from run 1.
- **External DH parameters are deprecated.** A `dh-params.pem` file draws "Use of an external DH parameters file ... is
  deprecated". The tooling neither creates nor accepts one.
- **The client checks its own certificate first.** `qemu-io`/`qemu-img` refuse locally when their own client
  certificate has no issuer in their `ca-cert.pem` ("Cert '...' has no issuer in CA chain"). The rogue-client test
  therefore gives the client both CAs, so that the refusal under test is the server's.
