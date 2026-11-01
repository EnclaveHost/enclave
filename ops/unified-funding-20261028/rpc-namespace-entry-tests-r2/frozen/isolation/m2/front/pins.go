//go:build !releaselab

package main

// EgressPort is the host (vsock CID 2) port of guestd's egress server. A lab build (-tags releaselab, pins_lab.go)
// sends its egress to a lab port instead, where a lab router reaches the lab relay on the host's loopback - which
// guestd's own egress server refuses, as it must.
const EgressPort = 9443
