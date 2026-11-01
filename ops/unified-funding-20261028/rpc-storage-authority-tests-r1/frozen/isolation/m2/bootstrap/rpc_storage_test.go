package bootstrap

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

type storageRig struct {
	auth    *Authorization
	bundle  []byte
	request contract.RPCStorageRequest
	keys    [2]ed25519.PrivateKey
	peers   []*peerFixture
	vectors vectors
	raw     string
}

func newStorageRig(t *testing.T) storageRig {
	t.Helper()
	r, peers, v, id, loaded := rig(t)
	x := storageRig{peers: peers, vectors: v}
	policy := RPCStorage{Schema: "enclave-rpc-storage-authorities/1"}
	for i, p := range []*RPCStorageAuthority{&policy.L1, &policy.Base} {
		pub, priv, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			t.Fatal(e)
		}
		x.keys[i] = priv
		p.PublicKey = hex.EncodeToString(pub)
		p.VolumeID = strings.Repeat([]string{"a", "b"}[i], 64)
	}
	m := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), SecretDeployment: v.ID, ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: strings.Repeat("1", 64), L1VolumeID: policy.L1.VolumeID, BaseVolumeID: policy.Base.VolumeID}}
	var err error
	x.bundle, err = contract.Build(m, []byte{0, 97, 115, 109, 13, 0, 1, 0})
	if err != nil {
		t.Fatal(err)
	}
	loaded.AppID = contract.AppID(x.bundle)
	var manifest Manifest
	if err = json.Unmarshal([]byte(v.Manifest), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.AppID = hex.EncodeToString(loaded.AppID[:])
	manifest.RPCStorage = &policy
	raw, _ := json.Marshal(manifest)
	x.raw = string(raw)
	for _, p := range peers {
		p.row.Store(commit(t, v.Row, v.Manifest, x.raw))
	}
	x.auth, err = r.Authorize(context.Background(), id, raw, loaded)
	if err != nil {
		t.Fatal(err)
	}
	x.request = contract.RPCStorageRequest{AppID: manifest.AppID, BaseVolume: policy.Base.VolumeID, Boot: "12345678-1234-1234-1234-123456789abc", Deadline: contract.RPCStartupNanoseconds + 100, Deployment: v.ID, L1Volume: policy.L1.VolumeID, Nonce: strings.Repeat("c", 64), Origin: 100, Profile: m.RPC.ProfileSha256, Schema: contract.RPCStorageRequestSchema}
	return x
}
func (x storageRig) proof(t *testing.T) []byte {
	t.Helper()
	l, b := strings.Repeat("d", 64), strings.Repeat("e", 64)
	payloads, e := x.auth.RPCStorageSigningPayloads(x.bundle, x.request, l, b)
	if e != nil {
		t.Fatal(e)
	}
	p := RPCStorageSignatures{Schema: "enclave-rpc-storage-consent/1", L1: RPCStorageSignature{WriterEpoch: l, Signature: hex.EncodeToString(ed25519.Sign(x.keys[0], payloads[0]))}, Base: RPCStorageSignature{WriterEpoch: b, Signature: hex.EncodeToString(ed25519.Sign(x.keys[1], payloads[1]))}}
	raw, _ := json.Marshal(p)
	return raw
}
func TestRPCStorageConsentRequiresBothIndependentSignatures(t *testing.T) {
	x := newStorageRig(t)
	raw := x.proof(t)
	c, e := x.auth.VerifyRPCStorage(x.bundle, x.request, raw)
	if e != nil || !c.Matches(x.request) {
		t.Fatal(e)
	}
	l, b, e := c.WriterEpochs(x.request)
	if e != nil || l == b || l != strings.Repeat("d", 64) {
		t.Fatal("epoch binding", l, b, e)
	}
	var p RPCStorageSignatures
	json.Unmarshal(raw, &p)
	p.Base.Signature = p.L1.Signature
	bad, _ := json.Marshal(p)
	if _, e = x.auth.VerifyRPCStorage(x.bundle, x.request, bad); e == nil {
		t.Fatal("cross-role consent accepted")
	}
	p.Base.Signature = strings.Repeat("00", 64)
	bad, _ = json.Marshal(p)
	if _, e = x.auth.VerifyRPCStorage(x.bundle, x.request, bad); e == nil {
		t.Fatal("missing authority accepted")
	}
	if _, e = (&Authorization{}).VerifyRPCStorage(x.bundle, x.request, raw); e == nil {
		t.Fatal("fabricated authorization")
	}
}
func TestRPCStorageSignedScopeCannotBeReplayed(t *testing.T) {
	for _, name := range []string{"app", "deployment", "profile", "l1", "base", "nonce", "boot", "deadline", "origin", "runtime", "owner", "chain", "ledger", "envelope", "key", "epoch"} {
		t.Run(name, func(t *testing.T) {
			x := newStorageRig(t)
			raw := x.proof(t)
			r := x.request
			switch name {
			case "app":
				r.AppID = strings.Repeat("2", 64)
			case "deployment":
				r.Deployment = "0x" + strings.Repeat("3", 64)
			case "profile":
				r.Profile = strings.Repeat("4", 64)
			case "l1":
				r.L1Volume = strings.Repeat("5", 64)
			case "base":
				r.BaseVolume = strings.Repeat("6", 64)
			case "nonce":
				r.Nonce = strings.Repeat("7", 64)
			case "boot":
				r.Boot = "22345678-1234-1234-1234-123456789abc"
			case "deadline":
				r.Deadline++
			case "origin":
				r.Origin++
				r.Deadline++
			case "runtime":
				x.auth.manifest.RuntimeID = strings.Repeat("8", 64)
			case "owner":
				x.auth.snapshot.row.owner = "0x" + strings.Repeat("9", 40)
			case "chain":
				x.auth.manifest.ChainID++
			case "ledger":
				x.auth.manifest.Ledger = "0x" + strings.Repeat("a", 40)
			case "envelope":
				x.auth.snapshot.row.envelope += " "
			case "key":
				x.auth.manifest.RPCStorage.L1.PublicKey = x.auth.manifest.RPCStorage.Base.PublicKey
			case "epoch":
				raw = []byte(strings.Replace(string(raw), strings.Repeat("d", 64), strings.Repeat("f", 64), 1))
			}
			if _, e := x.auth.VerifyRPCStorage(x.bundle, r, raw); e == nil {
				t.Fatal("changed signed scope accepted")
			}
		})
	}
}
func TestRPCStorageStrictProofAndOriginalClockShape(t *testing.T) {
	x := newStorageRig(t)
	raw := string(x.proof(t))
	for _, bad := range []string{raw + "{}", strings.Replace(raw, `"schema":`, `"schema":"enclave-rpc-storage-consent/1","schema":`, 1), strings.Replace(raw, `"l1":`, `"L1":`, 1), strings.Replace(raw, `"l1":`, `"unknown":1,"l1":`, 1), `null`, strings.Repeat("x", 2049)} {
		if _, e := x.auth.VerifyRPCStorage(x.bundle, x.request, []byte(bad)); e == nil {
			t.Fatal("ambiguous proof accepted")
		}
	}
	for _, mode := range []string{"overflow", "zero-boot", "bad-boot", "same-volume", "no-deployment"} {
		r := x.request
		switch mode {
		case "overflow":
			r.Origin = ^uint64(0) - 1
			r.Deadline = r.Origin + contract.RPCStartupNanoseconds
		case "zero-boot":
			r.Boot = "00000000-0000-0000-0000-000000000000"
		case "bad-boot":
			r.Boot = "12345678-1234-1234-1234-123456789abC"
		case "same-volume":
			r.BaseVolume = r.L1Volume
		case "no-deployment":
			r.Deployment = ""
		}
		if e := r.Validate(); e == nil {
			t.Fatal(mode)
		}
	}
}
func TestRPCStorageConsentExpiresAndRevokes(t *testing.T) {
	x := newStorageRig(t)
	raw := x.proof(t)
	c, e := x.auth.VerifyRPCStorage(x.bundle, x.request, raw)
	if e != nil {
		t.Fatal(e)
	}
	changed := x.request
	changed.Nonce = strings.Repeat("9", 64)
	if c.Matches(changed) {
		t.Fatal("consent rebound")
	}
	for _, p := range x.peers {
		p.row.Store(commit(t, x.vectors.Variants["owner"], x.vectors.Manifest, x.raw))
	}
	if e = x.auth.Revalidate(context.Background()); e == nil {
		t.Fatal("owner change ignored")
	}
	if c.Matches(x.request) {
		t.Fatal("revoked consent live")
	}
	x = newStorageRig(t)
	raw = x.proof(t)
	c, e = x.auth.VerifyRPCStorage(x.bundle, x.request, raw)
	if e != nil {
		t.Fatal(e)
	}
	x.auth.reader.now = func() time.Time { return time.Unix(x.vectors.Now+121, 0) }
	if c.Matches(x.request) {
		t.Fatal("stale consent live")
	}
}
func TestRPCStorageAuthorityCannotBeHostInjected(t *testing.T) {
	r, _, v, id, loaded := rig(t)
	raw := v.Manifest[:len(v.Manifest)-1] + `,"rpcStorage":{"schema":"enclave-rpc-storage-authorities/1","l1":{"volumeId":"` + strings.Repeat("a", 64) + `","publicKey":"` + strings.Repeat("1", 64) + `"},"base":{"volumeId":"` + strings.Repeat("b", 64) + `","publicKey":"` + strings.Repeat("2", 64) + `"}}}`
	if _, e := r.Authorize(context.Background(), id, []byte(raw), loaded); e == nil {
		t.Fatal("uncommitted authority accepted")
	}
	a, e := r.Authorize(context.Background(), id, []byte(v.Manifest), loaded)
	if e != nil {
		t.Fatal(e)
	}
	x := newStorageRig(t)
	if _, e = a.VerifyRPCStorage(x.bundle, x.request, x.proof(t)); e == nil {
		t.Fatal("legacy package gained storage permission")
	}
	for _, field := range []string{`null`, `{}`, `{"schema":"enclave-rpc-storage-authorities/1","l1":null,"base":null}`} {
		invalid := v.Manifest[:len(v.Manifest)-1] + `,"rpcStorage":` + field + `}`
		if _, e = r.Authorize(context.Background(), id, []byte(invalid), loaded); e == nil {
			t.Fatal("invalid authority selection")
		}
	}
}

func TestRPCStoragePolicyMatchesSDKVectors(t *testing.T) {
	var cases []struct {
		Name  string
		Raw   string
		Valid bool
	}
	b, e := os.ReadFile("testdata/rpc-storage-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, &cases); e != nil {
		t.Fatal(e)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			r, peers, v, id, loaded := rig(t)
			raw := v.Manifest[:len(v.Manifest)-1] + `,"rpcStorage":` + c.Raw + `}`
			for _, p := range peers {
				p.row.Store(commit(t, v.Row, v.Manifest, raw))
			}
			_, e := r.Authorize(context.Background(), id, []byte(raw), loaded)
			if (e == nil) != c.Valid {
				t.Fatalf("valid=%v: %v", c.Valid, e)
			}
		})
	}
}
