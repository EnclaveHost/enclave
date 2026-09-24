package contract

import (
	"strings"
	"testing"
)

// A bundle states how its domain runs it: served (wasi:http, no port) or a command that listens itself (wasi:cli,
// exactly one port). Anything in between is refused, and a bundle built before the field keeps its bytes.
func TestTheWorldAndPortAreStatedExactly(t *testing.T) {
	comp := []byte("\x00asm\x0d\x00\x01\x00 component")
	build := func(world string, port int) ([]byte, error) {
		return Build(Manifest{ABI: ABI, World: world, HTTP: port, Policy: Policy{CPUPercent: 100, MemMiB: 256, Vcpus: 1}}, comp)
	}
	for _, c := range []struct {
		world string
		port  int
		ok    bool
	}{{"wasi:http", 0, true}, {"", 0, true}, {"wasi:cli", 8000, true}, {"wasi:cli", 49999, true},
		{"wasi:http", 8000, false}, {"", 8000, false}, {"wasi:cli", 0, false}, {"wasi:cli", 50000, false}, {"wasi:cli", -1, false},
		{"wasi:other", 0, false}} {
		b, err := build(c.world, c.port)
		if err != nil {
			t.Fatal(err)
		}
		m, _, err := Parse(b)
		if (err == nil) != c.ok {
			t.Errorf("world %q http %d: parse error %v, want ok=%v", c.world, c.port, err, c.ok)
		}
		if err == nil && (m.World != c.world || m.HTTP != c.port) {
			t.Errorf("world %q http %d parsed as %q %d", c.world, c.port, m.World, m.HTTP)
		}
	}
	// the port is omitted from a served bundle's manifest, so bundles from before the field are byte-identical
	b, _ := build("wasi:http", 0)
	if strings.Contains(string(b), `"http"`) {
		t.Fatal("a served bundle's manifest carries an http field")
	}
}
