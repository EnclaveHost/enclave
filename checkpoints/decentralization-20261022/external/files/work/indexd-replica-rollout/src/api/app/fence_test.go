package app_test

// FENCING PATCH tests (work/indexd-fencing-implementation-interface.txt): the fence endpoints, the signed sf
// credential and the sequence/current listings over real HTTP against a real store (PostgreSQL).

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/api/app"
	"go.sia.tech/indexd/hosts"
	"go.sia.tech/indexd/sharing"
	"go.sia.tech/indexd/slabs"
	"go.sia.tech/indexd/testutils"
	"go.sia.tech/jape"
	"go.uber.org/zap"
	"lukechampine.com/frand"
)

func apiFence(gen, counter uint64, iid byte) accounts.Fence {
	var f accounts.Fence
	binary.BigEndian.PutUint64(f[:8], gen)
	binary.BigEndian.PutUint64(f[8:16], counter)
	for i := 16; i < 32; i++ {
		f[i] = iid
	}
	return f
}

type fenceAPI struct {
	t       *testing.T
	cluster *testutils.Cluster
	sk      types.PrivateKey
	client  *app.Client
	hk      types.PublicKey
	slab    slabs.SlabPinParams
}

// newFenceAPI starts an indexer without hosts and an account with one slab pinned directly in the store.
func newFenceAPI(t *testing.T) *fenceAPI {
	cluster := testutils.NewCluster(t, testutils.WithHosts(0), testutils.WithLogger(zap.NewNop()))
	f := &fenceAPI{t: t, cluster: cluster, client: cluster.Indexer.App}
	f.sk = cluster.AddAccount(t)
	f.hk = types.GeneratePrivateKey().PublicKey()
	cluster.Indexer.Store().AddTestHost(t, hosts.Host{PublicKey: f.hk})
	// a formed contract makes the host good for pinning (no real host: the slab is only ever listed)
	rev := types.V2FileContract{HostPublicKey: f.hk, Capacity: 200, Filesize: 100, FileMerkleRoot: types.Hash256{1}, ProofHeight: 600,
		ExpirationHeight: 800, RevisionNumber: 1, TotalCollateral: types.Siacoins(100)}
	if err := cluster.Indexer.Store().AddFormedContract(f.hk, types.FileContractID(f.hk), rev, types.ZeroCurrency, types.ZeroCurrency, types.ZeroCurrency, proto.Usage{}); err != nil {
		t.Fatal(err)
	}
	f.slab = slabs.SlabPinParams{EncryptionKey: frand.Entropy256(), MinShards: 1, Sectors: []slabs.PinnedSector{{Root: frand.Entropy256(), HostKey: f.hk}}}
	if _, err := cluster.Indexer.Store().PinSlabs(proto.Account(f.sk.PublicKey()), time.Time{}, f.slab); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fenceAPI) object(i int) slabs.SealedObject {
	o := slabs.SealedObject{
		EncryptedDataKey:     frand.Bytes(72),
		EncryptedMetadataKey: frand.Bytes(72),
		EncryptedMetadata:    frand.Bytes(20),
		DataSignature:        types.Signature(frand.Bytes(64)),
		MetadataSignature:    types.Signature(frand.Bytes(64)),
		Slabs:                []slabs.SlabSlice{f.slab.Slice(uint32(i), 1)},
	}
	o.Sign(f.sk)
	return o
}

// rawResp is a raw HTTP response.
type rawResp struct {
	status int
	ctype  string
	body   string
}

func (f *fenceAPI) do(method, route string, body []byte, rawQuery string) rawResp {
	f.t.Helper()
	u, r, err := app.Sign(f.sk, time.Now().Add(time.Minute), method, f.cluster.Indexer.AppURL+route+rawQuery, body)
	if err != nil {
		f.t.Fatal(err)
	}
	return f.send(method, u, r)
}

