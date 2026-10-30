package bootstrap

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// names.appZone: the Go check accepts and refuses exactly what sdk/bootstrap/package.mjs does (testdata/appzone-vectors.json,
// read by test/app-zone-sdk.test.mjs too), and a valid package yields a grant carrying the selection and the lease identity
// the agreeing quorum read - never a name or zone (those come from HOST_DATA and the measured image).
func TestAppZoneNamesAgreeWithJavaScriptVectors(t *testing.T) {
	b, e := os.ReadFile("testdata/appzone-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var av struct {
		Cases []struct {
			Name, Manifest string
			Valid          bool
		}
	}
	if e = json.Unmarshal(b, &av); e != nil || len(av.Cases) < 15 {
		t.Fatalf("vectors: %v (%d)", e, len(av.Cases))
	}
	for _, c := range av.Cases {
		t.Run(c.Name, func(t *testing.T) {
			r, peers, v, id, loaded := rig(t)
			base, row := v.Manifest, v.Row
			if strings.Contains(c.Manifest, `"custody-v2"`) {
				base, row = v.CustodyManifest, v.Variants["custody"]
			}
			for _, p := range peers {
				p.row.Store(commit(t, row, base, c.Manifest))
			}
			a, e := r.Authorize(context.Background(), id, []byte(c.Manifest), loaded)
			if c.Valid != (e == nil) {
				t.Fatalf("valid=%v but Authorize: %v", c.Valid, e)
			}
			if !c.Valid {
				return
			}
			g, e := a.NameGrant()
			if e != nil || g.AppZone == nil || len(g.AppZone.Challenges) == 0 || g.Deployment != id {
				t.Fatalf("grant %+v %v", g, e)
			}
			lr := a.snapshot.row
			if g.Lease.Runner != lr.runner || g.Lease.Operator != strings.ToLower(lr.operator) || g.Lease.AppRef != lr.appRef || g.Lease.Envelope != lr.envelope {
				t.Fatalf("the grant's lease binding is not the quorum's row: %+v", g.Lease)
			}
		})
	}
}
