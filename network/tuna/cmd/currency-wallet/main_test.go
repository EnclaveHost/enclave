package main

import (
	"encoding/hex"
	"encoding/json"
	"github.com/nknorg/nkn/v2/transaction"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOfflineRoundTrip(t *testing.T) {
	file := filepath.Join(t.TempDir(), "seed")
	if e := os.WriteFile(file, []byte(strings.Repeat("03", 32)), 0600); e != nil {
		t.Fatal(e)
	}
	a, e := run(request{Action: "address"}, file)
	if e != nil {
		t.Fatal(e)
	}
	signed, e := run(request{Action: "prepare", Recipient: a.Address, Amount: "9007199254740993", Fee: "100000", Nonce: "9007199254740993"}, file)
	if e != nil {
		t.Fatal(e)
	}
	got, e := run(request{Action: "inspect", Raw: signed.Raw}, "")
	if e != nil || got != signed {
		t.Fatal(e, got)
	}
	wire, _ := hex.DecodeString(signed.Raw)
	tx := &transaction.Transaction{}
	if e = tx.Unmarshal(wire); e != nil {
		t.Fatal(e)
	}
	info, e := tx.GetInfo()
	if e != nil {
		t.Fatal(e)
	}
	got, e = run(request{Action: "inspect", Info: info}, "")
	if e != nil || got != signed {
		t.Fatal(e, got)
	}
	tx.UnsignedTx.Nonce++
	changed, _ := tx.Marshal()
	if _, e = run(request{Action: "inspect", Raw: hex.EncodeToString(changed)}, ""); e == nil {
		t.Fatal("accepted invalid signature")
	}
	var j map[string]any
	_ = json.Unmarshal(info, &j)
	j["hash"] = strings.Repeat("00", 32)
	bad, _ := json.Marshal(j)
	if _, e = run(request{Action: "inspect", Info: bad}, ""); e == nil {
		t.Fatal("accepted substituted hash")
	}
	for _, v := range []string{"-1", "01", "1e8", "9223372036854775808"} {
		if _, e = amount(v, false); e == nil {
			t.Fatalf("accepted %s", v)
		}
	}
	if _, e = run(request{Action: "validateAddress", Address: "0x" + strings.Repeat("11", 20)}, ""); e == nil {
		t.Fatal("accepted ERC20 address")
	}
}