func (f *fenceAPI) send(method string, u *url.URL, body io.Reader) rawResp {
	f.t.Helper()
	req, err := http.NewRequestWithContext(f.t.Context(), method, u.String(), body)
	if err != nil {
		f.t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return rawResp{resp.StatusCode, resp.Header.Get("Content-Type"), strings.TrimSpace(string(b))}
}

// signRaw builds a signed URL over an explicit hash, so tampering can be shown.
func (f *fenceAPI) signRaw(method, route string, validUntil time.Time, hash types.Hash256, query url.Values) *url.URL {
	u, err := url.Parse(f.cluster.Indexer.AppURL + route)
	if err != nil {
		f.t.Fatal(err)
	}
	pk := f.sk.PublicKey()
	sig := f.sk.SignHash(hash)
	q := u.Query()
	for k, v := range query {
		q[k] = v
	}
	q.Set("sv", fmt.Sprint(validUntil.Unix()))
	q.Set("sc", base64URL(pk[:]))
	q.Set("ss", base64URL(sig[:]))
	u.RawQuery = q.Encode()
	return u
}

func base64URL(b []byte) string { return base64.URLEncoding.EncodeToString(b) }

func (f *fenceAPI) raise(fence accounts.Fence) accounts.Credential {
	f.t.Helper()
	resp, err := f.client.RaiseFence(f.t.Context(), f.sk, fence)
	if err != nil {
		f.t.Fatal(err)
	} else if resp.Fence != fence {
		f.t.Fatalf("raised %v, installed %v", fence, resp.Fence)
	}
	return resp.Credential()
}

func assertRefusal(t *testing.T, r rawResp, want *accounts.Fence) {
	t.Helper()
	if r.status != http.StatusConflict || !strings.HasPrefix(r.ctype, "application/json") {
		t.Fatalf("expected a 409 JSON refusal, got %d %q %q", r.status, r.ctype, r.body)
	}
	var body map[string]*string
	if err := json.Unmarshal([]byte(r.body), &body); err != nil {
		t.Fatalf("refusal body %q: %v", r.body, err)
	}
	got, ok := body["fence"]
	switch {
	case !ok:
		t.Fatalf("refusal body has no fence member: %q", r.body)
	case want == nil && got != nil:
		t.Fatalf("expected fence null, got %q", *got)
	case want != nil && (got == nil || *got != want.String()):
		t.Fatalf("expected fence %v, got %q", want, r.body)
	}
}

func clientRefusal(t *testing.T, err error, want *accounts.Fence) {
	t.Helper()
	var he *app.HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("expected an HTTP error, got %v", err)
	}
	assertRefusal(t, rawResp{status: he.StatusCode, ctype: "application/json", body: he.Body}, want)
}

