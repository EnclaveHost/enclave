// Command c2client drives the G-C2 fixture's indexd over its REAL application API with the seeded account's signed
// identity (the disposable app key in fixture/secrets/app-key.hex). Derived from the replica rollout's rolloutclient
// (work/indexd-replica-rollout/fixture/client), with the G-C2 steps added. It prints JSON results only: never the app
// key, a receipt or a signed URL.
//
//	c2client -url http://127.0.0.1:59992 -key secrets/app-key.hex -state secrets/client-state.json <step>
//
// Steps (v3 / stock, as rolloutclient):
//
//	identity       the account the key signs for exists (GET /account)
//	raise          install a higher fence WITHOUT mode (v3); saves the credential (0600)
//	fenced-pin     pin a NEW object with the credential (v3 form)
//	stock-refused  an unfenced pin on the fenced account must be refused 409
//	seq            the commit-ordered listing: head and event count
//	objects        every key recorded so far is readable (GET /objects/:key)
//	unfenced-pin   an unfenced pin (accepted on an unfenced account / after a rollback to stock)
//	add-key <hex>  record an acknowledged key
//
// G-C2 steps:
//
//	fence-state         GET /fence: head, mode, whether a last op is recorded, capabilities
//	raise-cas           install a higher fence with mode "cas" (enrols); saves the credential
//	raise-plain-refused a higher raise WITHOUT mode must be refused 412 mode (no downgrade)
//	cas-pin             pin a NEW object as v4 at the current head, op = a fresh opNonce (R2); saves it for replay
//	cas-replay          resend the saved operation: must answer 200 replayed with the same head
//	cas-altered         the saved op id and sq with other metadata: must be refused 412 op
//	cas-stale           a NEW op at head-1: must be refused 412 seq
//	v3-refused          a v3 (fence-only) pin with the exact credential must be refused 412 mode
package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/api/app"
	"go.sia.tech/indexd/slabs"
	"lukechampine.com/frand"
)

type state struct {
	Credential string   `json:"credential,omitempty"` // token||receipt hex (file is 0600; never printed)
	Counter    uint64   `json:"counter"`              // the last raised fence counter
	Keys       []string `json:"keys"`                 // object keys known to be acknowledged
	// the last v4 pin, exactly (for the replay steps)
	LastObject *slabs.SealedObject `json:"lastObject,omitempty"`
	LastSq     uint64              `json:"lastSq"`
	LastOp     string              `json:"lastOp,omitempty"`
}

func main() {
	url := flag.String("url", "", "advertised application API URL")
	keyFile := flag.String("key", "", "file holding the app key seed (hex)")
	stateFile := flag.String("state", "", "client state file (0600)")
	flag.Parse()
	step := flag.Arg(0)
	b, err := os.ReadFile(*keyFile)
	check(err)
	seed, err := hex.DecodeString(strings.TrimSpace(string(b)))
	check(err)
	sk := types.NewPrivateKeyFromSeed(seed)
	var st state
	if b, err := os.ReadFile(*stateFile); err == nil {
		check(json.Unmarshal(b, &st))
	}
	c := app.NewClient(*url, app.WithEnableCBOR(false))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out := map[string]any{"step": step}
	cred := func() *accounts.Credential {
		cr, err := accounts.ParseCredential(st.Credential)
		check(err)
		return &cr
	}
	nextFence := func() accounts.Fence {
		st.Counter++
		var f accounts.Fence
		binary.BigEndian.PutUint64(f[:8], 17<<48|1)
		binary.BigEndian.PutUint64(f[8:16], st.Counter)
		frand.Read(f[16:])
		return f
	}
	newObject := func() slabs.SealedObject {
		// a new object: a fresh slice of a slab the account already pins (taken from an acknowledged object)
		if len(st.Keys) == 0 {
			fail("no known object keys")
		}
		var base types.Hash256
		check(base.UnmarshalText([]byte(st.Keys[0])))
		obj, err := c.Object(ctx, sk, base)
		check(err)
		o := slabs.SealedObject{
			EncryptedDataKey: frand.Bytes(72), EncryptedMetadataKey: frand.Bytes(72), EncryptedMetadata: frand.Bytes(40),
			Slabs: []slabs.SlabSlice{obj.Slabs[0]},
		}
		o.Slabs[0].Offset = uint32(frand.Intn(1023)) * 4096 // within the seeded 1-of-1 slab (4 MiB of data)
		o.Slabs[0].Length = 4096
		o.Sign(sk)
		return o
	}
	conflict := func(err error, status int, kind string) bool {
		var he *app.HTTPError
		if errors.As(err, &he) {
			out["status"], out["body"] = he.StatusCode, refusalBody(he)
		}
		return he != nil && he.StatusCode == status && (kind == "" || strings.Contains(he.Body, `"conflict":"`+kind+`"`))
	}

	switch step {
	case "identity":
		a, err := c.Account(ctx, sk)
		check(err)
		out["accountKeyMatches"] = a.AccountKey == proto.Account(sk.PublicKey())
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
		check(err)
		out["head"], out["mode"], out["lastOpRecorded"], out["capabilities"] = fs.Seq, fs.Mode, fs.LastOp != nil, fs.Capabilities
		out["fenced"] = fs.Fence != nil
		if st.LastOp != "" && fs.LastOp != nil {
			out["lastOpIsOurs"] = fs.LastOp.String() == st.LastOp
		}
	case "fenced-pin", "stock-refused", "unfenced-pin", "v3-refused":
		o := newObject()
		pc := c
		if step == "fenced-pin" || step == "v3-refused" {
			pc = c.WithFence(cred())
		}
		err = pc.PinObject(ctx, sk, o)
		switch {
		case step == "stock-refused":
			out["refused409"] = conflict(err, 409, "")
		case step == "v3-refused":
			out["refused412mode"] = conflict(err, 412, "mode")
		case err != nil:
			fail(err.Error())
		default:
			id := o.ID()
			st.Keys = append(st.Keys, id.String())
			out["pinned"] = id.String()
		}
	case "cas-pin":
		// G-C2 R2 rule N1: a new invocation takes its op from a fresh opNonce (fetched after it began)
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
		h := fs.Seq
		if h == 0 || fs.OpNonce == nil {
			fail("head 0 or no opNonce")
		}
		op := *fs.OpNonce
		_, err = c.WithFence(cred()).PinObjectCAS(ctx, sk, newObject(), h-1, op)
		out["refused412seq"] = conflict(err, 412, "seq")
	case "seq":
		l, err := c.ListObjectsSeq(ctx, sk, 0, 1000)
		check(err)
		out["head"], out["events"] = l.Head, len(l.Events)
	case "objects":
		ok := 0
		for _, k := range st.Keys {
			var id types.Hash256
			check(id.UnmarshalText([]byte(k)))
			if _, err := c.Object(ctx, sk, id); err == nil {
				ok++
			} else {
				out["missing"] = k
			}
		}
		out["readable"], out["known"] = ok, len(st.Keys)
	case "add-key":
		st.Keys = append(st.Keys, flag.Arg(1))
		out["known"] = len(st.Keys)
	default:
		fail("unknown step " + step)
	}
	b, err = json.Marshal(st)
	check(err)
	check(os.WriteFile(*stateFile, b, 0o600))
	j, _ := json.Marshal(out)
	fmt.Println(string(j))
}

func refusalBody(he *app.HTTPError) string {
	if he == nil {
		return ""
	}
	return he.Body[:min(len(he.Body), 160)]
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
	fmt.Fprintln(os.Stderr, "c2client:", msg)
	os.Exit(1)
}
