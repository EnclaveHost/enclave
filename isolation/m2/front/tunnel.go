package main

// TLS terminates inside this measured front. Untrusted hops see ciphertext.
// Destinations come only from the measured bundle, never from client addresses.
import (
	"bufio"
	"bytes"
	"enclave.host/isolation/contract"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const tunnelPrefix = "/.well-known/enclave-tunnel/"
const tunnelProtocol = "enclave-port/1"
const tunnelIdle = 180 * time.Second
const maxDatagram = 65507

type portTunnels struct {
	allowed map[string]bool
	mu      sync.Mutex
	active  map[string]int
	total   int
}

func loadPortTunnels(path string, httpPort int) (*portTunnels, error) {
	t := &portTunnels{allowed: map[string]bool{}, active: map[string]int{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return t, nil
	}
	if err != nil {
		return nil, err
	}
	if len(b) == 0 || len(b) > 1024 || b[len(b)-1] != '\n' {
		return nil, fmt.Errorf("invalid measured ports file")
	}
	ports := strings.Split(string(b[:len(b)-1]), "\n")
	if err := contract.ValidatePorts(ports, contract.WorldCLI, httpPort); err != nil {
		return nil, err
	}
	for _, p := range ports {
		t.allowed[p] = true
	}
	return t, nil
}
func (t *portTunnels) acquire(key string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.total >= 128 || t.active[key] >= 32 {
		return false
	}
	t.total++
	t.active[key]++
	return true
}
func (t *portTunnels) release(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.total--
	t.active[key]--
}

type idleConn struct{ net.Conn }

func (c idleConn) Read(b []byte) (int, error) {
	c.SetReadDeadline(time.Now().Add(tunnelIdle))
	return c.Conn.Read(b)
}
func (c idleConn) Write(b []byte) (int, error) {
	c.SetWriteDeadline(time.Now().Add(tunnelIdle))
	return c.Conn.Write(b)
}

func (t *portTunnels) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	dest := strings.TrimPrefix(r.URL.Path, tunnelPrefix)
	proto, raw, ok := strings.Cut(dest, "/")
	n, err := strconv.Atoi(raw)
	key := proto + ":" + raw
	if !ok || err != nil || strconv.Itoa(n) != raw || t == nil || !t.allowed[key] || r.URL.RawQuery != "" {
		http.Error(w, "undeclared destination", http.StatusNotFound)
		return
	}
	if r.TLS == nil || r.Method != "GET" || r.ContentLength > 0 || len(r.TransferEncoding) != 0 ||
		!headerToken(r.Header.Get("Connection"), "upgrade") || r.Header.Get("Upgrade") != tunnelProtocol {
		http.Error(w, "TLS HTTP/1.1 upgrade required", http.StatusBadRequest)
		return
	}
	h, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "HTTP/1.1 required", http.StatusBadRequest)
		return
	}
	if !t.acquire(key) {
		http.Error(w, "tunnel limit", http.StatusServiceUnavailable)
		return
	}
	defer t.release(key)
	upstream, err := net.DialTimeout(proto, net.JoinHostPort("127.0.0.1", raw), 5*time.Second)
	if err != nil {
		http.Error(w, "app port unavailable", http.StatusBadGateway)
		return
	}
	defer upstream.Close()
	c, rw, err := h.Hijack()
	if err != nil {
		return
	}
	defer c.Close()
	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: " + tunnelProtocol + "\r\n\r\n"); err != nil {
		return
	}
	if err := rw.Flush(); err != nil {
		return
	}
	c.SetDeadline(time.Time{})
	if proto == "udp" {
		bridgeUDP(c, rw.Reader, upstream.(*net.UDPConn))
		return
	}
	// TCP half-close is an encrypted zero-length frame, never an outer TLS
	// EOF: existing opaque relays can close a connection on either TCP EOF.
	done := make(chan struct{})
	go func() {
		defer close(done)
		r := io.MultiReader(io.LimitReader(rw.Reader, int64(rw.Reader.Buffered())), idleConn{c})
		buf := make([]byte, maxDatagram)
		var h [2]byte
		for {
			if _, err := io.ReadFull(r, h[:]); err != nil {
				upstream.Close()
				return
			}
			n := int(binary.BigEndian.Uint16(h[:]))
			if n == 0 {
				_ = upstream.(*net.TCPConn).CloseWrite()
				return
			}
			if n > maxDatagram {
				upstream.Close()
				return
			}
			if _, err := io.ReadFull(r, buf[:n]); err != nil {
				upstream.Close()
				return
			}
			if _, err := io.CopyN(idleConn{upstream}, bytes.NewReader(buf[:n]), int64(n)); err != nil {
				upstream.Close()
				return
			}
		}
	}()
	buf := make([]byte, maxDatagram+2)
	for {
		n, err := (idleConn{upstream}).Read(buf[2:])
		if n > 0 {
			binary.BigEndian.PutUint16(buf[:2], uint16(n))
			if _, e := io.CopyN(idleConn{c}, bytes.NewReader(buf[:n+2]), int64(n+2)); e != nil {
				c.Close()
				upstream.Close()
				break
			}
		}
		if err != nil {
			if err == io.EOF {
				if _, e := (idleConn{c}).Write([]byte{0, 0}); e == nil {
					<-done
					return
				}
			}
			c.Close()
			upstream.Close()
			break
		}
	}
	<-done
}
func headerToken(value, want string) bool {
	for _, t := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(t), want) {
			return true
		}
	}
	return false
}

// One UDP association owns one connected UDP socket. A two-byte big-endian
// size preserves datagram boundaries, including empty datagrams. Oversized
// frames close the association before allocating attacker-sized storage.
func bridgeUDP(c net.Conn, buffered *bufio.Reader, u *net.UDPConn) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer u.Close()
		r := io.MultiReader(io.LimitReader(buffered, int64(buffered.Buffered())), idleConn{c})
		b := make([]byte, maxDatagram)
		var size [2]byte
		for {
			if _, err := io.ReadFull(r, size[:]); err != nil {
				return
			}
			n := int(binary.BigEndian.Uint16(size[:]))
			if n > maxDatagram {
				return
			}
			if _, err := io.ReadFull(r, b[:n]); err != nil {
				return
			}
			u.SetWriteDeadline(time.Now().Add(tunnelIdle))
			if _, err := u.Write(b[:n]); err != nil {
				return
			}
		}
	}()
	b := make([]byte, maxDatagram+2)
	for {
		u.SetReadDeadline(time.Now().Add(tunnelIdle))
		n, err := u.Read(b[2:])
		if err != nil {
			break
		}
		binary.BigEndian.PutUint16(b[:2], uint16(n))
		if _, err := io.CopyN(idleConn{c}, bytes.NewReader(b[:n+2]), int64(n+2)); err != nil {
			break
		}
	}
	c.Close()
	u.Close()
	<-done
}
