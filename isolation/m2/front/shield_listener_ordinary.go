//go:build !native_desktop

package main

import "net/netip"

func auditShieldListeners(procNet string, want []netip.AddrPort) error {
	return auditListeners(procNet, want)
}
