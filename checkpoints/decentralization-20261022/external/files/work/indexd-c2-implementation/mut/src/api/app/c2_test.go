package app_test

// G-C2 tests (work/indexd-c2-implementation-interface.txt) over real HTTP against a real store (PostgreSQL).

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/api/app"
	"go.sia.tech/indexd/sharing"
	"go.sia.tech/indexd/slabs"
	"lukechampine.com/frand"
)

func opID(i int) accounts.OpID {
	var o accounts.OpID
	copy(o[:], fmt.Sprintf("http-op-%08d", i))
	return o
}

// casConflict asserts a 412 C2 refusal of the given kind (and head, when want is not nil).
func casConflict(t *testing.T, r rawResp, kind string, head *uint64) map[string]any {
	t.Helper()
	if r.status != http.StatusPreconditionFailed || !strings.HasPrefix(r.ctype, "application/json") {
		t.Fatalf("expected a 412 %q conflict, got %d %q %q", kind, r.status, r.ctype, r.body)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(r.body), &body); err != nil || body["conflict"] != kind {
		t.Fatalf("expected conflict %q, got %q (%v)", kind, r.body, err)
	}
	if head != nil && body["seq"] != float64(*head) {
		t.Fatalf("expected head %d in %q", *head, r.body)
	}
	if _, ok := body["fence"]; !ok {
		t.Fatalf("conflict without the installed fence: %q", r.body)
	}
	return body
}

func clientCAS(t *testing.T, err error, kind string, head *uint64) {
	t.Helper()
	var he *app.HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("expected an HTTP error, got %v", err)
	}
	casConflict(t, rawResp{status: he.StatusCode, ctype: "application/json", body: he.Body}, kind, head)
}

func casQuery(c accounts.Credential, sq *uint64, op accounts.OpID) string {
	q := "?sf=" + c.String() + "&op=" + op.String()
	if sq != nil {
		q += "&sq=" + fmt.Sprint(*sq)
	}
	return q
}

func (f *fenceAPI) raiseCAS(fence accounts.Fence) accounts.Credential {
	f.t.Helper()
	resp, err := f.client.RaiseFenceMode(f.t.Context(), f.sk, fence, accounts.ModeCAS)
	if err != nil {
		f.t.Fatal(err)
	} else if resp.Mode == nil || *resp.Mode != accounts.ModeCAS {
		f.t.Fatalf("raise did not report cas mode: %+v", resp)
	}
	return resp.Credential()
}

func casResult(t *testing.T, r rawResp) app.CASResult {
	t.Helper()
	var res app.CASResult
	if r.status != http.StatusOK || json.Unmarshal([]byte(r.body), &res) != nil {
		t.Fatalf("expected 200 {seq, replayed}, got %d %q", r.status, r.body)
	}
	return res
}

