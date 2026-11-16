package capacity

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestKeccak256(t *testing.T) {
	for in, want := range map[string]string{
		"":                                      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
		"abc":                                   "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
		string(bytes.Repeat([]byte{0xa3}, 135)): "",
		string(bytes.Repeat([]byte{0xa3}, 136)): "",
		string(bytes.Repeat([]byte{0xa3}, 137)): "",
	} {
		got := keccak256([]byte(in))
		if want != "" && hex.EncodeToString(got[:]) != want {
			t.Fatalf("keccak256(%q) = %x, want %s", in, got, want)
		}
	}
	// the block boundary: three lengths around the rate give three digests
	a, b, c := keccak256(bytes.Repeat([]byte{0xa3}, 135)), keccak256(bytes.Repeat([]byte{0xa3}, 136)), keccak256(bytes.Repeat([]byte{0xa3}, 137))
	if a == b || b == c || a == c {
		t.Fatal("digests around the rate collide")
	}
}
