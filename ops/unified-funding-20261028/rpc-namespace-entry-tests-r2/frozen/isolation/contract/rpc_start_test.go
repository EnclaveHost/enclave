package contract

import "testing"

func TestRPCStartBindingWire(t *testing.T) {
	b := RPCStartBinding{AppID: [32]byte{1}, RuntimeID: [32]byte{2}, Deployment: [32]byte{3}, Nonce: [32]byte{4}}
	f, err := b.Frame()
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseRPCStartBinding(f)
	if err != nil || got != b {
		t.Fatal(got, err)
	}
	for _, mode := range []string{"short", "extra", "magic", "zero-app", "zero-runtime", "zero-deployment", "zero-nonce"} {
		x := append([]byte{}, f...)
		switch mode {
		case "short":
			x = x[:135]
		case "extra":
			x = append(x, 0)
		case "magic":
			x[0]++
		case "zero-app":
			clear(x[8:40])
		case "zero-runtime":
			clear(x[40:72])
		case "zero-deployment":
			clear(x[72:104])
		case "zero-nonce":
			clear(x[104:])
		}
		if _, err = ParseRPCStartBinding(x); err == nil {
			t.Fatal("invalid frame accepted", mode)
		}
	}
}