func TestC2HashVectors(t *testing.T) {
	cred, err := accounts.ParseCredential("00110000000000010000000000000002abababababababababababababababab000102030405060708090a0b0c0d0e0f")
	if err != nil {
		t.Fatal(err)
	}
	op, _ := accounts.ParseOpID("101112131415161718191a1b1c1d1e1f")
	sv := time.Unix(1800000000, 0)
	host := "127.0.0.1:9980"
	del := "/objects/" + strings.Repeat("00", 32)
	// computed independently by work/indexd-c2-implementation/tools/vectors.py (hashlib.blake2b)
	for _, v := range []struct {
		method, path string
		hasSq        bool
		sq           uint64
		body         []byte
		wantV4       string
		wantOp       string
	}{
		{http.MethodPost, "/objects", true, 41, []byte(`{"x":1}`), "dc6b660aaa1163b63d7f3d3f8697fcff1b7e5fe74ee77e661a04426561fad8d2", "1d7e160c6610909852c630a1aef41de62927601db836b3a2d8ef27804af36264"},
		{http.MethodDelete, del, true, 42, nil, "149020203d366e381cefa3cf7ca5e72c46334d9932de2d4d79b62bb62d3b4e4f", "5c3514f3e8bdc77fea7ac0972aa3de561398c3e4bd3592dbe3f1f69c37afea62"},
		{http.MethodDelete, del, true, 42, []byte{}, "149020203d366e381cefa3cf7ca5e72c46334d9932de2d4d79b62bb62d3b4e4f", "5c3514f3e8bdc77fea7ac0972aa3de561398c3e4bd3592dbe3f1f69c37afea62"},
		{http.MethodPost, "/slabs/prune", false, 0, nil, "c51004cb21861d9477f9b5a60dcec7e6bab5f0aa13ef710a7049326c8c763b16", "5db9ea6d259cae1e235b893d983ad257c490874c1415a4e835f38223941cf2af"},
		{http.MethodDelete, del, true, 7, nil, "014ac4dd4b53d67e425aaf063cdde35973a2950c49cc7cebac3db67b689d01ba", "397c0d3d4ae9f9f95cebefbd6ea42ed2977d5f1c679e1e287ac17e168d8aee45"},
		{http.MethodPost, "/objects", true, 7, []byte(`{"fence":"x"}`), "8d5dee780de4161d16d00a5de566ea494f60110239b7c9fca4ef6738add077b5", "171bc850811b469d66585b4b515c78e5948d85cee0b4c69ddfe792a9f158f3bf"},
	} {
		cas := &accounts.CASRequest{HasSq: v.hasSq, Sq: v.sq, Op: op}
		got := app.V4RequestHash(v.method, host, v.path, sv, v.body, cred, cas)
		if hex.EncodeToString(got[:]) != v.wantV4 {
			t.Fatalf("v4 %s %s sq %d: got %x, want %s", v.method, v.path, v.sq, got, v.wantV4)
		}
		d := app.OpDigest(v.method, host, v.path, v.body, cred, cas)
		if d.String() != v.wantOp {
			t.Fatalf("op digest %s %s sq %d: got %s, want %s", v.method, v.path, v.sq, d, v.wantOp)
		}
		// the expiry is not part of the operation; it is part of the signature
		if app.OpDigest(v.method, host, v.path, v.body, cred, cas) != d || app.V4RequestHash(v.method, host, v.path, sv.Add(time.Second), v.body, cred, cas) == got {
			t.Fatal("sv binding")
		}
		t.Logf("vector %s %s %s flags %d sq %d body %q -> v4 %s op %s", v.method, host, v.path, cas.Flags(), v.sq, v.body, hex.EncodeToString(got[:]), d)
	}
	// every operation field changes the digest (no aliasing)
	base := &accounts.CASRequest{HasSq: true, Sq: 7, Op: op}
	ref := app.OpDigest(http.MethodPost, host, "/objects", []byte("b"), cred, base)
	otherOp := *base
	otherOp.Op[15] ^= 1
	noSq := &accounts.CASRequest{Op: op}
	otherCred := cred
	otherCred.Receipt[0] ^= 1
	for name, d := range map[string]accounts.OpDigest{
		"method": app.OpDigest(http.MethodDelete, host, "/objects", []byte("b"), cred, base),
		"host":   app.OpDigest(http.MethodPost, "127.0.0.1:9981", "/objects", []byte("b"), cred, base),
		"path":   app.OpDigest(http.MethodPost, host, "/objectz", []byte("b"), cred, base),
		"body":   app.OpDigest(http.MethodPost, host, "/objects", []byte("c"), cred, base),
		"cred":   app.OpDigest(http.MethodPost, host, "/objects", []byte("b"), otherCred, base),
		"sq":     app.OpDigest(http.MethodPost, host, "/objects", []byte("b"), cred, &accounts.CASRequest{HasSq: true, Sq: 8, Op: op}),
		"op":     app.OpDigest(http.MethodPost, host, "/objects", []byte("b"), cred, &otherOp),
		"flags":  app.OpDigest(http.MethodPost, host, "/objects", []byte("b"), cred, noSq),
	} {
		if d == ref {
			t.Fatalf("the op digest ignores the %s", name)
		}
	}
}

