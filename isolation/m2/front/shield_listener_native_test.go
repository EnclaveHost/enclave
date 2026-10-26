//go:build native_desktop

package main

import (
	"net/netip"
	"strings"
	"testing"
)

const nativeGatewayRow = "0: 0100007F:4A88 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1002 0 12345 1\n"
const nativeForwardRow = "1: 0200407F:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1053577 0 12346 1\n"

func TestNativeShieldListenerAudit(t *testing.T) {
	want := []netip.AddrPort{netip.MustParseAddrPort("127.64.0.2:443")}
	tests := []struct {
		name, tcp, tcp6, udp string
		ok                   bool
	}{
		{name: "fixed gateway and forwarder", tcp: nativeGatewayRow + nativeForwardRow, ok: true},
		{name: "no gateway", tcp: nativeForwardRow},
		{name: "wrong owner", tcp: strings.Replace(nativeGatewayRow, " 1002 ", " 5001 ", 1) + nativeForwardRow},
		{name: "root owner", tcp: strings.Replace(nativeGatewayRow, " 1002 ", " 0 ", 1) + nativeForwardRow},
		{name: "wildcard gateway", tcp: strings.Replace(nativeGatewayRow, "0100007F", "00000000", 1) + nativeForwardRow},
		{name: "wrong port", tcp: strings.Replace(nativeGatewayRow, "4A88", "4A89", 1) + nativeForwardRow},
		{name: "duplicate gateway", tcp: nativeGatewayRow + nativeGatewayRow + nativeForwardRow},
		{name: "missing forwarder", tcp: nativeGatewayRow},
		{name: "extra app listener", tcp: nativeGatewayRow + nativeForwardRow + strings.Replace(nativeGatewayRow, "4A88", "1F40", 1)},
		{name: "UDP", tcp: nativeGatewayRow + nativeForwardRow, udp: strings.Replace(nativeGatewayRow, " 0A ", " 07 ", 1)},
		{name: "IPv6", tcp: nativeGatewayRow + nativeForwardRow, tcp6: "2: 00000000000000000000000001000000:1F40 00000000000000000000000000000000:0000 0A 0 0 0 1002 0 12\n"},
		{name: "missing inode", tcp: strings.Replace(nativeGatewayRow, "12345", "0", 1) + nativeForwardRow},
		{name: "missing uid", tcp: "0: 0100007F:4A88 00000000:0000 0A\n" + nativeForwardRow},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := auditShieldListeners(writeTables(t, map[string]string{"tcp": tt.tcp, "tcp6": tt.tcp6, "udp": tt.udp, "udp6": ""}), want)
			if (err == nil) != tt.ok {
				t.Fatalf("audit passed=%v, want %v", err == nil, tt.ok)
			}
		})
	}
	if err := auditListeners(writeTables(t, map[string]string{"tcp": nativeGatewayRow + nativeForwardRow}), want); err == nil {
		t.Fatal("generic audit admitted native gateway")
	}
}
