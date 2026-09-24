# The guest inside a NucBox partition: interfaces

This is what the Windows manager's launcher talks to, and what a client reaches. The guest is the m3 monitor image
(`build-domain.sh`), one app per partition. The same kernel+initrd pair serves the HCS child partition, a
development vehicle, and the IGVM partition. hv_sock is the only channel. Owner of these files: the guest-runtime
lane. Owner of everything on the host and under `windows/`: the Windows lane (enclave-d1).

**Trust, stated once:** there is no SEV-SNP, VMPL or TEE on this box. Reports are signed by the launcher in the
root partition (tier `T0-hv`), and the host is **not** excluded. The best verdict is `monitor-signed`, never
`attested`. An IGVM partition does not change this until an attestation for it exists: the format
`hyperv-vbs-partition-v1` is reserved and not defined.

## Boot

Kernel command line: `console=ttyS0 rdinit=/init loglevel=3 report_host=9001`. The console then shows

```
MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a partition=hcs-child host_excluded=no
MON ready control_port=9000 snp=false
```

(`partition=hcs-child` is fixed text in report-host mode; it prints on a local KVM run too.)

## Channels (vsock ports; hv_sock service ids `<port>-facb-11e6-bd58-64006a7986d3` on Hyper-V)

| port | who listens | what |
|---|---|---|
| 9000 | guest | control. One JSON line per command. `{"cmd":"load","label":L,"size":N}` followed by exactly N bytes of the bundle; the answer is one JSON line, `{"id","label","appSha256","port","uid","cpuPercent","memMiB","mode","http"?}` or `{"error"}`. The monitor hashes the bytes it received (the AppID); the host must compare that with its own hash and end the partition on any difference. Also `list`, `state`, `{"cmd":"stop","id"}`, `{"cmd":"destroy","id"}`. |
| 9001 | **host** | report signing. The guest sends `{"abi","reportData":<128 hex>}` and receives `{"report":{"doc","sig"}}` or `{"error"}`. The launcher signs only an app half it loaded into that partition. |
| `port` from the load answer (40000 + id) | guest | the domain's TLS, ciphertext only. The host relays bytes; TLS ends in the domain's front. |

## Modes: how an app runs, decided by the bundle the monitor hashed, never by the request

- `serve`: a wasi:http component (enclave-catalog-bundle/1). `wasmtime serve -S cli` on the domain's own
  127.0.0.1:8080.
- `run`: a wasi:cli command with its one http port N (enclave-catalog-bundle/2). `wasmtime run -S cli -S tcp -S udp
  -S inherit-network -S allow-ip-name-lookup -C cache=n --dir /data::/data --env ENCLAVE_PORTS=http:N=N`. /data is a
  64 MiB tmpfs owned by the domain's uid, lost when the domain ends. The domain's network namespace has only its
  loopback. These are the Linux SNP tier's semantics (m2/dominit.c).

## What the domain's TLS answers (isolation/m2/front)

| path | answer |
|---|---|
| `GET /.well-known/enclave-attestation?nonce=<64 hex>` | `{tier:"T0-hv", format:"hyperv-partition-domain/v1", report:<base64 of the launcher-signed JSON>, transportKey, appSha256, nonce, abi:"enclave-domain-abi/2", runtime, runtimeSelfTest}`. Judge it with `windows/vbslike/verify/judge-hv.mjs` against YOUR handshake's key and nonce, and pin the runtime (`expectRuntime`). The branch copy of judge-hv must be the ABI/2 one (windows/custom-vbs-like-hyperv 67762434); the older ABI/1-only copy rejects every document from this image on the binding. |
| `GET /.well-known/enclave-ready` | `200 {"ready":true,"appId","mode","port"}` once a TCP connect to the app's port succeeds, `503 {"ready":false,"why"}` before. |
| `GET /.well-known/enclave-csr`, `POST /.well-known/enclave-cert` | refused: a partition has no SNP HOST_DATA, so the domain has no deployment name and serves only its self-signed certificate. A browser-trusted name for a partition needs a name source that is not built yet. |
| anything else | the app, as plaintext on the domain's loopback. No `X-Forwarded-For` (none added, and a client's is removed): no client address reaches a domain. The client's Host header is kept. |

**Running** = the document verified on THIS handshake's key with a fresh nonce (verdict `monitor-signed`), AND
`enclave-ready` 200 on a session with the same key, within a deadline. Anything else is failed, with the reason.

## Not in the guest

App config, secrets, outbound network (no NIC), volumes, GPU, persistent storage, tcp/udp/tls ports, and a second
http port. The monitor refuses what the manager should already have refused. A `/2` bundle whose world or port is
malformed does not parse, so it has no identity and is refused at `load`.

## Local validation, before anything reaches the box

`test-hv-local.sh <workdir> <hello.bundle> <hookbin.bundle> <judge-hv.mjs>` boots this image as two plain KVM guests
on warden-host. It stands in for the launcher with `hvlab.py` (sign on host vsock 9001 under the launcher's rule,
`load`, relay) and checks from outside with `hvlab-check.mjs`. 2026-09-24: 13/13 (`hv-local-check-2026-09-24.txt`).
It is KVM with virtio vsock and the distribution kernel, **not Hyper-V**. It shows the guest runtime works; it shows
nothing about the partition boundary.