func TestC2APIEnrolAndState(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	st, err := f.client.Fence(ctx, f.sk)
	if err != nil || st.Mode != nil || st.LastOp != nil || strings.Join(st.Capabilities, ",") != "fence-v3,cas-v4,op-nonce" || st.OpNonce == nil {
		t.Fatalf("fresh: %+v %v", st, err)
	}
	if r := f.do(http.MethodGet, "/fence", nil, ""); !regexp.MustCompile(`^\{"fence":null,"receiptSha256":null,"seq":0,"lastOp":null,"lastOpDigest":null,"mode":null,"capabilities":\["fence-v3","cas-v4","op-nonce"\],"opNonce":"[0-9a-f]{32}"\}$`).MatchString(r.body) {
		t.Fatalf("fresh GET /fence body %q", r.body)
	}
	// an unknown mode is a request error, and installs nothing
	f1 := apiFence(1, 1, 1)
	for _, body := range []string{`{"fence":"` + f1.String() + `","mode":"CAS"}`, `{"fence":"` + f1.String() + `","mode":""}`, `{"fence":"` + f1.String() + `","mode":null}`, `{"fence":"` + f1.String() + `","mode":1}`} {
		r := f.do(http.MethodPost, "/fence", []byte(body), "")
		if body == `{"fence":"`+f1.String()+`","mode":null}` {
			// null is "absent" in JSON; it must behave exactly like a raise without mode -- check below instead
			if r.status != http.StatusOK {
				t.Fatalf("mode null: %d %q", r.status, r.body)
			}
			continue
		}
		if r.status != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d %q", body, r.status, r.body)
		}
	}
	if st, _ := f.client.Fence(ctx, f.sk); st.Mode != nil || st.Fence == nil || *st.Fence != f1 {
		t.Fatalf("after the null-mode raise: %+v", st)
	}
	// enrol on a raise of an already fenced account
	f2 := apiFence(1, 2, 1)
	c2 := f.raiseCAS(f2)
	st, _ = f.client.Fence(ctx, f.sk)
	if st.Mode == nil || *st.Mode != "cas" || *st.Fence != f2 || st.LastOp != nil {
		t.Fatalf("enrolled: %+v", st)
	}
	// raises without mode are refused 412 mode (no downgrade) naming the installed fence; nothing changes
	body := casConflict(t, f.do(http.MethodPost, "/fence", []byte(`{"fence":"`+apiFence(1, 3, 1).String()+`"}`), ""), "mode", nil)
	if body["mode"] != "cas" || body["fence"] != f2.String() {
		t.Fatalf("mode refusal body %v", body)
	}
	_, err = f.client.RaiseFence(ctx, f.sk, apiFence(2, 0, 1))
	clientCAS(t, err, "mode", nil)
	// a lower raise is a FENCE refusal (409), whatever the mode
	assertRefusal(t, f.do(http.MethodPost, "/fence", []byte(`{"fence":"`+f1.String()+`","mode":"cas"}`), ""), &f2)
	if st, _ := f.client.Fence(ctx, f.sk); *st.Fence != f2 {
		t.Fatal("a refused raise changed the fence")
	}
	// a pin under CAS, then GET /fence shows the exact operation
	obj := f.object(1)
	res, err := f.client.WithFence(&c2).PinObjectCAS(ctx, f.sk, obj, 0, opID(1))
	if err != nil || res.Seq != 1 || res.Replayed {
		t.Fatalf("CAS pin: %+v %v", res, err)
	}
	st, _ = f.client.Fence(ctx, f.sk)
	if st.Seq != 1 || st.LastOp == nil || *st.LastOp != opID(1) || st.LastOpDigest == nil {
		t.Fatalf("after the CAS pin: %+v", st)
	}
	host := strings.TrimPrefix(f.cluster.Indexer.AppURL, "http://")
	pin, _ := json.Marshal(obj.PinRequest())
	want := app.OpDigest(http.MethodPost, host, "/objects", pin, c2, &accounts.CASRequest{HasSq: true, Sq: 0, Op: opID(1)})
	if *st.LastOpDigest != want {
		t.Fatalf("lastOpDigest %s, the writer computes %s", st.LastOpDigest, want)
	}
	if rd := sha256.Sum256(c2.Receipt[:]); *st.ReceiptSHA256 != accounts.ReceiptDigest(rd) {
		t.Fatal("receipt digest")
	}
}

