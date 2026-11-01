//go:build native_desktop

package main

import (
	"bufio"
	"bytes"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The measured native launcher starts its companion gateway before creating
// the secret pipe. Its fixed loopback listener is owned by the dedicated role,
// and the measured nftables policy permits only the controller UID to call it.
// No app port, extra listener, wildcard bind, or UDP socket is admitted here.
func auditShieldListeners(procNet string, want []netip.AddrPort) error {
	gateway := netip.MustParseAddrPort("127.0.0.1:19080")
	raw, err := os.ReadFile(filepath.Join(procNet, "tcp"))
	if err != nil {
		return errors.New("native gateway socket table unavailable")
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	if !scanner.Scan() {
		return errors.New("native gateway socket table has no header")
	}
	found := 0
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			return errors.New("native gateway socket table malformed")
		}
		if fields[3] != "0A" {
			continue
		}
		addr, err := procAddr(fields[1])
		if err != nil {
			return errors.New("native gateway socket address malformed")
		}
		if addr != gateway {
			continue
		}
		if len(fields) < 10 {
			return errors.New("native gateway socket metadata missing")
		}
		uid, err := strconv.ParseUint(fields[7], 10, 32)
		if err != nil || uid != 1002 {
			return errors.New("native gateway socket owner differs")
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil || inode == 0 {
			return errors.New("native gateway socket inode missing")
		}
		found++
	}
	if scanner.Err() != nil || found != 1 {
		return errors.New("one native gateway listener required")
	}
	allowed := append(append([]netip.AddrPort(nil), want...), gateway)
	return auditListeners(procNet, allowed)
}