func TestFenceAPIRaiseAndState(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()

	st, err := f.client.Fence(ctx, f.sk)
	if err != nil || st.Fence != nil || st.ReceiptSHA256 != nil || st.Seq != 0 {
		t.Fatalf("fresh: %+v %v", st, err)
	}
	if r := f.do(http.MethodGet, "/fence", nil, ""); r.body != `{"fence":null,"receiptSha256":null,"seq":0}` {
		t.Fatalf("fresh GET /fence body %q", r.body)
	}

	f1 := apiFence(17<<48, 1, 0xa1)
	resp := f.do(http.MethodPost, "/fence", []byte(`{"fence":"`+f1.String()+`"}`), "")
	if resp.status != http.StatusOK {
		t.Fatalf("raise: %d %q", resp.status, resp.body)
	}
	var installed struct {
		Fence   string `json:"fence"`
		Receipt string `json:"receipt"`
		Seq     uint64 `json:"seq"`
	}
	if err := json.Unmarshal([]byte(resp.body), &installed); err != nil || installed.Fence != f1.String() || len(installed.Receipt) != 32 {
		t.Fatalf("raise body %q", resp.body)
	}
	receipt, _ := hex.DecodeString(installed.Receipt)
	digest := sha256.Sum256(receipt)
	if r := f.do(http.MethodGet, "/fence", nil, ""); !strings.Contains(r.body, `"receiptSha256":"`+hex.EncodeToString(digest[:])+`"`) || strings.Contains(r.body, installed.Receipt) {
		t.Fatalf("GET /fence after raise %q", r.body)
	}

	// equal and lower raises: 409 naming the installed fence
	assertRefusal(t, f.do(http.MethodPost, "/fence", []byte(`{"fence":"`+f1.String()+`"}`), ""), &f1)
	assertRefusal(t, f.do(http.MethodPost, "/fence", []byte(`{"fence":"`+apiFence(17<<48, 0, 0xff).String()+`"}`), ""), &f1)

	// malformed bodies: 400, nothing installed
	hexF := f1.String()
	for _, body := range []string{
		`{}`, `{"fence":null}`, `not json`, `{"fence":"` + strings.ToUpper(hexF) + `"}`, `{"fence":"0x` + hexF[2:] + `"}`,
		`{"fence":"` + hexF[:63] + `"}`, `{"fence":"` + hexF + `0"}`, `{"fence":"` + apiFence(1<<63, 0, 0).String() + `"}`,
		`{"fence":"` + apiFence(18<<48, 1<<63, 0).String() + `"}`,
	} {
		if r := f.do(http.MethodPost, "/fence", []byte(body), ""); r.status != http.StatusBadRequest {
			t.Fatalf("body %q: expected 400, got %d %q", body, r.status, r.body)
		}
	}
	if st, _ := f.client.Fence(ctx, f.sk); *st.Fence != f1 || *st.ReceiptSHA256 != accounts.ReceiptDigest(digest) {
		t.Fatal("a refused raise changed the fence")
	}
}

func TestFenceAPICredentialChecks(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	f1 := apiFence(16<<48, 1, 1)
	c1 := f.raise(f1)
	f2 := apiFence(16<<48, 2, 1)
	c2 := f.raise(f2)

	fenced := f.client.WithFence(&c2)
	obj := f.object(1)
	if err := fenced.PinObject(ctx, f.sk, obj); err != nil {
		t.Fatalf("pin with the exact credential: %v", err)
	}
	// every mutation route: stock client, stale, higher, wrong receipt -> 409 {fence: f2}
	higher := accounts.Credential{Fence: apiFence(16<<48, 3, 1), Receipt: c2.Receipt}
	wrong := accounts.Credential{Fence: f2, Receipt: c1.Receipt}
	nonce := sharing.Nonce(frand.Bytes(32))
	sharePriv := sharing.DeriveSharingKey(f.sk, nonce)
	sk := sharing.KeyRequest{PublicKey: sharePriv.PublicKey(), Nonce: nonce}
	sk.Sign(sharePriv)
	sharedReq := sharing.SharedObjectRequest{ObjectID: obj.ID(), EncryptedDataKey: frand.Bytes(sharing.EncryptionKeySize)}
	sharedReq.Sign(sharePriv)
	for _, c := range []*app.Client{f.client, f.client.WithFence(&c1), f.client.WithFence(&higher), f.client.WithFence(&wrong)} {
		clientRefusal(t, c.PinObject(ctx, f.sk, f.object(2)), &f2)
		clientRefusal(t, c.DeleteObject(ctx, f.sk, obj.ID()), &f2)
		// valid params (validation precedes the fence check; 400 for invalid params is unchanged)
		valid := slabs.SlabPinParams{EncryptionKey: frand.Entropy256(), MinShards: 10}
		for range 30 {
			valid.Sectors = append(valid.Sectors, slabs.PinnedSector{Root: frand.Entropy256(), HostKey: types.GeneratePrivateKey().PublicKey()})
		}
		_, err := c.PinSlabs(ctx, f.sk, valid)
		clientRefusal(t, err, &f2)
		clientRefusal(t, c.UnpinSlab(ctx, f.sk, f.slab.Digest()), &f2)
		clientRefusal(t, c.PruneSlabs(ctx, f.sk), &f2)
		_, err = c.AddSharingKey(ctx, f.sk, sk)
		clientRefusal(t, err, &f2)
		clientRefusal(t, c.DeleteSharingKey(ctx, f.sk, sk.PublicKey), &f2)
		clientRefusal(t, c.AddSharedObject(ctx, f.sk, sk.PublicKey, sharedReq), &f2)
		clientRefusal(t, c.DeleteSharedObject(ctx, f.sk, sk.PublicKey, obj.ID()), &f2)
	}
	if _, err := f.client.Object(ctx, f.sk, ptr(f.object(2)).ID()); err == nil {
		t.Fatal("a refused pin was applied")
	}
	if _, err := f.client.Object(ctx, f.sk, obj.ID()); err != nil {
		t.Fatal("a refused delete was applied")
	}
	// reads are not fenced
	if _, err := f.client.Object(ctx, f.sk, obj.ID()); err != nil {
		t.Fatal(err)
	}
	// the exact credential passes the check on every route
	if _, err := fenced.AddSharingKey(ctx, f.sk, sk); err != nil {
		t.Fatal(err)
	} else if err := fenced.AddSharedObject(ctx, f.sk, sk.PublicKey, sharedReq); err != nil {
		t.Fatal(err)
	} else if err := fenced.DeleteSharedObject(ctx, f.sk, sk.PublicKey, obj.ID()); err != nil {
		t.Fatal(err)
	} else if err := fenced.DeleteSharingKey(ctx, f.sk, sk.PublicKey); err != nil {
		t.Fatal(err)
	}
	if err := fenced.PruneSlabs(ctx, f.sk); err != nil {
		t.Fatal(err)
	}
	if err := fenced.DeleteObject(ctx, f.sk, obj.ID()); err != nil {
		t.Fatal(err)
	}

	// account isolation: the credential means nothing on another (unfenced) account
	other := f.cluster.AddAccount(t)
	err := f.client.WithFence(&c2).DeleteObject(ctx, other, obj.ID())
	clientRefusal(t, err, nil)
}