func TestC2APIReplayAndConflicts(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	c := f.raiseCAS(apiFence(1, 1, 1))
	host := strings.TrimPrefix(f.cluster.Indexer.AppURL, "http://")
	obj := f.object(1)
	pin, _ := json.Marshal(obj.PinRequest())
	cas0 := &accounts.CASRequest{HasSq: true, Sq: 0, Op: opID(1)}
	q := url.Values{"sf": {c.String()}, "op": {opID(1).String()}, "sq": {"0"}}
	sv := time.Now().Add(time.Minute)
	signed := f.signRaw(http.MethodPost, "/objects", sv, app.V4RequestHash(http.MethodPost, host, "/objects", sv, pin, c, cas0), q)

	if res := casResult(t, f.send(http.MethodPost, signed, bytes.NewReader(pin))); res.Seq != 1 || res.Replayed {
		t.Fatalf("first: %+v", res)
	}
	// the IDENTICAL bytes again (the lost-answer retry): 200, replayed, not applied again
	if res := casResult(t, f.send(http.MethodPost, signed, bytes.NewReader(pin))); res.Seq != 1 || !res.Replayed {
		t.Fatalf("raw replay: %+v", res)
	}
	// re-signed later with a new expiry: still the same operation
	sv2 := sv.Add(30 * time.Second)
	resigned := f.signRaw(http.MethodPost, "/objects", sv2, app.V4RequestHash(http.MethodPost, host, "/objects", sv2, pin, c, cas0), q)
	if res := casResult(t, f.send(http.MethodPost, resigned, bytes.NewReader(pin))); res.Seq != 1 || !res.Replayed {
		t.Fatalf("re-signed replay: %+v", res)
	}
	// the client API agrees
	if res, err := f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, obj, 0, opID(1)); err != nil || !res.Replayed || res.Seq != 1 {
		t.Fatalf("client replay: %+v %v", res, err)
	}
	// the same op id and sq with ANY other operation: 412 op, nothing applied
	other := obj
	other.EncryptedMetadata = []byte("altered")
	other.Sign(f.sk)
	_, err := f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, other, 0, opID(1))
	clientCAS(t, err, "op", ptr(uint64(1)))
	_, err = f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, f.object(2), 0, opID(1))
	clientCAS(t, err, "op", ptr(uint64(1)))
	_, err = f.client.WithFence(&c).DeleteObjectCAS(ctx, f.sk, obj.ID(), 0, opID(1))
	clientCAS(t, err, "op", ptr(uint64(1)))
	// another op at the stale head: 412 seq
	_, err = f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, f.object(3), 0, opID(2))
	clientCAS(t, err, "seq", ptr(uint64(1)))
	// a head in the future: 412 seq
	_, err = f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, f.object(3), 5, opID(2))
	clientCAS(t, err, "seq", ptr(uint64(1)))
	if got, err := f.client.Object(ctx, f.sk, obj.ID()); err != nil || !bytes.Equal(got.EncryptedMetadata, obj.EncryptedMetadata) {
		t.Fatalf("the original object changed: %v", err)
	}
	if _, err := f.client.Object(ctx, f.sk, ptr(f.object(2)).ID()); err == nil {
		t.Fatal("a refused CAS pin was applied")
	}
	// delete at the right head; then its replay
	res, err := f.client.WithFence(&c).DeleteObjectCAS(ctx, f.sk, obj.ID(), 1, opID(3))
	if err != nil || res.Seq != 2 || res.Replayed {
		t.Fatalf("delete: %+v %v", res, err)
	}
	if res, err := f.client.WithFence(&c).DeleteObjectCAS(ctx, f.sk, obj.ID(), 1, opID(3)); err != nil || !res.Replayed || res.Seq != 2 {
		t.Fatalf("delete replay: %+v %v", res, err)
	}
	// a delete of a missing key under CAS: 404 after the CAS check, the head does not move
	if _, err := f.client.WithFence(&c).DeleteObjectCAS(ctx, f.sk, types.Hash256(frand.Entropy256()), 2, opID(4)); err == nil {
		t.Fatal("delete of a missing key")
	}
	if st, _ := f.client.Fence(ctx, f.sk); st.Seq != 2 || *st.LastOp != opID(3) {
		t.Fatalf("a refused delete moved the head: %+v", st)
	}
	// a stale credential is a FENCE refusal (409), never a 412
	f2 := apiFence(1, 2, 1)
	c2 := f.raiseCAS(f2)
	_, err = f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, f.object(4), 2, opID(5))
	clientRefusal(t, err, &f2)
	// the raise cleared the record: the last op of the previous generation does not replay under the new credential
	_, err = f.client.WithFence(&c2).DeleteObjectCAS(ctx, f.sk, obj.ID(), 1, opID(3))
	clientCAS(t, err, "seq", ptr(uint64(2)))
	if st, _ := f.client.Fence(ctx, f.sk); st.LastOp != nil || st.LastOpDigest != nil || st.Seq != 2 {
		t.Fatalf("after the raise: %+v", st)
	}
}

