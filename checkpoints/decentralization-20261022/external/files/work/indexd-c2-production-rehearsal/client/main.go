// Command c2rclient drives the C2 production-copy rehearsal's indexd over its REAL application and admin APIs with
// FIXTURE credentials only: a disposable app key it registers itself (admin connect key + pre-authorized key, the
// real app-connection flow) and the rehearsal's generated admin password. Derived from the C2 package's c2client
// (work/indexd-c2-implementation/package/fixture/client). It never touches a production account's objects and prints
// JSON counts/booleans only: never a key, receipt, signed URL, host key or object content.
//
//	c2rclient -app http://127.0.0.1:9982 -admin http://127.0.0.1:9980/api -admin-pw <file> -state <file> <step> [arg]
//
// Steps:
//
//	register             admin connect key + pre-authorized key, then app connect/register (a NEW fixture account)
//	pin-slab <hostsfile> pin a fixture 10-of-30 slab whose sectors name good production hosts (public keys, from a 0600
//	                     file, one hex key per line); stock (unfenced) request
//	raise | raise-cas    install a higher fence (v3) | with mode "cas" (enrols)
//	raise-plain-refused  a higher raise without mode must be refused 412 mode
//	fence-state          GET /fence: head, mode, lastOp recorded/ours, capabilities, opNonce present
//	cas-pin              a NEW object (a fresh slice of the fixture slab) as v4, op = a fresh opNonce (R2 rule N1)
//	cas-replay           resend the saved operation byte for byte: 200 replayed, same head
//	cas-altered          same op/sq, other metadata: 412 op
//	cas-stale            a new op at head-1: 412 seq
//	v3-refused           a v3 pin with the exact credential: 412 mode
//	stock-refused        an unfenced pin: 409
//	share-v4 | share-v3-refused  add a sharing key as v4 (non-advancing, no sq) | as v3 (412 mode)
//	fenced-pin           a v3 pin with the exact credential (accepted only where the account is not enrolled)
//	unfenced-pin         a stock pin (accepted only where the account has no fence: after the rollback to 26)
//	block | unblock      admin blocklist add/remove of the first fixture object's key (reason "c2-rehearsal")
//	blocked-check        admin entry present + 451 on reading the blocked key
//	objects              every fixture key known is readable (the blocked one is reported separately)
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/api/admin"
	"go.sia.tech/indexd/api/app"
	"go.sia.tech/indexd/sharing"
	"go.sia.tech/indexd/slabs"
	"lukechampine.com/frand"
)

type state struct {
	AppSeed    string               `json:"appSeed,omitempty"`    // disposable fixture app key (file is 0600; never printed)
	Credential string               `json:"credential,omitempty"` // token||receipt (never printed)
	Counter    uint64               `json:"counter"`
	Slab       *slabs.SlabPinParams `json:"slab,omitempty"`
	NextSlice  uint32               `json:"nextSlice"`
	Keys       []string             `json:"keys"`
	Blocked    string               `json:"blocked,omitempty"`
	LastObject *slabs.SealedObject  `json:"lastObject,omitempty"`
	LastSq     uint64               `json:"lastSq"`
	LastOp     string               `json:"lastOp,omitempty"`
}

