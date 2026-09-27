package main

import (
	"bufio"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testTunnel(t *testing.T, proto string, port int) (*httptest.Server, *portTunnels) {
	t.Helper()
	p := &portTunnels{allowed: map[string]bool{fmt.Sprintf("%s:%d", proto, port): true}, active: map[string]int{}}
	s := httptest.NewTLSServer(p)
	t.Cleanup(s.Close)
	return s, p
}
func upgrade(t *testing.T, s *httptest.Server, proto string, port int) (net.Conn, *bufio.Reader, int) {
	t.Helper()
	c, e := tls.Dial("tcp", s.Listener.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(c, "GET %s%s/%d HTTP/1.1\r\nHost: guest\r\nConnection: Upgrade\r\nUpgrade: %s\r\n\r\n", tunnelPrefix, proto, port, tunnelProtocol)
	r := bufio.NewReader(c)
	res, e := http.ReadResponse(r, nil)
	if e != nil {
		t.Fatal(e)
	}
	return c, r, res.StatusCode
}
func TestTunnelTCP(t *testing.T) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	go func() {
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c)
	}()
	port := l.Addr().(*net.TCPAddr).Port
	s, _ := testTunnel(t, "tcp", port)
	c, r, status := upgrade(t, s, "tcp", port)
	if status != 101 {
		t.Fatal(status)
	}
	payload := strings.Repeat("ssh-data-", 8192)
	go func() {
		for start := 0; start < len(payload); {
			end := start + 16000
			if end > len(payload) {
				end = len(payload)
			}
			frame := make([]byte, end-start+2)
			binary.BigEndian.PutUint16(frame, uint16(end-start))
			copy(frame[2:], payload[start:end])
			c.Write(frame)
			start = end
		}
		c.Write([]byte{0, 0})
	}()
	got := make([]byte, len(payload))
	offset := 0
	for offset < len(got) {
		var h [2]byte
		if _, e := io.ReadFull(r, h[:]); e != nil {
			t.Fatal(e)
		}
		n := int(binary.BigEndian.Uint16(h[:]))
		if n == 0 || n > len(got)-offset {
			t.Fatal("bad data frame", n)
		}
		if _, e := io.ReadFull(r, got[offset:offset+n]); e != nil {
			t.Fatal(e)
		}
		offset += n
	}
	var fin [2]byte
	if _, e := io.ReadFull(r, fin[:]); e != nil || fin != [2]byte{} {
		t.Fatal("missing FIN", e)
	}
	if string(got) != payload {
		t.Fatal("corrupt stream")
	}
	_, _, status = upgrade(t, s, "tcp", port+1)
	if status != 404 {
		t.Fatal("undeclared allowed", status)
	}
	_, _, status = upgrade(t, s, "udp", port)
	if status != 404 {
		t.Fatal("wrong protocol allowed", status)
	}
}
func TestTunnelUDP(t *testing.T) {
	u, e := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	defer u.Close()
	go func() {
		b := make([]byte, 65535)
		for {
			n, a, e := u.ReadFromUDP(b)
			if e != nil {
				return
			}
			u.WriteToUDP(b[:n], a)
		}
	}()
	port := u.LocalAddr().(*net.UDPAddr).Port
	s, _ := testTunnel(t, "udp", port)
	c, r, status := upgrade(t, s, "udp", port)
	if status != 101 {
		t.Fatal(status)
	}
	for _, payload := range []string{"", "one", strings.Repeat("video", 2000), "last"} {
		frame := make([]byte, len(payload)+2)
		binary.BigEndian.PutUint16(frame, uint16(len(payload)))
		copy(frame[2:], payload)
		// Split headers and body across TLS writes; framing must not depend on reads.
		c.Write(frame[:1])
		c.Write(frame[1:])
		var h [2]byte
		if _, e := io.ReadFull(r, h[:]); e != nil {
			t.Fatal(e)
		}
		b := make([]byte, int(binary.BigEndian.Uint16(h[:])))
		if _, e := io.ReadFull(r, b); e != nil {
			t.Fatal(e)
		}
		if string(b) != payload {
			t.Fatal("datagram boundary lost")
		}
	}
	c.Write([]byte{255, 255})
	if _, e := r.ReadByte(); e == nil {
		t.Fatal("oversized frame accepted")
	}
}
func TestTunnelLimitsAndPlaintext(t *testing.T) {
	p := &portTunnels{allowed: map[string]bool{"tcp:2222": true}, active: map[string]int{}}
	for i := 0; i < 32; i++ {
		if !p.acquire("tcp:2222") {
			t.Fatal(i)
		}
	}
	if p.acquire("tcp:2222") {
		t.Fatal("limit")
	}
	p.release("tcp:2222")
	if !p.acquire("tcp:2222") {
		t.Fatal("slot leaked")
	}
	r := httptest.NewRequest("GET", tunnelPrefix+"tcp/2222", nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", tunnelProtocol)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("plaintext allowed", w.Code)
	}
}