func TestC2APIRequestForm(t *testing.T) {
	f := newFenceAPI(t)
	c := f.raiseCAS(apiFence(1, 1, 1))
	host := strings.TrimPrefix(f.cluster.Indexer.AppURL, "http://")
	route := "/objects/" + types.Hash256(frand.Entropy256()).String()
	op := opID(1).String()
	cred := c.String()
	// malformed v4 parameters: 400
	for name, q := range map[string]string{
		"op-upper":      "?sf=" + cred + "&op=" + strings.ToUpper(op) + "&sq=0",
		"op-short":      "?sf=" + cred + "&op=" + op[:30] + "&sq=0",
		"op-long":       "?sf=" + cred + "&op=" + op + "00&sq=0",
		"op-empty":      "?sf=" + cred + "&op=&sq=0",
		"op-dup":        "?sf=" + cred + "&op=" + op + "&op=" + op + "&sq=0",
		"sq-dup":        "?sf=" + cred + "&op=" + op + "&sq=0&sq=0",
		"sq-lead0":      "?sf=" + cred + "&op=" + op + "&sq=00",
		"sq-plus":       "?sf=" + cred + "&op=" + op + "&sq=%2B1",
		"sq-neg":        "?sf=" + cred + "&op=" + op + "&sq=-1",
		"sq-2^63":       "?sf=" + cred + "&op=" + op + "&sq=9223372036854775808",
		"sq-empty":      "?sf=" + cred + "&op=" + op + "&sq=",
		"sq-hex":        "?sf=" + cred + "&op=" + op + "&sq=0x1",
		"sq-without-op": "?sf=" + cred + "&sq=0",
		"op-without-sf": "?op=" + op + "&sq=0",
		"advance-no-sq": "?sf=" + cred + "&op=" + op,
	} {
		if r := f.do(http.MethodDelete, route, nil, q); r.status != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d %q", name, r.status, r.body)
		}
	}
	// the largest canonical sq is accepted (and is a seq conflict)
	casConflict(t, f.do(http.MethodDelete, route, nil, "?sf="+cred+"&op="+op+"&sq=9223372036854775807"), "seq", ptr(uint64(0)))

	// signature tampering: the v4 hash binds sq, op and flags
	sv := time.Now().Add(time.Minute)
	cas := &accounts.CASRequest{HasSq: true, Sq: 0, Op: opID(1)}
	good := app.V4RequestHash(http.MethodDelete, host, route, sv, nil, c, cas)
	base := url.Values{"sf": {cred}, "op": {op}, "sq": {"0"}}
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, good, base), nil); r.status != http.StatusNotFound {
		t.Fatalf("well-signed v4: %d %q", r.status, r.body)
	}
	for name, q := range map[string]url.Values{
		"sq-changed": {"sf": {cred}, "op": {op}, "sq": {"1"}},
		"op-changed": {"sf": {cred}, "op": {opID(2).String()}, "sq": {"0"}},
		"sq-dropped": {"sf": {cred}, "op": {op}},
		"op+sq-dropped (v3 form under a v4 signature)": {"sf": {cred}},
	} {
		if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, good, q), nil); r.status != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401, got %d %q", name, r.status, r.body)
		}
	}
	// a v3 signature with op/sq added is not a v4 signature
	v3 := app.FencedRequestHash(http.MethodDelete, host, route, sv, nil, c)
	if r := f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, v3, base), nil); r.status != http.StatusUnauthorized {
		t.Fatalf("v3 signature with v4 params: %d %q", r.status, r.body)
	}
	// and the v3 form itself, correctly signed, is refused on the enrolled account (412 mode)
	casConflict(t, f.send(http.MethodDelete, f.signRaw(http.MethodDelete, route, sv, v3, url.Values{"sf": {cred}}), nil), "mode", nil)
}

