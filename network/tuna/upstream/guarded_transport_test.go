package tuna

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestProviderDialDoesNotFallBack(t *testing.T) {
	denied := errors.New("guard down")
	calls := 0
	c := &Common{TcpDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		calls++
		if network != tcp4 || address != "192.0.2.1:443" {
			t.Fatalf("unexpected probe destination %s %s", network, address)
		}
		return nil, denied
	}}
	if _, err := c.dialProviderTCP(context.Background(), "192.0.2.1:443"); !errors.Is(err, denied) || calls != 1 {
		t.Fatalf("guard error changed or direct fallback attempted: %v, calls=%d", err, calls)
	}
}

func TestGuardedUDPRefusedBeforeAnyConnection(t *testing.T) {
	c := &Common{Service: &Service{UDP: []uint32{53}}, TcpDialContext: func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("UDP must be refused before a connection is attempted")
		return nil, nil
	}}
	if err := c.UpdateServerConn(nil); err == nil {
		t.Fatal("guarded UDP accepted")
	}
}
