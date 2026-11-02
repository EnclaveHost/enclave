# Public Ethereum L1 through the attested SEV-SNP RPC enclave (2026-11-02)

**Result:** `https://api.enclave.host/rpc/ethereum` answers from the production SNP enclave
`enclave-rpc-snp-prod-r5` (image rpc-snp-image-r6, measurement
`b04f00e00c6427fa340e3a2e73ed279e678fe6d41eff06286112f53322686274482b1690b4d1ce1a720c2f1ee0ba3076`).
Before this change the route returned `Unsupported network`.

## Path
public client → DigitalOcean SNI front → reverse tunnel → control VM caddy (:30443, `/rpc/ethereum` → :8190)
→ `enclave-rpc-gateway` (release `/opt/enclave-rpc/releases/f31815e1b`: rpc/gateway.mjs 7a043d5e…,
rpc/snp/attested-fetch.mjs 32d98987…, relay/snp-verify.mjs 93f9e9d2…)
→ attested-fetch to `https://192.168.8.249:18443` (the measurement above is the only allowed one; the TLS key must be the
SPKI bound in the SNP report; AMD VCEK→ASK→ARK) → Warden socat `enclave-rpc-snp-lan-forward-r1`
(bind 192.168.8.249:18443, `range=192.168.8.238/32`, the NUCBOX) → 127.0.0.1:18443 QEMU hostfwd → in-enclave front.py.

- `ethereum` has **no public fallback**: if attestation fails or the enclave is down, the route fails closed.
- `base` / `base-sepolia` upstreams are unchanged (credentialed and public providers, as before).

## Control VM changes (enclave-control)
- Added `/opt/enclave-rpc/releases/f31815e1b/` (files from `git archive f31815e1b`).
- Added `/etc/enclave-rpc/config.attested.json` = the existing config.json plus
  `upstreams.ethereum = ["https://192.168.8.249:18443/l1"]` and `attested`. The original config.json is unchanged.
- Added drop-in `/etc/systemd/system/enclave-rpc-gateway.service.d/50-attested-l1.conf` (LoadCredential and ExecStart
  point at those). **Rollback:** remove the drop-in, `systemctl daemon-reload`, `systemctl restart enclave-rpc-gateway`.
- Pre-switch test: a separate DynamicUser instance on :8191 returned ethereum `0x1`/`0x191b9ca` and base `0x2105`.

## Verification (UTC ~13:20)
- Public `eth_blockNumber`: ethereum `0x191b9cc`, base `0x32f1c02`.
- Public `finalized`: 26327436 `0x8cc4a34dabe45d78…`, identical to ethereum-rpc.publicnode.com.
- Enclave L1 at head since 11:03Z (EL syncing=false; beacon sync_distance 0, not optimistic).
- An established connection 192.168.8.238 → 192.168.8.249:18443 was observed while the public requests ran.

## Not yet durable
- `enclave-rpc-snp-prod-r5`, its local proxy and `enclave-rpc-snp-lan-forward-r1` are transient user units. They do not
  survive a Warden reboot until the user installs and enables them (persistent enable was refused to the agent).
- One site, one enclave; the enclave mints a new TLS key per boot (the gateway re-attests automatically).
- The user explicitly allowed the LAN forward on 2026-11-02.