func TestC2APIEnrolledRefusesV3AndOldClients(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	c := f.raiseCAS(apiFence(1, 1, 1))
	obj := f.object(1)
	if _, err := f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, obj, 0, opID(1)); err != nil {
		t.Fatal(err)
	}
	nonce := sharing.Nonce(frand.Bytes(32))
	sharePriv := sharing.DeriveSharingKey(f.sk, nonce)
	sk := sharing.KeyRequest{PublicKey: sharePriv.PublicKey(), Nonce: nonce}
	sk.Sign(sharePriv)
	sharedReq := sharing.SharedObjectRequest{ObjectID: obj.ID(), EncryptedDataKey: frand.Bytes(sharing.EncryptionKeySize)}
	sharedReq.Sign(sharePriv)
	// valid params: validation precedes the fence and mode checks (400 for invalid params is unchanged)
	valid := slabs.SlabPinParams{EncryptionKey: frand.Entropy256(), MinShards: 10}
	for range 30 {
		valid.Sectors = append(valid.Sectors, slabs.PinnedSector{Root: frand.Entropy256(), HostKey: types.GeneratePrivateKey().PublicKey()})
	}

	// a v3 (fence-only) client with the EXACT credential: 412 mode on all 9 routes
	v3 := f.client.WithFence(&c)
	mode := func(name string, err error) {
		t.Helper()
		var he *app.HTTPError
		if !errors.As(err, &he) || he.StatusCode != http.StatusPreconditionFailed || !strings.Contains(he.Body, `"conflict":"mode"`) || !strings.Contains(he.Body, `"mode":"cas"`) {
			t.Fatalf("%s: expected 412 mode, got %v", name, err)
		}
	}
	mode("PinObject", v3.PinObject(ctx, f.sk, f.object(2)))
	mode("DeleteObject", v3.DeleteObject(ctx, f.sk, obj.ID()))
	_, err := v3.PinSlabs(ctx, f.sk, valid)
	mode("PinSlabs", err)
	mode("UnpinSlab", v3.UnpinSlab(ctx, f.sk, f.slab.Digest()))
	mode("PruneSlabs", v3.PruneSlabs(ctx, f.sk))
	_, err = v3.AddSharingKey(ctx, f.sk, sk)
	mode("AddSharingKey", err)
	mode("DeleteSharingKey", v3.DeleteSharingKey(ctx, f.sk, sk.PublicKey))
	mode("AddSharedObject", v3.AddSharedObject(ctx, f.sk, sk.PublicKey, sharedReq))
	mode("DeleteSharedObject", v3.DeleteSharedObject(ctx, f.sk, sk.PublicKey, obj.ID()))
	// a stock (0.6.0) client: 409 fence refusal, unchanged
	clientRefusal(t, f.client.PinObject(ctx, f.sk, f.object(3)), &c.Fence)
	clientRefusal(t, f.client.DeleteObject(ctx, f.sk, obj.ID()), &c.Fence)
	if st, _ := f.client.Fence(ctx, f.sk); st.Seq != 1 || *st.LastOp != opID(1) {
		t.Fatalf("a refused request changed the head or record: %+v", st)
	}
	if _, err := f.client.Object(ctx, f.sk, obj.ID()); err != nil {
		t.Fatal("a refused delete was applied")
	}

	// the non-advancing routes in v4 form, with and without sq (a precondition: the head does not advance)
	op := opID(10)
	r := f.do(http.MethodPost, "/sharing", mustJSON(t, sk), "?sf="+c.String()+"&op="+op.String())
	if r.status != http.StatusOK && r.status != http.StatusNoContent && r.status != http.StatusCreated {
		t.Fatalf("v4 add sharing key: %d %q", r.status, r.body)
	}
	casConflict(t, f.do(http.MethodPost, "/slabs/prune", nil, casQuery(c, ptr(uint64(0)), opID(11))), "seq", ptr(uint64(1)))
	if r := f.do(http.MethodPost, "/slabs/prune", nil, casQuery(c, ptr(uint64(1)), opID(12))); r.status/100 != 2 {
		t.Fatalf("v4 prune at the head: %d %q", r.status, r.body)
	}
	if st, _ := f.client.Fence(ctx, f.sk); st.Seq != 1 || *st.LastOp != opID(1) {
		t.Fatalf("non-advancing routes changed the head or the record: %+v", st)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestC2APILegacyAndMixedAccounts(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	// unfenced: stock behaviour, including the empty 204 answer
	if r := f.do(http.MethodPost, "/objects", mustJSON(t, ptr(f.object(1)).PinRequest()), ""); r.status != http.StatusNoContent || r.body != "" {
		t.Fatalf("stock pin answer %d %q", r.status, r.body)
	}
	// fenced, NOT enrolled: v3 and v4 both work, mixed in any order; v3 answers stay 204 as before
	c := f.raise(apiFence(1, 1, 1))
	if r := f.do(http.MethodPost, "/objects", mustJSON(t, ptr(f.object(2)).PinRequest()), "?sf="+c.String()); r.status != http.StatusNoContent || r.body != "" {
		t.Fatalf("v3 pin answer %d %q", r.status, r.body)
	}
	st, _ := f.client.Fence(ctx, f.sk)
	res, err := f.client.WithFence(&c).PinObjectCAS(ctx, f.sk, f.object(3), st.Seq, opID(1))
	if err != nil || res.Seq != st.Seq+1 {
		t.Fatalf("v4 on an unenrolled account: %+v %v", res, err)
	}
	if err := f.client.WithFence(&c).DeleteObject(ctx, f.sk, ptr(f.object(2)).ID()); err != nil {
		t.Fatalf("v3 after v4: %v", err)
	}
	if st2, _ := f.client.Fence(ctx, f.sk); st2.Mode != nil || st2.Seq != st.Seq+2 {
		t.Fatalf("unenrolled: %+v", st2)
	}
	// a second, unfenced account on the same indexer is untouched by all of this
	other := f.cluster.AddAccount(t)
	if _, err := f.cluster.Indexer.Store().PinSlabs(proto.Account(other.PublicKey()), time.Time{}, f.slab); err != nil {
		t.Fatal(err)
	}
	o := f.object(4)
	o.Sign(other)
	if err := f.client.PinObject(ctx, other, o); err != nil {
		t.Fatal(err)
	}
	if st, _ := f.client.Fence(ctx, other); st.Fence != nil || st.Mode != nil {
		t.Fatalf("other account: %+v", st)
	}
}

func TestC2APIConcurrentOneWinner(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	c := f.raiseCAS(apiFence(1, 1, 1))
	cl := f.client.WithFence(&c)
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, conflicts := 0, 0
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := cl.PinObjectCAS(ctx, f.sk, f.object(i), 0, opID(i))
			mu.Lock()
			defer mu.Unlock()
			var he *app.HTTPError
			switch {
			case err == nil:
				wins++
			case errors.As(err, &he) && he.StatusCode == http.StatusPreconditionFailed && strings.Contains(he.Body, `"conflict":"seq"`):
				conflicts++
			default:
				t.Errorf("unexpected: %v", err)
			}
		}()
	}
	wg.Wait()
	if wins != 1 || conflicts != 7 {
		t.Fatalf("%d winners, %d seq conflicts", wins, conflicts)
	}
	if st, _ := f.client.Fence(ctx, f.sk); st.Seq != 1 {
		t.Fatalf("head %d", st.Seq)
	}
}

