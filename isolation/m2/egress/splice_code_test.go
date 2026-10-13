package egress

import (
	"errors"
	"io"
	"net"
	"strings"
	"testing"
)

type failingReader struct {
	data []byte
	err  error
}

func (f *failingReader) Read(b []byte) (int, error) {
	if len(f.data) == 0 {
		return 0, f.err
	}
	n := copy(b, f.data)
	f.data = f.data[n:]
	return n, nil
}

// How a stream ended, named by side: a clean EOF both ways is "", an upstream that fails mid-reply is "b-read" and
// what it delivered first still reaches the guest.
func TestSpliceNamesTheSideThatFailed(t *testing.T) {
	ga, gb := net.Pipe()
	ua, ub := net.Pipe()
	got := make(chan string, 1)
	go func() { b, _ := io.ReadAll(gb); got <- string(b) }()
	code := splice(ga, ga, ua, &failingReader{data: []byte("partial reply"), err: errors.New("connection reset")})
	ub.Close()
	if code != "b-read" {
		t.Fatalf("code %q, want b-read", code)
	}
	if s := <-got; s != "partial reply" {
		t.Fatalf("guest got %q", s)
	}
	if c := copyCode(io.Discard, strings.NewReader("all of it"), "r", "w"); c != "" {
		t.Fatalf("clean EOF gave %q", c)
	}
	pr, pw := io.Pipe()
	pr.Close()
	if c := copyCode(pw, strings.NewReader("x"), "r", "w"); c != "w" {
		t.Fatalf("failed write gave %q", c)
	}
}
