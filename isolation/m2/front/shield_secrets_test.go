package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"enclave.host/isolation/m2/release"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http/httptest"
	"testing"
	"time"
)

type secretSink struct {
	bytes.Buffer
	closed bool
}

func (s *secretSink) Close() error { s.closed = true; return nil }
func secretFixture(t *testing.T) (*front, *secretSink, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	key, e := release.NewSealKey()
	if e != nil {
		t.Fatal(e)
	}
	id, _ := release.ID("0x" + hex.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	var nonce [32]byte
	rand.Read(nonce[:])
	pipe := &secretSink{}
	return &front{secrets: &shieldSecrets{id: id, text: "0x" + hex.EncodeToString(id[:]), key: key, nonce: nonce, until: time.Now().Add(time.Minute), pipe: pipe, pins: []ed25519.PublicKey{pub}}}, pipe, priv
}
func sealForTest(t *testing.T, s *shieldSecrets, signer ed25519.PrivateKey, plain map[string]any) map[string]string {
	t.Helper()
	eph, e := ecdh.X25519().GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pub, e := ecdh.X25519().NewPublicKey(s.key.Public())
	if e != nil {
		t.Fatal(e)
	}
	shared, e := eph.ECDH(pub)
	if e != nil {
		t.Fatal(e)
	}
	info := append([]byte("enclave-secrets-release-v1 seal\n"), s.id[:]...)
	info = append(info, eph.PublicKey().Bytes()...)
	info = append(info, s.key.Public()...)
	key, e := hkdf.Key(sha256.New, shared, s.nonce[:], string(info), 32)
	if e != nil {
		t.Fatal(e)
	}
	block, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(block)
	iv := make([]byte, 12)
	rand.Read(iv)
	pt, _ := json.Marshal(plain)
	sealed := append(eph.PublicKey().Bytes(), iv...)
	sealed = g.Seal(sealed, iv, pt, nil)
	digest, _ := release.ResponseDigest(s.id, s.nonce, s.key.Public(), sealed)
	sig := ed25519.Sign(signer, digest[:])
	return map[string]string{"nonce": hex.EncodeToString(s.nonce[:]), "sealed": base64.StdEncoding.EncodeToString(sealed), "sig": base64.StdEncoding.EncodeToString(sig), "keyId": release.KeyID(signer.Public().(ed25519.PublicKey))}
}
func postSecret(f *front, b map[string]string) int {
	raw, _ := json.Marshal(b)
	r := httptest.NewRequest("POST", shieldSecretsPath, bytes.NewReader(raw))
	w := httptest.NewRecorder()
	f.serveShieldSecrets(w, r)
	return w.Code
}
func TestShieldSecretInstallAuthenticatesThenWritesPipeOnce(t *testing.T) {
	f, sink, priv := secretFixture(t)
	plain := map[string]any{"id": f.secrets.text, "config": nil, "secrets": map[string]string{"API_KEY": "synthetic-value"}, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	b := sealForTest(t, f.secrets, priv, plain)
	wrong := map[string]string{}
	for k, v := range b {
		wrong[k] = v
	}
	wrong["sig"] = base64.StdEncoding.EncodeToString(make([]byte, 64))
	if postSecret(f, wrong) != 403 || sink.Len() != 0 {
		t.Fatal("untrusted release wrote plaintext")
	}
	if postSecret(f, b) != 200 || !sink.closed || sink.String() != `{"API_KEY":"synthetic-value"}` {
		t.Fatal("valid release did not reach only private pipe")
	}
	if postSecret(f, b) != 409 {
		t.Fatal("replay accepted")
	}
}
func TestShieldReleaseRejectsWrongTenantExpiredConfigAndNativeControls(t *testing.T) {
	for _, kind := range []string{"tenant", "expired", "config", "native"} {
		t.Run(kind, func(t *testing.T) {
			f, sink, priv := secretFixture(t)
			p := map[string]any{"id": f.secrets.text, "config": nil, "secrets": map[string]string{"API_KEY": "ok"}, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano)}
			switch kind {
			case "tenant":
				p["id"] = "0x" + hex.EncodeToString(bytes.Repeat([]byte{8}, 32))
			case "expired":
				p["issuedAt"] = time.Now().Add(-5 * time.Minute).UTC().Format(time.RFC3339Nano)
			case "config":
				p["config"] = map[string]string{"x": "unmeasured"}
			case "native":
				p["secrets"] = map[string]string{"LD_PRELOAD": "/evil"}
			}
			if postSecret(f, sealForTest(t, f.secrets, priv, p)) != 403 || sink.Len() != 0 {
				t.Fatal("invalid release accepted")
			}
		})
	}
}

var _ io.WriteCloser = (*secretSink)(nil)
