//go:build linux && amd64

package rpcbootstrap

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcstorage"
)

func publicOwnerFixture(t *testing.T, i *Identity, policy []byte) []byte {
	t.Helper()
	pub, _ := i.Public()
	rid, _ := contract.RuntimeID(pub.Runtime)
	server := []byte("explicit-synthetic-certificate")
	hash := func(b []byte) string { v := sha256.Sum256(b); return hex.EncodeToString(v[:]) }
	offer := bootstrap.RPCBootstrapOffer{Attempt: strings.Repeat("1", 32), Challenge: strings.Repeat("07", 32), ClientCertificateSHA256: hash(pub.Certificate), CredentialBlob: base64.StdEncoding.EncodeToString([]byte("synthetic")), Host: "127.0.0.1", HostNonce: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)), ManifestSHA256: hash([]byte("{}")), Port: 1443, RequestSHA256: pub.RequestSHA256, Runtime: hex.EncodeToString(rid[:]), Schema: "enclave-rpc-owner-offer/1", Secret: base64.StdEncoding.EncodeToString([]byte("synthetic")), ServerCertificateSHA256: hash(server), ServerName: "localhost"}
	// Producer transports public bytes; actual owner signatures are verified by
	// broker only after real chain Reader authorization. This fixture grants none.
	proof, _ := json.Marshal(bootstrap.RPCBootstrapOfferProof{Offer: offer, L1: strings.Repeat("0", 128), Base: strings.Repeat("0", 128)})
	raw, _ := json.Marshal(OwnerInputs{ExportServerDER: server, HostEvidence: json.RawMessage(`{"synthetic":true}`), Offer: proof, OwnerServerDER: server, Policy: policy})
	return raw
}
func TestOwnerInputProducerRetainsGuestEvidenceAndConsumesNamespace(t *testing.T) {
	var fs syscall.Statfs_t
	uid, e := os.ReadFile("/proc/self/uid_map")
	if e != nil || strings.Contains(string(uid), "4294967295") || syscall.Statfs("/run", &fs) != nil || fs.Type != 0x01021994 {
		t.Fatal("private qualification namespace required")
	}
	if _, e = os.Lstat("/run/native-rpc-owner"); !os.IsNotExist(e) {
		t.Fatal("owner namespace exists")
	}
	t.Cleanup(func() { os.RemoveAll("/run/native-rpc-owner") })
	i, _, bundle, policy := launchFixture(t, 5*time.Second)
	pub, _ := i.Public()
	ev := report(t, i)
	ev.Report[0] ^= 1
	ev.Certificate[0] ^= 1
	raw := publicOwnerFixture(t, i, policy)
	if e = i.InstallOwnerInputs(pub.Request.Boot, pub.RequestSHA256, raw, bundle); e != nil {
		t.Fatal(e)
	}
	stored, e := os.ReadFile("/run/native-rpc-owner/owner-bootstrap.json")
	if e != nil {
		t.Fatal(e)
	}
	in, e := rpcstorage.DecodeOwnerBootstrap(stored)
	if e != nil {
		t.Fatal(e)
	}
	var actual Evidence
	json.Unmarshal(in.Evidence, &actual)
	if string(actual.Report) != "synthetic-not-hardware" || !bytes.Equal(actual.Certificate, pub.Certificate) {
		t.Fatal("caller replaced retained evidence")
	}
	if !i.ownerPrepared {
		t.Fatal("producer did not publish complete gate")
	}
	if e = i.InstallOwnerInputs(pub.Request.Boot, pub.RequestSHA256, raw, bundle); e == nil {
		t.Fatal("owner input replay")
	}
	entries, e := os.ReadDir("/run/native-rpc-owner")
	if e != nil || len(entries) != 4 {
		t.Fatal("unexpected public files", e)
	}
	for _, entry := range entries {
		st, e := entry.Info()
		if e != nil || st.Mode().Perm() != 0600 {
			t.Fatal("public input mode", e)
		}
	}
}
func TestOwnerInputProducerRejectsSubstitutionAndPoisonsAttempt(t *testing.T) {
	for _, mode := range []string{"report", "request", "certificate", "unknown", "duplicate"} {
		t.Run(mode, func(t *testing.T) {
			i, _, bundle, policy := launchFixture(t, time.Second)
			pub, _ := i.Public()
			report(t, i)
			raw := publicOwnerFixture(t, i, policy)
			var in OwnerInputs
			json.Unmarshal(raw, &in)
			var p bootstrap.RPCBootstrapOfferProof
			json.Unmarshal(in.Offer, &p)
			switch mode {
			case "report":
				p.Offer.Challenge = strings.Repeat("9", 64)
			case "request":
				p.Offer.RequestSHA256 = strings.Repeat("9", 64)
			case "certificate":
				p.Offer.ServerCertificateSHA256 = strings.Repeat("9", 64)
			}
			in.Offer, _ = json.Marshal(p)
			raw, _ = json.Marshal(in)
			if mode == "unknown" {
				raw = append([]byte(`{"guestEvidence":{},`), raw[1:]...)
			}
			if mode == "duplicate" {
				raw = append([]byte(`{"policy":"",`), raw[1:]...)
			}
			if e := i.InstallOwnerInputs(pub.Request.Boot, pub.RequestSHA256, raw, bundle); e == nil {
				t.Fatal(mode)
			}
			if _, e := i.TakeCredential(); e == nil {
				t.Fatal("failed input left credential gate open")
			}
			if i.ownerPrepared {
				t.Fatal("failed input marked prepared")
			}
		})
	}
}
