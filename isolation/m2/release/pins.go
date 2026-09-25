//go:build !releaselab

package release

// The PRODUCTION pins: the relay's name, the roots its certificate must chain to, and its release keys. They are
// compiled into the measured front. A lab build (-tags releaselab, pins_lab.go) replaces all three with lab values and
// is therefore a different image with a different measurement, which no relay's allowlist admits.

import _ "embed"

// RelayHost is the only origin a guest releases from. It is a constant compiled into the measured front, not a flag,
// a config value or anything guestd sends (enclave-99): a guest image that released from another relay would be a
// different binary, and so a different launch measurement.
const RelayHost = "api.enclave.host"

// TicketPort is the host (vsock CID 2) port guestd hands each guest its ticket on. A lab build uses a port of its own
// (pins_lab.go), so a lab guestd never holds a production port (enclave-d1).
const TicketPort = 9444

// The roots the relay's certificate must chain to, for the two issuers api.enclave.host's ACME client uses:
//   - Let's Encrypt: ISRG Root X1 and X2 (served 2026-09-25: YE1 -> Root YE -> ISRG Root X2 -> ISRG Root X1);
//   - ZeroSSL, Caddy's fallback issuer, whose failover a real Let's Encrypt outage has exercised: Sectigo Public Server
//     Authentication Root E46 and USERTrust ECC (served 2026-09-25 on *.app.enclave.host: ZeroSSL ECC DV SSL CA 2 ->
//     E46, cross-signed by USERTrust ECC).
//
// Since contract v1.2 TLS is NOT the config's integrity boundary: the relay signs every reply with a key pinned in
// this image (verify.go), so a certificate from a wrong CA can at worst deny a release, never forge one. The set is
// therefore sized for AVAILABILITY (both issuers, so one CA's outage does not stop every release), and kept to named
// roots rather than a whole system bundle. An issuer outside it fails closed: an outage, never a forgery. In particular
// ZeroSSL's RSA chain (Sectigo Public Server Authentication Root R46 / USERTrust RSA) is NOT pinned: Caddy's default key
// type is ECDSA, so its ZeroSSL fallback issues on the ECC chain above; an RSA certificate would fail every release
// closed until its root is added here (enclave-99).
var (
	//go:embed roots/isrg-root-x1.pem
	isrgRootX1 []byte
	//go:embed roots/isrg-root-x2.pem
	isrgRootX2 []byte
	//go:embed roots/sectigo-public-server-root-e46.pem
	sectigoE46 []byte
	//go:embed roots/usertrust-ecc.pem
	usertrustECC []byte
)

var embeddedRoots = [][]byte{isrgRootX1, isrgRootX2, sectigoE46, usertrustECC}

// RootFingerprints pins the embedded roots by the SHA-256 of their DER, so a changed PEM file fails a test rather
// than quietly widening what the guest trusts.
var RootFingerprints = []string{
	"96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6", // ISRG Root X1
	"69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470", // ISRG Root X2
	"c90f26f0fb1b4018b22227519b5ca2b53e2ca5b3be5cf18efe1bef47380c5383", // Sectigo Public Server Authentication Root E46
	"4ff460d54b9c86dabfbcfc5712e0400d2bed3fbc4d4fbdaa86e06adcd2a9ad7a", // USERTrust ECC Certification Authority
}

// relayReleaseKeys is the PINNED set of the relay's release keys: Ed25519 public keys, hex, compiled into the
// measured front (rule 4). A reply is trusted only if one of these signed it, so adding a key is an image change and a
// new measurement; a rotation ships {old, new} and later drops old.
//
// The production key was generated ON the api-relay host (nan) at 2026-09-25 18:38:21Z by enclave-63, under the
// custody rules (docs/security/attested-release.md, "Preconditions"). Its seed never leaves that host (the relay reads
// it from SECRETS_RELEASE_SIGNING_KEY_FILE). keyId 06212e5df9c3779a = sha256(public)[:16]. An empty set would make
// the front refuse every release before sending one, so no ticket is burned.
var relayReleaseKeys = []string{
	"d6c8a95966710fb52f4f753458362869ee26cf84aee08d27900c53a5b3fcc81d", // nan, 2026-09-25, keyId 06212e5df9c3779a
}
