package release

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCustodyAuthLines(t *testing.T) {
	var id, bind [32]byte
	id[0], bind[31] = 0xd1, 0x7f
	var buf bytes.Buffer
	if err := WriteAuthRequest(&buf, id, bind); err != nil {
		t.Fatal(err)
	}
	gid, gb, err := ReadAuthRequest(&buf)
	if err != nil || gid != id || gb != bind {
		t.Fatalf("request round trip: %v", err)
	}
	sig := "0x" + strings.Repeat("ab", 65)
	buf.Reset()
	if err := WriteAuth(&buf, CustodyAuth{Endpoint: "https://api.enclave.host/t/metal0 x", Sig: sig, Expiry: 1}); err == nil {
		t.Fatal("an endpoint with a space was written")
	}
	if err := WriteAuth(&buf, CustodyAuth{Endpoint: "https://api.enclave.host/t/metal0", Sig: sig, Expiry: 1800000000}); err != nil {
		t.Fatal(err)
	}
	a, err := ReadAuth(&buf)
	if err != nil || a.Endpoint != "https://api.enclave.host/t/metal0" || a.Sig != sig || a.Expiry != 1800000000 {
		t.Fatalf("auth round trip: %+v %v", a, err)
	}
	for _, bad := range []string{
		"custody-auth-v1 0x" + strings.Repeat("d1", 32) + " " + strings.Repeat("AB", 32) + "\n", // uppercase binding
		"custody-auth-v1 " + strings.Repeat("d1", 32) + " " + strings.Repeat("ab", 32) + "\n",   // id without 0x
		"custody-auth-v1 0x" + strings.Repeat("d1", 32) + " " + strings.Repeat("ab", 31) + "\n", // short binding
		"ticket-v1 0x" + strings.Repeat("d1", 32) + " " + strings.Repeat("ab", 32) + "\n",       // another protocol
	} {
		if _, _, err := ReadAuthRequest(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	for _, bad := range []string{
		"custody-sig-v1 aHR0cHM6Ly94 0 " + sig + "\n",
		"custody-sig-v1 aHR0cHM6Ly94 5 0x" + strings.Repeat("ab", 64) + "\n",
		"custody-sig-v1 !! 5 " + sig + "\n",
	} {
		if _, err := ReadAuth(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestCustodyAuthLinesV2(t *testing.T) {
	var vault [20]byte
	var id, bind [32]byte
	vault[0], id[0], bind[31] = 0x08, 0xd1, 0x7f
	var buf bytes.Buffer
	if err := WriteAuthRequestV2(&buf, vault, id, bind); err != nil {
		t.Fatal(err)
	}
	line := buf.String()
	a, err := ReadAnyAuthRequest(&buf)
	if err != nil || a.V != 2 || a.Vault != "0x08"+strings.Repeat("00", 19) || a.ID != id || a.Binding != bind {
		t.Fatalf("v2 round trip %q: %+v %v", line, a, err)
	}
	// the v1-only reader refuses a v2 line; the any reader takes v1 unchanged
	if _, _, err := ReadAuthRequest(strings.NewReader(line)); err == nil {
		t.Fatal("the v1 reader took a v2 line")
	}
	buf.Reset()
	WriteAuthRequest(&buf, id, bind)
	if a, err := ReadAnyAuthRequest(&buf); err != nil || a.V != 1 || a.Vault != "" || a.ID != id || a.Binding != bind {
		t.Fatalf("v1 via the any reader: %+v %v", a, err)
	}
	v, d, b := "0x"+strings.Repeat("08", 20), "0x"+strings.Repeat("d1", 32), strings.Repeat("ab", 32)
	for _, bad := range []string{
		"custody-auth-v2 " + d + " " + b + "\n",                                    // no vault
		"custody-auth-v2 0x" + strings.Repeat("08", 19) + " " + d + " " + b + "\n", // short vault
		"custody-auth-v2 " + strings.Repeat("08", 21) + " " + d + " " + b + "\n",   // vault without 0x
		"custody-auth-v2 0x" + strings.Repeat("AB", 20) + " " + d + " " + b + "\n", // uppercase vault
		"custody-auth-v2 " + v + " " + strings.Repeat("d1", 32) + " " + b + "\n",   // id without 0x
		"custody-auth-v2 " + v + " " + d + " " + strings.ToUpper(b) + "\n",         // uppercase binding
		"custody-auth-v1 " + v + " " + d + " " + b + "\n",                          // v1 with a vault
		"custody-auth-v2 " + v + " " + d + " " + b + " extra\n",
	} {
		if _, err := ReadAnyAuthRequest(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// a v2 pointer as the relay would write it: 2 Enclave machines + 2 others -> 3 seats, t = 2, indices 1,1,2,3
func v2Pointer() map[string]any {
	machine := func(k byte, enclave bool, idx ...uint32) map[string]any {
		return map[string]any{"encKey": strings.Repeat(fmt.Sprintf("%02x", k), 32), "endpoint": fmt.Sprintf("https://c%d.example", k),
			"enclave": enclave, "indices": idx}
	}
	return map[string]any{"v": 2, "vault": "0x08074300F75e78212ae10ebd14984f78e17811a6", "chainId": 8453,
		"committeeId": "0x" + strings.Repeat("c0", 32), "epoch": 5, "t": 2, "policyRev": "2", "secretRev": "3",
		"bundle": "0x" + strings.Repeat("ab", 200), "commitments": strings.Repeat("02", 66),
		"machines": []any{machine(0xe1, true, 1), machine(0xe2, true, 1), machine(0xe3, false, 2), machine(0xe4, false, 3)}}
}

func parsePointer(t *testing.T, p map[string]any) (*CustodyV2, error) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"id": "0x" + strings.Repeat("d1", 32), "custody": p})
	var r Release
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	return r.Custody.V2()
}

func TestCustodyPointerV2(t *testing.T) {
	c, err := parsePointer(t, v2Pointer())
	if err != nil {
		t.Fatal(err)
	}
	if c.ChainID != 8453 || c.Vault[0] != 0x08 || c.Vault[3] != 0x00 || c.CommitteeID[0] != 0xc0 || c.Epoch != 5 || c.T != 2 ||
		c.PolicyRev != 2 || c.SecretRev != 3 || len(c.Bundle) != 200 || len(c.Commitments) != 66 || len(c.Machines) != 4 ||
		!c.Machines[1].Enclave || c.Machines[3].Indices[0] != 3 || c.Machines[2].EncKey[0] != 0xe3 {
		t.Fatalf("%+v", c)
	}
	// n < 3: Enclave + one other -> t = 2, the Enclave seat holds 1,2
	small := v2Pointer()
	ms := small["machines"].([]any)
	ms[0].(map[string]any)["indices"] = []uint32{1, 2}
	ms[2].(map[string]any)["indices"] = []uint32{3}
	small["machines"] = []any{ms[0], ms[2]}
	if _, err := parsePointer(t, small); err != nil {
		t.Fatalf("Enclave + one other: %v", err)
	}

	set := func(k string, v any) map[string]any { p := v2Pointer(); p[k] = v; return p }
	idx := func(i int, v any) map[string]any {
		p := v2Pointer()
		p["machines"].([]any)[i].(map[string]any)["indices"] = v
		return p
	}
	mf := func(i int, k string, v any) map[string]any {
		p := v2Pointer()
		p["machines"].([]any)[i].(map[string]any)[k] = v
		return p
	}
	for name, p := range map[string]map[string]any{
		"t too low":              set("t", 1),
		"t too high":             set("t", 3),
		"no chain":               set("chainId", 0),
		"bad vault":              set("vault", "0x1234"),
		"uppercase committee":    set("committeeId", "0x"+strings.Repeat("C0", 32)),
		"committee without 0x":   set("committeeId", strings.Repeat("c0", 32)),
		"zero committee":         set("committeeId", "0x"+strings.Repeat("00", 32)),
		"no epoch":               set("epoch", 0),
		"zero policyRev":         set("policyRev", "0"),
		"numeric secretRev":      set("secretRev", 3),
		"leading zero secretRev": set("secretRev", "03"),
		"huge secretRev":         set("secretRev", "99999999999999999999"),
		"short bundle":           set("bundle", strings.Repeat("ab", 124)),
		"long bundle":            set("bundle", strings.Repeat("ab", MaxCustodyBundleBytes+1)),
		"bundle not hex":         set("bundle", strings.Repeat("zz", 200)),
		"commitments short":      set("commitments", strings.Repeat("02", 33)),
		"commitments uppercase":  set("commitments", strings.Repeat("0A", 66)),
		"no machines":            set("machines", []any{}),
		"enclave index wrong":    idx(1, []uint32{2}),
		"other index wrong":      idx(2, []uint32{3}),
		"extra index":            idx(3, []uint32{3, 4}),
		"no index":               idx(3, []uint32{}),
		"enclave flag flipped":   mf(2, "enclave", true),
		"short key":              mf(0, "encKey", strings.Repeat("e1", 31)),
		"repeated key":           mf(1, "encKey", strings.Repeat("e1", 32)),
		"http endpoint":          mf(0, "endpoint", "http://c.example"),
		"v1 fields in v2":        set("threshold", 2),
		"v1 members in v2":       set("members", []any{}),
		"v1 ciphertext in v2":    set("ciphertext", "AAAA"),
		"unknown version":        set("v", 3),
		"two others, no Enclave": set("machines", []any{v2Pointer()["machines"].([]any)[2], v2Pointer()["machines"].([]any)[3]}),
	} {
		if _, err := parsePointer(t, p); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	// a v1 pointer stays v1, and refuses v2 fields
	v1 := &Custody{ChainID: 8453, Vault: "0x" + strings.Repeat("5e", 20), PolicyRev: "9", SecretRev: "4", Epoch: 1, Threshold: 3, C0: "02", Ciphertext: "AA"}
	if v, err := v1.Version(); err != nil || v != 1 {
		t.Fatalf("v1: %d %v", v, err)
	}
	if _, err := v1.V2(); err == nil {
		t.Fatal("a v1 pointer parsed as v2")
	}
	v1.Bundle = "ab"
	if _, err := v1.Version(); err == nil {
		t.Fatal("a v1 pointer with a v2 bundle field was accepted")
	}
}
