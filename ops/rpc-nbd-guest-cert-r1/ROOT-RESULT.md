# RPC data-path credential: guest bootstrap certificate vs qemu-nbd, r1

Question: the guest's only TLS client credential is generated inside the guest by
rpcbootstrap/identity.go (self-signed Ed25519, constant CN "RPC attempt", not a CA,
private key never leaves the guest). The exporter (volume_export.py) instead expects
owner-CA-issued per-role client certificates (CN=rpc-client-<attempt>-<role>),
whose private keys would have to be delivered into the guest by the host. Can the
data path reuse the guest's own pinned credential?

Answer (qemu-nbd 11.1.2, GnuTLS, real TLS 1.3 mTLS + authz-simple): yes.
- listed-guest: ca-cert.pem = owner CA + exact guest DER, authz identity
  "CN=RPC attempt" -> STARTTLS + NBD_OPT_GO succeed. The owner CA must stay in the
  file because qemu-nbd verifies its own server certificate chain against it.
- same-dn-impostor: a different self-signed cert with the same DN -> refused
  ("The certificate is not trusted"). The DN is not the identity; the listed DER is.
- unlisted-guest: owner CA only -> refused.

Harness: existing frozen pattern (systemd-run 512M hard/no swap/CPU1/150s, taskset 1,
shared claude-test-queue 512 MiB, memory-guard 450 RSS / 27648 floor, authenticated
admission available 111564 / pending 0 / floor 18432, bwrap --unshare-all private
loopback). Exit 0, 31.7 s (cold build cache). 16 PASS: the 3 new subcases + parent
and the unchanged 12 from rpc-nbd-attach-r1. Frozen copy identical to source before
and after (PINS.json).

Consequence for the design: the exporter's per-role server trust file must hold the
owner CA plus the exact guest certificate already pinned by both storage signatures
(ClientCertificateSHA256), with authz "CN=RPC attempt". No host-delivered guest
private keys. Any certificate the owner CA itself issues with that DN would also be
accepted; that is the storage owner's own authority, not a third party.

NOT done: exporter/preparer changes to write that trust file, guest-side data
endpoint derivation, broker wiring, kernel attach/mount in the guest. No production
data, keys, exports, VMs or chain state were touched. Production RPC remains OFFLINE.