func TestFenceAPIQueryCanonical(t *testing.T) {
	f := newFenceAPI(t)
	c := f.raise(apiFence(1, 1, 1))
	cred := c.String()
	route := "/objects/" + types.Hash256(frand.Entropy256()).String()

	// exact credential: the check passes (404: no such object)
	if r := f.do(http.MethodDelete, route, nil, "?sf="+cred); r.status != http.StatusNotFound {
		t.Fatalf("exact credential: %d %q", r.status, r.body)
	}
	for name, q := range map[string]string{
		"duplicate":     "?sf=" + cred + "&sf=" + cred,
		"duplicate-mix": "?sf=" + cred + "&sf=" + strings.Repeat("0", 96),
		"uppercase":     "?sf=" + strings.ToUpper(cred),
		"token-only":    "?sf=" + cred[:64],
		"too-long":      "?sf=" + cred + "00",
		"empty":         "?sf=",
		"non-hex":       "?sf=" + strings.Repeat("g", 96),
		"top-bit":       "?sf=" + "80" + cred[2:],
		"counter-top":   "?sf=" + cred[:16] + "80" + cred[18:],
	} {
		if r := f.do(http.MethodDelete, route, nil, q); r.status != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d %q", name, r.status, r.body)
		}
	}
}

func TestFenceAPISignatureTampering(t *testing.T) {
	f := newFenceAPI(t)
	c := f.raise(apiFence(1, 1, 1))
	host := strings.TrimPrefix(f.cluster.Indexer.AppURL, "http://")
	sv := time.Now().Add(time.Minute)
	key := frand.Entropy256()
	route := "/objects/" + types.Hash256(key).String()
	body := []byte{}

	good := app.FencedRequestHash(http.MethodDelete, host, route, sv, body, c)
	q := url.Values{"sf": {c.String()}}
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, good, q), nil); r.status != http.StatusNotFound {
		t.Fatalf("well-signed: %d %q", r.status, r.body)
	}
	// a different credential under the same signature
	other := c
	other.Receipt[0] ^= 1
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, good, url.Values{"sf": {other.String()}}), nil); r.status != http.StatusUnauthorized {
		t.Fatalf("swapped sf: %d %q", r.status, r.body)
	}
	// sf added to an unfenced signature
	unfenced := app.RequestHash(http.MethodDelete, host, route, sv, body)
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, unfenced, q), nil); r.status != http.StatusUnauthorized {
		t.Fatalf("sf added: %d %q", r.status, r.body)
	}
	// sf stripped from a fenced signature
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, good, nil), nil); r.status != http.StatusUnauthorized {
		t.Fatalf("sf stripped: %d %q", r.status, r.body)
	}
	// another route or method under the same signature
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, "/objects/"+types.Hash256(frand.Entropy256()).String(), sv, good, q), nil); r.status != http.StatusUnauthorized {
		t.Fatalf("other route: %d %q", r.status, r.body)
	}
	// body tampering on a fenced POST
	obj := f.object(1)
	pin, _ := json.Marshal(obj.PinRequest())
	h := app.FencedRequestHash(http.MethodPost, host, "/objects", sv, pin, c)
	tampered := bytes.Replace(pin, []byte(`"encryptedMetadata":"`), []byte(`"encryptedMetadata":"A`), 1)
	if r := f.send(http.MethodPost, f.signRaw(http.MethodPost, "/objects", sv, h, q), bytes.NewReader(tampered)); r.status != http.StatusUnauthorized {
		t.Fatalf("tampered body: %d %q", r.status, r.body)
	}
	if r := f.send(http.MethodPost, f.signRaw(http.MethodPost, "/objects", sv, h, q), bytes.NewReader(pin)); r.status != http.StatusOK && r.status != http.StatusNoContent {
		t.Fatalf("untampered body: %d %q", r.status, r.body)
	}
	// expired
	past := time.Now().Add(-time.Second)
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, past, app.FencedRequestHash(http.MethodDelete, host, route, past, body, c), q), nil); r.status != http.StatusUnauthorized {
		t.Fatalf("expired: %d %q", r.status, r.body)
	}
}