func TestC2APIBlockUnblock(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	admin := f.cluster.Indexer.Admin
	c := f.raiseCAS(apiFence(1, 1, 1))
	cl := f.client.WithFence(&c)
	a, b := f.object(1), f.object(2)
	if _, err := cl.PinObjectCAS(ctx, f.sk, a, 0, opID(1)); err != nil {
		t.Fatal(err)
	}
	// admin blocks a's key (an existing object) and b's key (not yet pinned): the head and the record do not move
	if err := admin.ObjectBlocklistAdd(ctx, a.ID(), "c2-test"); err != nil {
		t.Fatal(err)
	} else if err := admin.ObjectBlocklistAdd(ctx, b.ID(), "c2-test"); err != nil {
		t.Fatal(err)
	}
	if st, _ := f.client.Fence(ctx, f.sk); st.Seq != 1 || *st.LastOp != opID(1) {
		t.Fatalf("block moved the head: %+v", st)
	}
	// a CAS pin of the blocked key at the right head: 451, nothing applied
	_, err := cl.PinObjectCAS(ctx, f.sk, b, 1, opID(2))
	var he *app.HTTPError
	if !errors.As(err, &he) || he.StatusCode != http.StatusUnavailableForLegalReasons {
		t.Fatalf("expected 451, got %v", err)
	}
	// the current listing (blocked=true) flags a; the sequence listing keeps the event
	publishEvents(t, f.cluster.Indexer)
	if r := f.do(http.MethodGet, "/current/objects", nil, "?limit=10&blocked=true"); !strings.Contains(r.body, `"blocked":true`) {
		t.Fatalf("blocked listing %q", r.body)
	}
	if err := admin.ObjectBlocklistRemove(ctx, a.ID()); err != nil {
		t.Fatal(err)
	} else if err := admin.ObjectBlocklistRemove(ctx, b.ID()); err != nil {
		t.Fatal(err)
	}
	st, _ := f.client.Fence(ctx, f.sk)
	if st.Seq != 1 || *st.LastOp != opID(1) {
		t.Fatalf("unblock moved the head: %+v", st)
	}
	// the writer continues at the same head (no resync); a is listed as it was (no resurrection of anything deleted)
	if res, err := cl.PinObjectCAS(ctx, f.sk, b, 1, opID(3)); err != nil || res.Seq != 2 {
		t.Fatalf("pin after unblock: %+v %v", res, err)
	}
	listing, err := f.client.ListObjectsSeq(ctx, f.sk, 0, 10)
	if err != nil || len(listing.Events) != 2 || listing.Events[0].Key != a.ID() || listing.Events[1].Key != b.ID() {
		t.Fatalf("seq listing %+v %v", listing, err)
	}
}

