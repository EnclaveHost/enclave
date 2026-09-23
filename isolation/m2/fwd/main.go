// fwd: the host side of an M2 domain's one port. It relays a host TCP port to the domain's vsock
// port and holds no key: what it moves is TLS ciphertext.
//
//	-tee <file>        records every byte it relays untouched, so a test can check the host saw no plaintext
//	-mitm              the attack the attestation exists to catch: the host terminates TLS itself with its
//	                   own key and re-encrypts to the domain, reading everything in between
//	-switch-after <n>  relay the first n connections untouched, then MITM every later one: a client that
//	                   attested the domain's key and later reconnects meets the host's key instead
//	-mitm-tee <file>   the plaintext the host reads on MITM'd connections (what a client leaked to it)
package main

import (
	"crypto/sha256"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"

	"enclave.host/isolation/m2/domtls"
	"enclave.host/isolation/m2/vsock"
)

type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "host TCP address to accept on")
	cid := flag.Uint("cid", 0, "the domain's vsock CID")
	port := flag.Uint("port", 443, "the domain's vsock port")
	teePath := flag.String("tee", "", "append every byte relayed untouched to this file")
	mitm := flag.Bool("mitm", false, "terminate TLS on the host with a host key (attack model)")
	switchAfter := flag.Int64("switch-after", 0, "relay this many connections untouched, then MITM the rest")
	mitmTeePath := flag.String("mitm-tee", "", "append the plaintext read on MITM'd connections to this file")
	flag.Parse()
	if *cid == 0 {
		fmt.Fprintln(os.Stderr, "fwd: -cid is required")
		os.Exit(2)
	}

	tee, mitmTee := teeTo(*teePath), teeTo(*mitmTeePath)
	var hostTLS *tls.Config
	if *mitm || *switchAfter > 0 {
		cert, spki, err := domtls.Mint("enclave-domain")
		if err != nil {
			fmt.Fprintln(os.Stderr, "fwd:", err)
			os.Exit(1)
		}
		hostTLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}
		fmt.Printf("FWD mitm host key spki_sha256=%x\n", sha256.Sum256(spki))
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fwd:", err)
		os.Exit(1)
	}
	fmt.Printf("FWD listening %s -> vsock %d:%d mitm=%v\n", ln.Addr(), *cid, *port, *mitm)
	for {
		c, err := ln.Accept()
		if err != nil {
			fmt.Fprintln(os.Stderr, "fwd:", err)
			os.Exit(1)
		}
		go func() {
			defer c.Close()
			up, err := vsock.Dial(uint32(*cid), uint32(*port))
			if err != nil { // domain not listening (yet): the client sees a closed connection and retries
				fmt.Fprintln(os.Stderr, "fwd:", err)
				return
			}
			defer up.Close()
			n := conns.Add(1) // numbered once the domain answered, so boot-time retries do not count
			if *mitm || (*switchAfter > 0 && n > *switchAfter) {
				fmt.Printf("FWD conn %d mitm\n", n)
				// Present the host key to the client first, then open the domain's TLS: each handshake
				// completes (or fails, logged) before a byte of plaintext is relayed either way.
				ts := tls.Server(c, hostTLS)
				if err := ts.Handshake(); err != nil {
					fmt.Printf("FWD conn %d mitm client handshake: %v\n", n, err)
					return
				}
				tc := tls.Client(up, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
				if err := tc.Handshake(); err != nil {
					fmt.Printf("FWD conn %d mitm domain handshake: %v\n", n, err)
					return
				}
				relay(ts, tc, mitmTee)
			} else {
				fmt.Printf("FWD conn %d relay\n", n)
				relay(c, up, tee)
			}
		}()
	}
}

var conns atomic.Int64

func teeTo(path string) io.Writer {
	if path == "" {
		return io.Discard
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fwd:", err)
		os.Exit(1)
	}
	return &lockedWriter{w: f}
}

func relay(a, b io.ReadWriter, tee io.Writer) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(b, io.TeeReader(a, tee)); done <- struct{}{} }()
	go func() { io.Copy(a, io.TeeReader(b, tee)); done <- struct{}{} }()
	<-done // either side ending ends the relay; the deferred closes unblock the other copy
}