// v2FencedHash is the WITHDRAWN raw fenced hash (SDK interface v3 section 3): 0.6.0 input || "indexd/fence/v2" ||
// credential. Kept only to show why it was withdrawn (REVISION R5).
func v2FencedHash(method, host, path string, sv time.Time, body []byte, c accounts.Credential) types.Hash256 {
	b := c.Bytes()
	return app.RequestHash(method, host, path, sv, append(append(append([]byte(nil), body...), "indexd/fence/v2"...), b[:]...))
}

// TestFenceHashV2ReplayAfterFenceLoss is the adversarial test behind REVISION R5. Under the raw v2 fenced hash, a
// captured fenced DELETE also verifies as an UNFENCED DELETE whose (ignored) body is "indexd/fence/v2"||credential.
// That replay is refused only while the account holds a fence, and an account can lose its fence: a restore from a
// backup taken before the first raise, or an admin delete + prune + re-registration of the same app key. Against the
// real server, the v2-signed replay then deletes a later writer's object; the v3 (length-bound) signature cannot be
// replayed that way.
func TestFenceHashV2ReplayAfterFenceLoss(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	store := f.cluster.Indexer.Store()
	acc := proto.Account(f.sk.PublicKey())
	host := strings.TrimPrefix(f.cluster.Indexer.AppURL, "http://")
	c := f.raise(apiFence(1, 1, 1))
	x := f.object(1)
	if err := f.client.WithFence(&c).PinObject(ctx, f.sk, x); err != nil {
		t.Fatal(err)
	}
	route := "/objects/" + x.ID().String()
	sv := time.Now().Add(10 * time.Minute) // a long-lived signature: any client-chosen validity works the same
	credBytes := c.Bytes()
	ext := append([]byte("indexd/fence/v2"), credBytes[:]...)

	// the injectivity facts: v2 collides with an unfenced request, v3 collides with neither form
	v2 := v2FencedHash(http.MethodDelete, host, route, sv, []byte{}, c)
	v3 := app.FencedRequestHash(http.MethodDelete, host, route, sv, []byte{}, c)
	if app.RequestHash(http.MethodDelete, host, route, sv, ext) != v2 {
		t.Fatal("expected the v2 collision")
	} else if v3 == v2 || v3 == app.RequestHash(http.MethodDelete, host, route, sv, ext) || v3 == app.RequestHash(http.MethodDelete, host, route, sv, []byte{}) {
		t.Fatal("v3 must differ from every unfenced hash")
	}
	// v3 binds lengths: moving bytes between body and other fields changes the hash
	if app.FencedRequestHash(http.MethodPost, host, "/objects", sv, []byte("ab"), c) == app.FencedRequestHash(http.MethodPost, host, "/objectsa", sv, []byte("b"), c) {
		t.Fatal("v3 is not length-bound")
	}

	replay := func(hash types.Hash256) rawResp {
		return f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, hash, nil), bytes.NewReader(ext))
	}
	// while the fence is installed both replays are refused (v2: verified but fenced; v3: bad signature)
	assertRefusal(t, replay(v2), &c.Fence)
	if r := replay(v3); r.status != http.StatusUnauthorized {
		t.Fatalf("v3 replay with fence: %d %q", r.status, r.body)
	}

	// (1) restore from a backup taken before the first raise: the account row has no fence again
	if _, err := store.Exec(ctx, `UPDATE accounts SET fence = NULL, fence_receipt = NULL, seq_enabled = FALSE WHERE public_key = $1`, acc[:]); err != nil {
		t.Fatal(err)
	}
	if r := replay(v3); r.status != http.StatusUnauthorized {
		t.Fatalf("v3 replay after restore: %d %q", r.status, r.body)
	} else if _, err := f.client.Object(ctx, f.sk, x.ID()); err != nil {
		t.Fatal("v3 replay deleted the object")
	}
	if r := replay(v2); r.status != http.StatusNoContent && r.status != http.StatusOK {
		t.Fatalf("expected the v2 replay to succeed after the restore (the flaw), got %d %q", r.status, r.body)
	} else if _, err := f.client.Object(ctx, f.sk, x.ID()); err == nil {
		t.Fatal("v2 replay reported success but the object is still there")
	}

	// (2) admin delete + prune + re-registration of the same key: a new, unfenced owner pins x again
	if err := store.DeleteAccount(acc); err != nil {
		t.Fatal(err)
	}
	for {
		if err := store.PruneAccounts(1000); errors.Is(err, accounts.ErrNotFound) {
			break
		} else if err != nil {
			t.Fatal(err)
		}
	}
	store.AddTestAccount(t, types.PublicKey(acc))
	if _, err := store.PinSlabs(acc, time.Time{}, f.slab); err != nil {
		t.Fatal(err)
	}
	if err := f.client.PinObject(ctx, f.sk, x); err != nil {
		t.Fatal(err)
	}
	if r := replay(v3); r.status != http.StatusUnauthorized {
		t.Fatalf("v3 replay after re-registration: %d %q", r.status, r.body)
	} else if _, err := f.client.Object(ctx, f.sk, x.ID()); err != nil {
		t.Fatal("v3 replay deleted the new owner's object")
	}
	if r := replay(v2); r.status != http.StatusNoContent && r.status != http.StatusOK {
		t.Fatalf("expected the v2 replay to delete the new owner's object (the flaw), got %d %q", r.status, r.body)
	} else if _, err := f.client.Object(ctx, f.sk, x.ID()); err == nil {
		t.Fatal("v2 replay reported success but the object is still there")
	}
}