// TestC2APIClonedInvocations is root's C2 review case at the wire level. Two post-raise copies with copied RNG state
// and identical clocks receive two DIFFERENT invocations with identical input (a create-if-absent of the same key):
// they build byte-identical sealed objects and, with a copied-RNG op id, byte-identical requests.
//   - NEGATIVE CONTROL: with the copied op id the indexer cannot tell the second invocation from a retry of the
//     first: it answers 200 replayed, so both copies would report "created". No server can separate them.
//   - G-C2 R2: with each invocation's op taken from its OWN GET /fence opNonce (indexer randomness, never stored),
//     the second invocation is a different operation at a stale head: 412 seq. Exactly one copy succeeds.
//   - ONE invocation duplicated by a snapshot taken after it fetched its nonce (same op, same bytes) is a retry of
//     that single invocation: answered once applied, once replayed (legitimately both "its" success).
func TestC2APIClonedInvocations(t *testing.T) {
	f := newFenceAPI(t)
	ctx := t.Context()
	c := f.raiseCAS(apiFence(1, 1, 1))
	cl := f.client.WithFence(&c)

	// nonces: fresh per answer, well-formed, never stored (lastOp unaffected)
	seen := map[accounts.OpID]bool{}
	for range 20 {
		st, err := f.client.Fence(ctx, f.sk)
		if err != nil || st.OpNonce == nil || seen[*st.OpNonce] || st.LastOp != nil {
			t.Fatalf("nonce %+v %v", st, err)
		}
		seen[*st.OpNonce] = true
	}

	// NEGATIVE CONTROL: copied op id, identical bytes -> both copies get 200
	same := f.object(1)
	copied := opID(77)
	r1, err1 := cl.PinObjectCAS(ctx, f.sk, same, 0, copied)
	r2, err2 := cl.PinObjectCAS(ctx, f.sk, same, 0, copied)
	if err1 != nil || err2 != nil || r1.Replayed || !r2.Replayed || r1.Seq != 1 || r2.Seq != 1 {
		t.Fatalf("negative control: %+v %v / %+v %v", r1, err1, r2, err2)
	}
	t.Log("negative control: a copied op id makes a second invocation indistinguishable from a retry (200 replayed)")

	// R2: each invocation takes its op from its own nonce; both build the identical object at head 1
	same2 := f.object(2)
	opA, opB := opNonce(t, f, 1), opNonce(t, f, 1) // both copies fetch after their invocation started, before either sends
	ra, errA := cl.PinObjectCAS(ctx, f.sk, same2, 1, opA)
	_, errB := cl.PinObjectCAS(ctx, f.sk, same2, 1, opB)
	if errA != nil || ra.Replayed || ra.Seq != 2 {
		t.Fatalf("first copy: %+v %v", ra, errA)
	}
	clientCAS(t, errB, "seq", ptr(uint64(2)))

	// one invocation duplicated after it fetched its nonce: the same operation, applied once, replayed once
	same3 := f.object(3)
	op := opNonce(t, f, 2)
	x, errX := cl.PinObjectCAS(ctx, f.sk, same3, 2, op)
	y, errY := cl.PinObjectCAS(ctx, f.sk, same3, 2, op)
	if errX != nil || errY != nil || x.Replayed || !y.Replayed || x.Seq != 3 || y.Seq != 3 {
		t.Fatalf("duplicated single invocation: %+v %v / %+v %v", x, errX, y, errY)
	}

	// root's case: BOTH first replies are lost (delivered, answer dropped), then both copies settle their unknown
	// outcome by replaying their own operation. "Refuse replayed on a first send" cannot help: neither saw one.
	// NEGATIVE CONTROL (copied op): both settlements answer replayed -> both copies would report "created"
	same4, copied4 := f.object(4), opID(78)
	cl.PinObjectCAS(ctx, f.sk, same4, 3, copied4) // copy A: applied, reply dropped
	cl.PinObjectCAS(ctx, f.sk, same4, 3, copied4) // copy B: replayed, reply dropped
	sa, ea := cl.PinObjectCAS(ctx, f.sk, same4, 3, copied4)
	sb, eb := cl.PinObjectCAS(ctx, f.sk, same4, 3, copied4)
	if ea != nil || eb != nil || !sa.Replayed || !sb.Replayed {
		t.Fatalf("negative control (both replies lost): %+v %v / %+v %v", sa, ea, sb, eb)
	}
	// R2 (own nonces): copy A's settlement is its replay; copy B's settlement is refused 412 seq -> exactly one success
	same5 := f.object(5)
	nA, nB := opNonce(t, f, 4), opNonce(t, f, 4)
	cl.PinObjectCAS(ctx, f.sk, same5, 4, nA) // copy A: applied, reply dropped
	cl.PinObjectCAS(ctx, f.sk, same5, 4, nB) // copy B: 412, reply dropped
	sa, ea = cl.PinObjectCAS(ctx, f.sk, same5, 4, nA)
	_, eb = cl.PinObjectCAS(ctx, f.sk, same5, 4, nB)
	if ea != nil || !sa.Replayed || sa.Seq != 5 {
		t.Fatalf("copy A settlement: %+v %v", sa, ea)
	}
	clientCAS(t, eb, "seq", ptr(uint64(5)))

	// GET /fence answers must never be cached (the nonce and the head are per answer)
	u, _, err := app.Sign(f.sk, time.Now().Add(time.Minute), http.MethodGet, f.cluster.Indexer.AppURL+"/fence", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(u.String())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("GET /fence: %d Cache-Control %q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
}

// opNonce fetches a fresh op nonce, asserting the head the caller expects.
func opNonce(t *testing.T, f *fenceAPI, head uint64) accounts.OpID {
	t.Helper()
	st, err := f.client.Fence(t.Context(), f.sk)
	if err != nil || st.Seq != head {
		t.Fatalf("fence %+v %v", st, err)
	}
	return *st.OpNonce
}
