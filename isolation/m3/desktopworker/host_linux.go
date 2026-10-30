//go:build linux

package desktopworker

import (
	"context"
	"enclave.host/isolation/m2/vsock"
	"net"
)

// AcquireHost is the fixed native NucBox transport. Its caller must already
// have established the dedicated T0-hv desktop profile and its allocation.
// CIDHost authenticates the host endpoint within that operator-trusted tier;
// it is not remote attestation and must not authorize a host-excluded SNP app.
func AcquireHost(ctx context.Context, b Binding) (*Lease, error) {
	return Acquire(ctx, b, dialHost)
}

func dialHost(ctx context.Context) (net.Conn, error) {
	conn, err := vsock.DialContext(ctx, vsock.CIDHost, 19595)
	if err != nil {
		// Preserve a nil interface on failure. Converting the nil *vsock.Conn
		// directly to net.Conn would make dialConn try to close a nil receiver.
		return nil, err
	}
	return conn, nil
}