func TestFenceAPISeqAndCurrentListing(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	store := f.cluster.Indexer.Store()

	// stock objects, then the first raise backfills them
	a, b := f.object(1), f.object(2)
	for _, o := range []slabs.SealedObject{a, b} {
		if err := f.client.PinObject(ctx, f.sk, o); err != nil {
			t.Fatal(err)
		}
	}
	if r := f.do(http.MethodGet, "/seq/objects", nil, "?after=0&limit=10"); r.status != http.StatusConflict || !strings.Contains(r.body, `"fence":null`) {
		t.Fatalf("seq listing before the raise: %d %q", r.status, r.body)
	}
	fence := apiFence(1, 1, 1)
	resp, err := f.client.RaiseFence(ctx, f.sk, fence)
	if err != nil || resp.Seq != 2 {
		t.Fatalf("raise: %+v %v", resp, err)
	}
	c := resp.Credential()
	fenced := f.client.WithFence(&c)
	if err := fenced.DeleteObject(ctx, f.sk, a.ID()); err != nil {
		t.Fatal(err)
	}
	cObj := f.object(3)
	if err := fenced.PinObject(ctx, f.sk, cObj); err != nil {
		t.Fatal(err)
	}
	if err := store.BlockObject(b.ID(), "test"); err != nil {
		t.Fatal(err)
	}

	listing, err := f.client.ListObjectsSeq(ctx, f.sk, 0, 1000)
	if err != nil {
		t.Fatal(err)
	} else if listing.Head != 4 || len(listing.Events) != 3 {
		t.Fatalf("listing %+v", listing)
	}
	ev := map[types.Hash256]slabs.SeqObjectEvent{}
	for _, e := range listing.Events {
		ev[e.Key] = e
	}
	if e := ev[a.ID()]; !e.Deleted || e.Seq != 3 || e.Object != nil {
		t.Fatalf("tombstone %+v", e)
	}
	if e := ev[b.ID()]; !e.Blocked || e.Object != nil {
		t.Fatalf("blocked %+v", e)
	}
	if e := ev[cObj.ID()]; e.Seq != 4 || e.Object == nil || e.Object.ID() != cObj.ID() || len(e.Object.Slabs) != 1 {
		t.Fatalf("live %+v", e)
	}
	// paging
	page, err := f.client.ListObjectsSeq(ctx, f.sk, 3, 1)
	if err != nil || page.Head != 4 || len(page.Events) != 1 || page.Events[0].Seq != 4 {
		t.Fatalf("page after 3: %+v %v", page, err)
	}
	if page, err := f.client.ListObjectsSeq(ctx, f.sk, 4, 10); err != nil || page.Head != 4 || page.Events == nil || len(page.Events) != 0 {
		t.Fatalf("page after head: %+v %v", page, err)
	}
	if r := f.do(http.MethodGet, "/seq/objects", nil, "?after=4&limit=10"); r.body != `{"head":4,"events":[]}` {
		t.Fatalf("empty page body %q", r.body)
	}
	for _, q := range []string{"?limit=0", "?limit=1001", "?limit=x", "?after=-1", "?after=9223372036854775808", "?after=1&after=2", "?limit=1&limit=2"} {
		if r := f.do(http.MethodGet, "/seq/objects", nil, q); r.status != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d %q", q, r.status, r.body)
		}
	}
	// CBOR negotiation works as for GET /objects (the default client asks for CBOR; this one says so explicitly)
	cbor := app.NewClient(f.cluster.Indexer.AppURL, app.WithEnableCBOR(true))
	if l, err := cbor.ListObjectsSeq(ctx, f.sk, 0, 10); err != nil || l.Head != 4 || len(l.Events) != 3 {
		t.Fatalf("CBOR listing %+v %v", l, err)
	}

	// current listing: default omits the blocked object (as U1); blocked=true flags it without metadata
	r := f.do(http.MethodGet, "/current/objects", nil, "?limit=100")
	var cur []map[string]any
	if err := json.Unmarshal([]byte(r.body), &cur); err != nil || len(cur) != 1 || cur[0]["key"] != cObj.ID().String() {
		t.Fatalf("current (default) %d %q", r.status, r.body)
	}
	if _, ok := cur[0]["blocked"]; ok {
		t.Fatal("default current listing carries a blocked member (wire change vs U1)")
	}
	r = f.do(http.MethodGet, "/current/objects", nil, "?limit=100&blocked=true")
	cur = nil // json.Unmarshal would merge into the previous maps
	if err := json.Unmarshal([]byte(r.body), &cur); err != nil || len(cur) != 2 {
		t.Fatalf("current (blocked=true) %d %q", r.status, r.body)
	}
	for _, e := range cur {
		_, hasObj := e["object"]
		if (e["key"] == b.ID().String()) != (e["blocked"] == true) || hasObj == (e["blocked"] == true) {
			t.Fatalf("current entry %v", e)
		}
	}
}