func main() {
	appURL := flag.String("app", "", "application API URL")
	adminURL := flag.String("admin", "", "admin API URL")
	adminPW := flag.String("admin-pw", "", "file holding the FIXTURE admin password")
	stateFile := flag.String("state", "", "client state file (0600)")
	flag.Parse()
	step := flag.Arg(0)
	var st state
	if b, err := os.ReadFile(*stateFile); err == nil {
		check(json.Unmarshal(b, &st))
	}
	pw, err := os.ReadFile(*adminPW)
	check(err)
	adm := admin.NewClient(*adminURL, strings.TrimSpace(string(pw)))
	c := app.NewClient(*appURL, app.WithEnableCBOR(false))
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out := map[string]any{"step": step}

	var sk types.PrivateKey
	if st.AppSeed != "" {
		seed, err := hex.DecodeString(st.AppSeed)
		check(err)
		sk = types.NewPrivateKeyFromSeed(seed)
	}
	cred := func() *accounts.Credential {
		cr, err := accounts.ParseCredential(st.Credential)
		check(err)
		return &cr
	}
	nextFence := func() accounts.Fence {
		st.Counter++
		var f accounts.Fence
		binary.BigEndian.PutUint64(f[:8], 0x7c<<48|1) // a FIXTURE generation (nothing production-derived)
		binary.BigEndian.PutUint64(f[8:16], st.Counter)
		frand.Read(f[16:])
		return f
	}
	newObject := func() slabs.SealedObject {
		if st.Slab == nil {
			fail("no fixture slab")
		}
		o := slabs.SealedObject{
			EncryptedDataKey: frand.Bytes(72), EncryptedMetadataKey: frand.Bytes(72), EncryptedMetadata: frand.Bytes(40),
			Slabs: []slabs.SlabSlice{st.Slab.Slice(st.NextSlice*4096, 4096)},
		}
		st.NextSlice++
		o.Sign(sk)
		return o
	}
	conflict := func(err error, status int, kind string) bool {
		var he *app.HTTPError
		if errors.As(err, &he) {
			out["status"] = he.StatusCode
			if kind != "" {
				out["conflict"] = strings.Contains(he.Body, `"conflict":"`+kind+`"`)
			}
		}
		return he != nil && he.StatusCode == status && (kind == "" || strings.Contains(he.Body, `"conflict":"`+kind+`"`))
	}
	firstKey := func() types.Hash256 {
		if len(st.Keys) == 0 {
			fail("no fixture object")
		}
		var k types.Hash256
		check(k.UnmarshalText([]byte(st.Keys[0])))
		return k
	}

	switch step {
	case "register":
		if st.AppSeed != "" {
			fail("already registered")
		}
		qs, err := adm.Quotas(ctx, 0, 100)
		check(err)
		if len(qs) == 0 {
			fail("no quota defined")
		}
		quota := qs[0].Key
		for _, q := range qs {
			if q.Key == "default" {
				quota = q.Key
			}
		}
		ck, err := adm.AddAppConnectKey(ctx, accounts.AppConnectKeyRequest{Description: "c2-rehearsal fixture", Quota: quota})
		check(err)
		appID := types.Hash256(frand.Entropy256())
		pre := types.GeneratePrivateKey()
		req := accounts.PreAuthorizedKeyRequest{ConnectKey: ck.Key, Expiration: time.Now().Add(time.Hour), TotalUses: 1, AllowedAppID: &appID}
		req.Sign(pre)
		_, err = adm.AddPreAuthorizedKey(ctx, req)
		check(err)
		eph := types.GeneratePrivateKey()
		var seed [32]byte
		frand.Read(seed[:])
		sk = types.NewPrivateKeyFromSeed(seed[:])
		info := app.Info{AppID: appID, Name: "c2-rehearsal-fixture", Description: "C2 production-copy rehearsal fixture", ServiceURL: "https://fixture.invalid"}
		resp, err := c.RequestAppConnection(ctx, eph, info, app.WithPreAuthorizedKey(pre))
		check(err)
		status, err := c.RequestStatus(ctx, eph, resp.StatusURL)
		check(err)
		if !status.Approved {
			fail("pre-authorized request not approved")
		}
		check(c.RegisterApp(ctx, resp.RegisterURL, eph, sk))
		st.AppSeed = hex.EncodeToString(seed[:])
		ok, err := c.CheckAppAuth(ctx, sk)
		check(err)
		a, err := c.Account(ctx, sk)
		check(err)
		out["registered"], out["accountKeyMatches"] = ok, a.AccountKey == proto.Account(sk.PublicKey())
	case "pin-slab":
		b, err := os.ReadFile(flag.Arg(1))
		check(err)
		var hks []types.PublicKey
		for _, l := range strings.Fields(string(b)) {
			raw, err := hex.DecodeString(l)
			check(err)
			var hk types.PublicKey
			copy(hk[:], raw)
			hks = append(hks, hk)
		}
		if len(hks) == 0 {
			fail("no good hosts")
		}
		p := slabs.SlabPinParams{EncryptionKey: frand.Entropy256(), MinShards: 10}
		for i := range 30 {
			p.Sectors = append(p.Sectors, slabs.PinnedSector{Root: frand.Entropy256(), HostKey: hks[i%len(hks)]})
		}
		ids, err := c.PinSlabs(ctx, sk, p)
		check(err)
		st.Slab = &p
		out["pinned"], out["distinctGoodHostsUsed"] = len(ids), min(len(hks), 30)
	case "raise", "raise-cas":
		mode := ""
		if step == "raise-cas" {
			mode = accounts.ModeCAS
		}
		r, err := c.RaiseFenceMode(ctx, sk, nextFence(), mode)
		check(err)
		st.Credential = r.Credential().String()
		out["head"], out["mode"] = r.Seq, r.Mode
	case "raise-plain-refused":
		_, err := c.RaiseFence(ctx, sk, nextFence())
		out["refused412mode"] = conflict(err, 412, "mode")
	case "fence-state":
		fs, err := c.Fence(ctx, sk)
		if he := (*app.HTTPError)(nil); errors.As(err, &he) {
			out["status"] = he.StatusCode // the ORIGINAL v26 binary has no /fence
			break
		}
		check(err)
		out["head"], out["mode"], out["lastOpRecorded"], out["capabilities"] = fs.Seq, fs.Mode, fs.LastOp != nil, fs.Capabilities
		out["fenced"], out["opNonce"] = fs.Fence != nil, fs.OpNonce != nil
		if st.LastOp != "" && fs.LastOp != nil {
			out["lastOpIsOurs"] = fs.LastOp.String() == st.LastOp
		}
	case "cas-pin":
		o := newObject()
		fs, err := c.Fence(ctx, sk)
		check(err)
		if fs.OpNonce == nil {
			fail("no opNonce: refusing (R2 rule N3)")
		}
		sq, op := fs.Seq, *fs.OpNonce
		res, err := c.WithFence(cred()).PinObjectCAS(ctx, sk, o, sq, op)
		check(err)
		st.LastObject, st.LastSq, st.LastOp = &o, sq, op.String()
		st.Keys = append(st.Keys, o.ID().String())
		out["sq"], out["seq"], out["replayed"] = sq, res.Seq, res.Replayed
	case "cas-replay", "cas-altered":
		if st.LastObject == nil {
			fail("no saved v4 operation")
		}
		op, err := accounts.ParseOpID(st.LastOp)
		check(err)
		o := *st.LastObject
		if step == "cas-altered" {
			o.EncryptedMetadata = frand.Bytes(40)
			o.Sign(sk)
		}
		res, err := c.WithFence(cred()).PinObjectCAS(ctx, sk, o, st.LastSq, op)
		if step == "cas-altered" {
			out["refused412op"] = conflict(err, 412, "op")
			break
		}
		check(err)
		out["sq"], out["seq"], out["replayed"] = st.LastSq, res.Seq, res.Replayed
	case "cas-stale":
		fs, err := c.Fence(ctx, sk)
		check(err)
		if fs.Seq == 0 || fs.OpNonce == nil {
			fail("head 0 or no opNonce")
		}
		_, err = c.WithFence(cred()).PinObjectCAS(ctx, sk, newObject(), fs.Seq-1, *fs.OpNonce)
		out["refused412seq"] = conflict(err, 412, "seq")
	case "v3-refused", "stock-refused", "fenced-pin", "unfenced-pin":
		o := newObject()
		pc := c
		if step == "v3-refused" || step == "fenced-pin" {
			pc = c.WithFence(cred())
		}
		err := pc.PinObject(ctx, sk, o)
		switch step {
		case "v3-refused":
			out["refused412mode"] = conflict(err, 412, "mode")
		case "stock-refused":
			out["refused409"] = conflict(err, 409, "")
		default:
			check(err)
			st.Keys = append(st.Keys, o.ID().String())
			out["pinned"] = true
		}
	case "share-v4", "share-v3-refused":
		nonce := sharing.Nonce(frand.Bytes(32))
		priv := sharing.DeriveSharingKey(sk, nonce)
		kr := sharing.KeyRequest{PublicKey: priv.PublicKey(), Nonce: nonce, Description: "c2-rehearsal"}
		kr.Sign(priv)
		cl := c.WithFence(cred())
		if step == "share-v4" {
			var op accounts.OpID
			fs, err := c.Fence(ctx, sk)
			check(err)
			op = *fs.OpNonce
			status, err := v4Request(ctx, *appURL, sk, "POST", "/sharing", kr, *cred(), op)
			check(err)
			out["status"], out["added"] = status, status == 200
			break
		}
		_, err := cl.AddSharingKey(ctx, sk, kr)
		out["refused412mode"] = conflict(err, 412, "mode")
	case "block", "unblock":
		k := firstKey()
		if step == "block" {
			check(adm.ObjectBlocklistAdd(ctx, k, "c2-rehearsal"))
			st.Blocked = k.String()
		} else {
			check(adm.ObjectBlocklistRemove(ctx, k))
			st.Blocked = ""
		}
		out["ok"] = true
	case "blocked-check":
		k := firstKey()
		e, err := adm.ObjectBlocklistEntry(ctx, k)
		out["adminEntryPresent"] = err == nil && e.Key == k && e.Reason == "c2-rehearsal"
		_, rerr := c.Object(ctx, sk, k)
		out["read451"] = conflict(rerr, 451, "")
	case "objects":
		ok, blocked := 0, 0
		for _, k := range st.Keys {
			var id types.Hash256
			check(id.UnmarshalText([]byte(k)))
			if _, err := c.Object(ctx, sk, id); err == nil {
				ok++
			} else if k == st.Blocked {
				blocked++
			} else {
				out["missing"] = true
			}
		}
		out["readable"], out["blockedUnreadable"], out["known"] = ok, blocked, len(st.Keys)
	default:
		fail("unknown step " + step)
	}
	b, err := json.Marshal(st)
	check(err)
	check(os.WriteFile(*stateFile, b, 0o600))
	j, _ := json.Marshal(out)
	fmt.Println(string(j))
}

