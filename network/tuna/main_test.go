package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRejectInvalidPaymentLimits(t *testing.T) {
	for _, c := range []config{
		{MaxPrice: "-1", MinBalance: "1"},
		{MaxPrice: "0.001", MinBalance: "-1"},
		{MaxPrice: "0.001", MinBalance: "invalid"},
		{MaxPrice: "0,1,2", MinBalance: "1"},
	} {
		c.SeedFile = "seed"
		c.RPC = []string{"https://rpc.example"}
		file := filepath.Join(t.TempDir(), "config.json")
		b, _ := json.Marshal(c)
		if err := os.WriteFile(file, b, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readConfig(file); err == nil {
			t.Fatalf("accepted invalid payment limits: %#v", c)
		}
	}
}

func TestRejectInvalidRoutes(t *testing.T) {
	for _, routes := range [][]route{
		{{ID: "a", TCP: []uint32{0}}}, {{ID: "a", TCP: []uint32{65536}}},
		{{ID: "a", TCP: []uint32{22, 22}}}, {{ID: "a", TCP: []uint32{22}}, {ID: "a", TCP: []uint32{80}}},
		{{ID: "../socket", TCP: []uint32{22}}}, {{ID: "a", UDP: []uint32{53}, Forward: true}},
	} {
		if validateRoutes(routes) == nil {
			t.Fatalf("accepted invalid routes: %#v", routes)
		}
	}
}
func TestAcceptMultipleProtocolsAndWithdrawal(t *testing.T) {
	if err := validateRoutes([]route{{ID: "app", TCP: []uint32{22, 80, 443}, UDP: []uint32{53, 27015}, RandomPorts: true}}); err != nil {
		t.Fatal(err)
	}
	if err := validateRoutes(nil); err != nil {
		t.Fatal(err)
	}
}

func TestGuardPolicyCannotFallBackOrPinAnIPAddress(t *testing.T) {
	for _, extra := range []string{
		`"requireGuard":true`,
		`"guardSocks":"proxy.example:1080"`,
		`"allowProviders":["198.51.100.1"]`,
		`"denyProviders":["unverified-name"]`,
	} {
		p := filepath.Join(t.TempDir(), "config.json")
		os.WriteFile(p, []byte(`{"seedFile":"seed","maxPrice":"0.0002","rpc":["https://rpc.example"],`+extra+`}`), 0600)
		if _, err := readConfig(p); err == nil {
			t.Fatalf("accepted unsafe policy: %s", extra)
		}
	}
	p := filepath.Join(t.TempDir(), "config.json")
	os.WriteFile(p, []byte(`{"seedFile":"seed","maxPrice":"0.0002","rpc":["https://rpc.example"],"requireGuard":true,"guardSocks":"127.0.0.1:30489","allowProviders":["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]}`), 0600)
	if _, err := readConfig(p); err != nil {
		t.Fatal(err)
	}
}

func TestIndependentPublicTCPMapping(t *testing.T) {
	if err := validateRoutes([]route{{ID: "app:primary", TCP: []uint32{31234}, PublicTCP: []uint32{443}}}); err != nil {
		t.Fatal(err)
	}
	for _, r := range []route{
		{ID: "app", TCP: []uint32{31234}, PublicTCP: []uint32{443}, Forward: true},
		{ID: "app", TCP: []uint32{31234}, PublicTCP: []uint32{443}, RandomPorts: true},
		{ID: "app", TCP: []uint32{31234}, PublicTCP: []uint32{443, 80}},
		{ID: "app", TCP: []uint32{31234}, PublicTCP: []uint32{0}},
	} {
		if validateRoutes([]route{r}) == nil {
			t.Fatalf("accepted ambiguous mapping: %#v", r)
		}
	}
}
