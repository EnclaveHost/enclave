package bootstrap

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func exportFixture() RPCExportBinding {
	return RPCExportBinding{Host: "192.0.2.1", Port: 10902, ServerName: "storage.owner.example",
		ServerCertificateSHA256: strings.Repeat("1", 64), ClientCertificateSHA256: strings.Repeat("2", 64), ContractSHA256: strings.Repeat("3", 64)}
}

func (x storageRig) exportProof(t *testing.T, binding RPCExportBinding) []byte {
	t.Helper()
	l, b := strings.Repeat("d", 64), strings.Repeat("e", 64)
	payloads, e := x.auth.RPCExportSigningPayloads(x.bundle, x.request, l, b, binding)
	if e != nil {
		t.Fatal(e)
	}
	proof := RPCStorageSignatures{Schema: "enclave-rpc-storage-consent/2", Export: &binding,
		L1:   RPCStorageSignature{WriterEpoch: l, Signature: hex.EncodeToString(ed25519.Sign(x.keys[0], payloads[0]))},
		Base: RPCStorageSignature{WriterEpoch: b, Signature: hex.EncodeToString(ed25519.Sign(x.keys[1], payloads[1]))}}
	raw, _ := json.Marshal(proof)
	return raw
}

func TestRPCExportBothAuthoritiesBindEveryTransportField(t *testing.T) {
	x := newStorageRig(t)
	binding := exportFixture()
	raw := x.exportProof(t, binding)
	c, e := x.auth.VerifyRPCStorage(x.bundle, x.request, raw)
	if e != nil {
		t.Fatal(e)
	}
	b, e := c.ExportBinding(x.request)
	if e != nil || b == nil || *b != binding || c.NotAfter().IsZero() {
		t.Fatal(b, e)
	}
	b.Host = "203.0.113.1"
	again, _ := c.ExportBinding(x.request)
	if *again != binding {
		t.Fatal("mutable grant")
	}
	for _, field := range []string{"host", "port", "serverName", "serverCertificateSha256", "clientCertificateSha256", "contractSha256", "role-signature", "downgrade", "missing", "null", "unknown", "alias"} {
		t.Run(field, func(t *testing.T) {
			var p RPCStorageSignatures
			json.Unmarshal(raw, &p)
			switch field {
			case "host":
				p.Export.Host = "192.0.2.2"
			case "port":
				p.Export.Port++
			case "serverName":
				p.Export.ServerName = "other.owner.example"
			case "serverCertificateSha256":
				p.Export.ServerCertificateSHA256 = strings.Repeat("4", 64)
			case "clientCertificateSha256":
				p.Export.ClientCertificateSHA256 = strings.Repeat("5", 64)
			case "contractSha256":
				p.Export.ContractSHA256 = strings.Repeat("6", 64)
			case "role-signature":
				p.Base.Signature = p.L1.Signature
			case "downgrade":
				p.Schema = "enclave-rpc-storage-consent/1"
			case "missing", "null":
				p.Export = nil
			}
			bad, _ := json.Marshal(p)
			if field == "null" {
				bad = []byte(strings.TrimSuffix(string(bad), "}") + `,"export":null}`)
			}
			if field == "unknown" {
				bad = []byte(strings.Replace(string(bad), `"host":`, `"permission":true,"host":`, 1))
			}
			if field == "alias" {
				bad = []byte(strings.Replace(string(bad), `"host":`, `"Host":`, 1))
			}
			if _, e = x.auth.VerifyRPCStorage(x.bundle, x.request, bad); e == nil {
				t.Fatal("changed signed transport accepted")
			}
		})
	}
}

func TestRPCExportLegacyConsentCannotAuthorizeConnection(t *testing.T) {
	x := newStorageRig(t)
	raw := x.proof(t)
	c, e := x.auth.VerifyRPCStorage(x.bundle, x.request, raw)
	if e != nil {
		t.Fatal(e)
	}
	b, e := c.ExportBinding(x.request)
	if b != nil || e != nil {
		t.Fatal(b, e)
	}
	bad := []byte(strings.TrimSuffix(string(raw), "}") + `,"export":null}`)
	if _, e = x.auth.VerifyRPCStorage(x.bundle, x.request, bad); e == nil {
		t.Fatal("historical proof accepted new field")
	}
	x.auth.valid = false
	if _, e = c.ExportBinding(x.request); e == nil {
		t.Fatal("revoked binding usable")
	}
}

func TestRPCExportEndpointValidation(t *testing.T) {
	for _, host := range []string{"operator.example", "0.0.0.0", "224.0.0.1", "fe80::1", "::ffff:192.0.2.1", "192.000.002.1"} {
		b := exportFixture()
		b.Host = host
		if b.Validate() == nil {
			t.Fatal("bad endpoint", host)
		}
	}
	for _, name := range []string{"", "*.example", "UPPER.example", "-a.example", "a-.example", "a..example", "a.example.", strings.Repeat("a", 64)} {
		b := exportFixture()
		b.ServerName = name
		if b.Validate() == nil {
			t.Fatal("bad certificate name", name)
		}
	}
}
