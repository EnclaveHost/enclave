package guard

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestHostnameResolvedAtGuardAndEcho(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	request := make(chan []byte, 1)
	go func() {
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		b := make([]byte, 3)
		if _, e = io.ReadFull(c, b); e != nil {
			return
		}
		c.Write([]byte{5, 0})
		b = make([]byte, 4)
		if _, e = io.ReadFull(c, b); e != nil {
			return
		}
		if b[3] != 3 {
			request <- b
			return
		}
		var n [1]byte
		io.ReadFull(c, n[:])
		host := make([]byte, int(n[0]))
		io.ReadFull(c, host)
		request <- host
		io.ReadFull(c, make([]byte, 2))
		c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
		io.Copy(c, c)
	}()
	d, _ := New(l.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, err := d.DialContext(ctx, "tcp", "must-not-resolve.invalid:443")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if string(<-request) != "must-not-resolve.invalid" {
		t.Fatal("hostname was not passed to guard")
	}
	c.Write([]byte("echo"))
	got := make([]byte, 4)
	if _, err = io.ReadFull(c, got); err != nil || string(got) != "echo" {
		t.Fatalf("echo: %q %v", got, err)
	}
}

func TestNoDirectFallback(t *testing.T) {
	target, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer target.Close()
	dead, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	addr := dead.Addr().String()
	dead.Close()
	d, _ := New(addr)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if c, e := d.DialContext(ctx, "tcp", target.Addr().String()); e == nil {
		c.Close()
		t.Fatal("direct fallback succeeded")
	}
	target.(*net.TCPListener).SetDeadline(time.Now().Add(30 * time.Millisecond))
	if c, e := target.Accept(); e == nil {
		c.Close()
		t.Fatal("direct connection leaked")
	}
	if _, e := d.DialContext(ctx, "udp", target.Addr().String()); e == nil {
		t.Fatal("UDP accepted")
	}
}

func TestCanceledHandshakeClosesConnection(t *testing.T) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	closed := make(chan struct{})
	go func() {
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		io.Copy(io.Discard, c)
		close(closed)
	}()
	d, _ := New(l.Addr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, e := d.DialContext(ctx, "tcp", "example.invalid:443"); e == nil {
		t.Fatal("blocked handshake succeeded")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("canceled connection remained open")
	}
}
