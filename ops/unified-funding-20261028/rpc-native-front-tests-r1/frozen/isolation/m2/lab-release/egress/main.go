// The release LAB's egress router: the host side of a LAB image's egress (front EgressPort under -tags releaselab),
// on vsock host port 19443. It speaks the guest's egress-v1 header and forwards exactly ONE name - the lab relay
// (release.RelayHost in the lab build) - to the lab relay's port on this host's loopback; every other destination is
// refused. guestd's own egress server refuses loopback by design, which is why a lab image never uses it.
//
// Like guestd's, its log carries the guest's CID and an outcome, never a destination. LAB ONLY: nothing here runs in
// production, and a production image never dials this port.
package main

import (
	"bufio"
	"flag"
	"io"
	"log"
	"net"
	"strings"
	"time"

	"enclave.host/isolation/m2/vsock"
)

func main() {
	port := flag.Uint("port", 19443, "the vsock host port a lab image's egress uses")
	relayName := flag.String("relay-name", "release-lab.enclave.test", "the one name forwarded (the lab build's release.RelayHost)")
	relayAddr := flag.String("relay-addr", "", "the lab relay's loopback address, host:port (required)")
	flag.Parse()
	if h, _, err := net.SplitHostPort(*relayAddr); err != nil || !net.ParseIP(h).IsLoopback() {
		log.Fatal("-relay-addr must be a loopback host:port: this router reaches the lab relay on this host and nothing else")
	}
	l, err := vsock.Listen(uint32(*port))
	if err != nil {
		log.Fatalf("vsock %d: %v", *port, err)
	}
	log.Printf("lab egress router on vsock %d: forwards only the lab relay name", *port)
	for {
		c, err := l.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go handle(c, *relayName, *relayAddr)
	}
}

func handle(g net.Conn, name, addr string) {
	defer g.Close()
	cid := uint32(0)
	if a, ok := g.RemoteAddr().(vsock.Addr); ok {
		cid = a.CID
	}
	g.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReaderSize(g, 300)
	line, err := br.ReadString('\n')
	f := strings.Fields(line)
	if err != nil || len(f) != 3 || f[0] != "egress-v1" || f[2] != "443" || f[1] != name {
		log.Printf("guest %d egress refused", cid)
		io.WriteString(g, "refused\n")
		return
	}
	g.SetReadDeadline(time.Time{})
	up, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		log.Printf("guest %d egress refused:connect", cid)
		io.WriteString(g, "refused\n")
		return
	}
	defer up.Close()
	log.Printf("guest %d egress open (lab relay)", cid)
	io.WriteString(g, "ok\n")
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, br); done <- struct{}{} }()
	go func() { io.Copy(g, up); done <- struct{}{} }()
	<-done
}
