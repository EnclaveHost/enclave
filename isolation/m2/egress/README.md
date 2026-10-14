# Per-app HTTPS egress

The measured guest derives its network policy from the owner's authenticated,
sealed deployment config. A missing `egress` field permits only HTTPS origins
found in that config. An array such as `"egress":["https://api.example.com"]`
replaces that derived list. The pinned release relay remains reachable.

Apps that accept arbitrary URLs, including eyesoff-ai's `request` tool, need
an explicit capability for destinations that are not known at startup:

```json
{"egress":"public-https"}
```

This mode allows `wasi:http` requests to public DNS hostnames on HTTPS port 443.
The runtime sends the hostname through the guest's SOCKS forwarder; it does
not need a DNS entry in the guest's static `/etc/hosts`. This restores ordinary
page reads, redirects between public HTTPS origins, and HTTPS API requests.
It does not proxy through a search provider or disclose request bodies to a
new service. Requests still leave from the host's existing egress path.

The owner config is the only opt-in. Tool names, request bodies and the host
cannot enable it. The front starts and audits the listener before telling
init to enable the runtime's existing SOCKS transport. The static credential
is local protocol framing, not an authentication boundary. The app remains
unprivileged and cannot open vsock or inspect the front's memory.

The host's existing CID admission, dial quotas, final DNS-address checks and
peer-address checks still apply. Private, loopback, link-local, metadata,
CGNAT and host-owned addresses remain refused. The guest accepts only SOCKS5
CONNECT for a validated DNS name on port 443. TLS is verified by the runtime
against the requested hostname and is not terminated by either forwarder.
Plain HTTP, other ports, IP literals, SOCKS BIND and UDP are unsupported.
The host can observe destination names, addresses, timing and volume; logs
contain only bounded outcome codes. This mode grants the app more public
network reach than a fixed allowlist; it is appropriate only when the owner
intends that capability.

Existing deployments retain their policy unless their owner changes it. A
runtime without this feature rejects the new config value. Enabling it needs
both a runtime release containing the public forwarder and an owner config
update/restart. Keep all other config and envelope fields intact.

Tests: `go test -race ./egress ./front` from `isolation/m2`, plus
`sh isolation/m2/test-dominit-handoff.sh` from the repo root. The optional
`TestPublicHTTPSWasiHTTP` test accepts `EGRESS_WASMTIME` and
`EGRESS_EYESOFF_WASM` pointing to the actual runtime and eyesoff-ai component.
It reads public pages with HTTP pooling enabled and confirms HTTP port 80 is
refused; it performs no inference and uses no production credentials.
