// portprobe: the release lab's vsock port preflight that does not depend on vsock_diag. `ss --vsock -ln` lists nothing
// on a host without that module, so a check built on it passes vacuously (enclave-d1). This BINDS each given host vsock
// port and releases it at once: a port that cannot be bound is held by someone else, and the lab refuses to start.
// Pass only the LAB's ports: binding production's, even for a moment, could race a production guestd starting.
package main

import (
	"fmt"
	"os"
	"strconv"

	"enclave.host/isolation/m2/vsock"
)

func main() {
	held := false
	for _, a := range os.Args[1:] {
		p, err := strconv.ParseUint(a, 10, 32)
		if err != nil {
			fmt.Fprintf(os.Stderr, "portprobe: %q is not a port\n", a)
			os.Exit(2)
		}
		l, err := vsock.Listen(uint32(p))
		if err != nil {
			fmt.Printf("held %d: %v\n", p, err)
			held = true
			continue
		}
		l.Close()
	}
	if held {
		os.Exit(1)
	}
}