// v4Request sends ONE v4 request without sq (a non-advancing route), signed independently here from the published
// interface section 2 layout (the frozen app client has no v4 form for these routes):
//
//	WriteString("indexd/fence/v4") WriteString(method) WriteString(host) WriteString(path) WriteUint64(sv)
//	Write(credential 48) WriteUint64(flags = 0) WriteUint64(sq = 0) Write(op 16) WriteBytes(body)
func v4Request(ctx context.Context, base string, sk types.PrivateKey, method, path string, body any, sf accounts.Credential, op accounts.OpID) (int, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	u, err := url.Parse(base + path)
	if err != nil {
		return 0, err
	}
	sv := time.Now().Add(time.Minute)
	h := types.NewHasher()
	h.E.WriteString(accounts.RequestHashDomainV4)
	h.E.WriteString(method)
	h.E.WriteString(u.Host)
	h.E.WriteString(u.Path)
	h.E.WriteUint64(uint64(sv.Unix()))
	cb := sf.Bytes()
	h.E.Write(cb[:])
	h.E.WriteUint64(0)
	h.E.WriteUint64(0)
	h.E.Write(op[:])
	h.E.WriteBytes(buf)
	sig := sk.SignHash(h.Sum())
	pk := sk.PublicKey()
	q := url.Values{}
	q.Set("sf", sf.String())
	q.Set("op", op.String())
	q.Set("sv", fmt.Sprint(sv.Unix()))
	q.Set("sc", base64.URLEncoding.EncodeToString(pk[:]))
	q.Set("ss", base64.URLEncoding.EncodeToString(sig[:]))
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(buf))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, errors.New("v4 request failed") // the error would carry the signed URL
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

func check(err error) {
	if err != nil {
		fail(err.Error())
	}
}

func fail(msg string) {
	if i := strings.Index(msg, "?"); i >= 0 { // never print a signed query
		msg = msg[:i] + "?<redacted>"
	}
	fmt.Fprintln(os.Stderr, "c2rclient:", msg)
	os.Exit(1)
}