// TestFenceAPIRouteConflict documents REVISION R2: GET /objects/seq cannot be registered next to GET /objects/:key.
func TestFenceAPIRouteConflict(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected the router to refuse /objects/seq next to /objects/:key")
		}
	}()
	jape.Mux(map[string]jape.Handler{
		"GET /objects/:key": func(jape.Context) {},
		"GET /objects/seq":  func(jape.Context) {},
	})
}

func TestFenceAPILegacyClient(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	o := f.object(1)
	if err := f.client.PinObject(ctx, f.sk, o); err != nil {
		t.Fatal(err)
	}
	publishEvents(t, f.cluster.Indexer)
	events, err := f.client.ListObjects(ctx, f.sk, slabs.Cursor{}, 10)
	if err != nil || len(events) != 1 || events[0].Key != o.ID() {
		t.Fatalf("feed %+v %v", events, err)
	}
	if err := f.client.DeleteObject(ctx, f.sk, o.ID()); err != nil {
		t.Fatal(err)
	}
	if err := f.client.PruneSlabs(ctx, f.sk); err != nil {
		t.Fatal(err)
	}
	// sf on an account without a fence is refused naming no fence
	cred := accounts.Credential{Fence: apiFence(1, 1, 1)}
	clientRefusal(t, f.client.WithFence(&cred).PinObject(ctx, f.sk, f.object(2)), nil)
}

