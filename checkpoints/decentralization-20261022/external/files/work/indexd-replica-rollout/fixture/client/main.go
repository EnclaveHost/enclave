// Command rolloutclient drives the rollout fixture's indexd over its REAL application API with the seeded account's
// signed identity (the disposable app key in fixture/secrets/app-key.hex). It prints JSON results only: never the
// app key, a receipt or a signed URL.
//
//	rolloutclient -url http://127.0.0.1:59982 -key secrets/app-key.hex -state secrets/client-state.json <step>
//
// Steps:
//
//	identity       the account the key signs for exists (GET /account)
//	raise          install a fence (backfill numbers the existing events); saves the credential (0600)
//	fenced-pin     pin a NEW object (a new slice of an existing seeded slab) with the credential
//	stock-refused  an unfenced pin on the fenced account must be refused 409
//	seq            the commit-ordered listing: head and event count
//	objects        every key recorded so far is readable (GET /objects/:key)
//	unfenced-pin   (after rollback, stock binary) an unfenced pin is accepted again
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
	Keys       []string `json:"keys"`                 // object keys known to be acknowledged
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

	switch step {
	case "identity":
		a, err := c.Account(ctx, sk)
		check(err)
		out["accountKeyMatches"] = a.AccountKey == proto.Account(sk.PublicKey())
	case "raise":
		var f accounts.Fence
		binary.BigEndian.PutUint64(f[:8], 17<<48|1)
		binary.BigEndian.PutUint64(f[8:16], 1)
		frand.Read(f[16:])
		r, err := c.RaiseFence(ctx, sk, f)
		check(err)
		cred := r.Credential()
		st.Credential = cred.String()
		out["head"] = r.Seq
	case "fenced-pin", "stock-refused", "unfenced-pin":
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
		pc := c
		if step == "fenced-pin" {
			cred, err := accounts.ParseCredential(st.Credential)
			check(err)
			pc = c.WithFence(&cred)
		}
		err = pc.PinObject(ctx, sk, o)
		var he *app.HTTPError
		switch {
		case step == "stock-refused":
			out["refused409"] = errors.As(err, &he) && he.StatusCode == 409
			out["body"] = refusalBody(he)
		case err != nil:
			fail(err.Error())
		default:
			id := o.ID()
			st.Keys = append(st.Keys, id.String())
			out["pinned"] = id.String()
		}
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
	return he.Body[:min(len(he.Body), 120)]
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
	fmt.Fprintln(os.Stderr, "rolloutclient:", msg)
	os.Exit(1)
}
