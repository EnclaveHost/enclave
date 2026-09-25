## Public data embedded in template/front (the production front, since the release client)

These are compiled into the measured front by `go:embed` and constants in isolation/m2/release/pins.go (build
`!releaselab`). The notices name them for completeness. They are not software, and no notice requirement was found
for them.

**Four CA root certificates**, as published by their CAs, which the relay's TLS certificate must chain to:

| file (isolation/m2/release/roots/) | subject | valid until | sha256 of the PEM | sha256 of the DER (= pins.go RootFingerprints) |
|---|---|---|---|---|
| isrg-root-x1.pem | C=US, O=Internet Security Research Group, CN=ISRG Root X1 | 2035-06-04 | 22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1 | 96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6 |
| isrg-root-x2.pem | C=US, O=Internet Security Research Group, CN=ISRG Root X2 | 2040-09-17 | a13d881e11fe6df181b53841f9fa738a2d7ca9ae7be3d53c866f722b4242b013 | 69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470 |
| sectigo-public-server-root-e46.pem | C=GB, O=Sectigo Limited, CN=Sectigo Public Server Authentication Root E46 | 2046-03-21 | 808130157f570b7640069852c88e256738007811a64c3aa9a4c31038347dc19c | c90f26f0fb1b4018b22227519b5ca2b53e2ca5b3be5cf18efe1bef47380c5383 |
| usertrust-ecc.pem | C=US, ST=New Jersey, L=Jersey City, O=The USERTRUST Network, CN=USERTrust ECC Certification Authority | 2038-01-18 | 08fb40ba4144166f6ae80c7ab60be23e97e5083836d45fa85a33a5d0bfec10f8 | 4ff460d54b9c86dabfbcfc5712e0400d2bed3fbc4d4fbdaa86e06adcd2a9ad7a |

**Enclave's own public data**, listed so the whole embedded set is visible:
- **The relay's release key:** Ed25519 public key d6c8a95966710fb52f4f753458362869ee26cf84aee08d27900c53a5b3fcc81d,
  keyId 06212e5df9c3779a (= sha256(key)[:16]). It is generated on nan, and its seed never leaves that host.
- **RelayHost:** api.enclave.host.
- **The ports:** TicketPort 9444 and EgressPort 9443.

The Go module graph of the front has no third-party modules. `go version -m` lists only enclave.host/isolation/m2 and
its in-repository replace enclave.host/isolation/contract, and neither go.mod requires anything else.