func ptr[T any](v T) *T { return &v }

// TestFenceHashVector pins the R5 fenced hash to fixed vectors, computed independently with Python's hashlib.blake2b
// over the documented byte layout (work/indexd-fencing-implementation-interface.txt R5), for the SDK to reproduce.
func TestFenceHashVector(t *testing.T) {
	cred, err := accounts.ParseCredential("00110000000000010000000000000002abababababababababababababababab000102030405060708090a0b0c0d0e0f")
	if err != nil {
		t.Fatal(err)
	}
	sv := time.Unix(1800000000, 0)
	host := "127.0.0.1:9980"
	for _, v := range []struct {
		method, path string
		body         []byte
		want         string
	}{
		{http.MethodDelete, "/objects/" + strings.Repeat("00", 32), nil, "b5c8721ea350ef87236c6d59480911958af7a04ad178b08ca5a7e528ae2465f6"},
		{http.MethodDelete, "/objects/" + strings.Repeat("00", 32), []byte{}, "b5c8721ea350ef87236c6d59480911958af7a04ad178b08ca5a7e528ae2465f6"},
		{http.MethodPost, "/objects", []byte(`{"fence":"x"}`), "82f6b75413afadd113a9bbec03a55df1079cc46708367d922bd1b5edc7cfc360"},
	} {
		got := app.FencedRequestHash(v.method, host, v.path, sv, v.body, cred)
		if hex.EncodeToString(got[:]) != v.want {
			t.Fatalf("%s %s: got %x, want %s", v.method, v.path, got, v.want)
		}
		t.Logf("vector %s %s %s body %q -> %x", v.method, host, v.path, v.body, got)
	}
}
