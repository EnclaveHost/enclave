package bootstrap

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureOffer(t *testing.T, x storageRig) RPCBootstrapOffer {
	t.Helper()
	req, _ := json.Marshal(x.request)
	h := sha256.Sum256(req)
	var env map[string]json.RawMessage
	var pin commitment
	json.Unmarshal([]byte(x.auth.snapshot.row.envelope), &env)
	json.Unmarshal(env["guestBootstrap"], &pin)
	return RPCBootstrapOffer{Attempt: strings.Repeat("1", 32), Challenge: strings.Repeat("2", 64), ClientCertificateSHA256: strings.Repeat("3", 64), CredentialBlob: base64.StdEncoding.EncodeToString([]byte("synthetic")), Host: "127.0.0.1", HostNonce: base64.StdEncoding.EncodeToString(make([]byte, 32)), ManifestSHA256: pin.SHA256, Port: 1443, RequestSHA256: hex.EncodeToString(h[:]), Runtime: x.auth.manifest.RuntimeID, Schema: "enclave-rpc-owner-offer/1", Secret: base64.StdEncoding.EncodeToString([]byte("synthetic")), ServerCertificateSHA256: strings.Repeat("4", 64), ServerName: "localhost"}
}
func signedOffer(t *testing.T, o RPCBootstrapOffer, keys [2]ed25519.PrivateKey) []byte {
	t.Helper()
	p := RPCBootstrapOfferProof{Offer: o}
	sigs := []*string{&p.L1, &p.Base}
	for role := range keys {
		payload, e := RPCBootstrapOfferPayload(o, byte(role))
		if e != nil {
			t.Fatal(e)
		}
		*sigs[role] = hex.EncodeToString(ed25519.Sign(keys[role], payload))
	}
	raw, _ := json.Marshal(p)
	return raw
}
func TestOwnerEndpointOfferUsesBothCommittedAuthoritiesAndExactScope(t *testing.T) {
	x := newStorageRig(t)
	offer := fixtureOffer(t, x)
	raw := signedOffer(t, offer, x.keys)
	if got, e := x.auth.VerifyRPCBootstrapOffer(x.bundle, x.request, raw); e != nil || got != offer {
		t.Fatal(got, e)
	}
	for _, mode := range []string{"key", "role", "request", "runtime", "manifest", "endpoint", "missing", "duplicate", "trailing", "unknown"} {
		var p RPCBootstrapOfferProof
		json.Unmarshal(raw, &p)
		switch mode {
		case "key":
			p.L1 = strings.Repeat("0", 128)
		case "role":
			p.L1, p.Base = p.Base, p.L1
		case "request":
			p.Offer.RequestSHA256 = strings.Repeat("9", 64)
		case "runtime":
			p.Offer.Runtime = strings.Repeat("9", 64)
		case "manifest":
			p.Offer.ManifestSHA256 = strings.Repeat("9", 64)
		case "endpoint":
			p.Offer.Port++
		}
		bad, _ := json.Marshal(p)
		switch mode {
		case "missing":
			bad = []byte(`{"offer":` + string(mustOfferBytes(t, offer)) + `}`)
		case "duplicate":
			bad = append([]byte(`{"base":"",`), raw[1:]...)
		case "trailing":
			bad = append(raw, []byte("{}")...)
		case "unknown":
			bad = append([]byte(`{"permission":true,`), raw[1:]...)
		}
		if _, e := x.auth.VerifyRPCBootstrapOffer(x.bundle, x.request, bad); e == nil {
			t.Fatal(mode)
		}
	}
	x.auth.valid = false
	if _, e := x.auth.VerifyRPCBootstrapOffer(x.bundle, x.request, raw); e == nil {
		t.Fatal("revoked authority")
	}
}
func mustOfferBytes(t *testing.T, o RPCBootstrapOffer) []byte {
	t.Helper()
	b, e := o.Bytes()
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestOwnerEndpointJSVectorMatchesGoPayload(t *testing.T) {
	checkOwnerJSVector(t, "owner-offer-vector.json")
}
func TestOwnerEndpointStreamJSVectorMatchesGoPayload(t *testing.T) {
	checkOwnerJSVector(t, "owner-offer-v2-vector.json")
}
func checkOwnerJSVector(t *testing.T, name string) {
	dir := os.Getenv("RPC_BOOTSTRAP_VECTOR_DIR")
	if dir == "" {
		t.Fatal("actual owner JS vector required")
	}
	raw, e := os.ReadFile(filepath.Join(dir, name))
	if e != nil {
		t.Fatal(e)
	}
	var v struct {
		Proof      RPCBootstrapOfferProof `json:"proof"`
		PublicKeys []string               `json:"publicKeys"`
	}
	if e = json.Unmarshal(raw, &v); e != nil || len(v.PublicKeys) != 2 {
		t.Fatal(e)
	}
	for role, sigHex := range []string{v.Proof.L1, v.Proof.Base} {
		payload, e := RPCBootstrapOfferPayload(v.Proof.Offer, byte(role))
		if e != nil {
			t.Fatal(e)
		}
		key, _ := hex.DecodeString(v.PublicKeys[role])
		sig, _ := hex.DecodeString(sigHex)
		if !ed25519.Verify(key, payload, sig) {
			t.Fatal("JS/Go purpose payload differs", role)
		}
	}
}

func TestOwnerEndpointStreamProtocolCannotDowngrade(t *testing.T) {
	x := newStorageRig(t)
	o := fixtureOffer(t, x)
	o.Schema = "enclave-rpc-owner-offer/2"
	raw := signedOffer(t, o, x.keys)
	if got, e := x.auth.VerifyRPCBootstrapOffer(x.bundle, x.request, raw); e != nil || got != o {
		t.Fatal(got, e)
	}
	var proof RPCBootstrapOfferProof
	json.Unmarshal(raw, &proof)
	proof.Offer.Schema = "enclave-rpc-owner-offer/1"
	bad, _ := json.Marshal(proof)
	if _, e := x.auth.VerifyRPCBootstrapOffer(x.bundle, x.request, bad); e == nil {
		t.Fatal("unsigned downgrade accepted")
	}
	o.Schema = "enclave-rpc-owner-offer/3"
	if _, e := o.Bytes(); e == nil {
		t.Fatal("unknown negotiation")
	}
}
