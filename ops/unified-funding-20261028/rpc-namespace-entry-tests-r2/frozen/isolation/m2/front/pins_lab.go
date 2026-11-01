//go:build releaselab

package main

// EgressPort, LAB build: the lab egress router (isolation/m2/lab-release/egress), which reaches the lab relay on the
// host's loopback. guestd's egress server (9443) refuses loopback by design, so a lab image never uses it.
const EgressPort = 19443
