//go:build linux

package desktopworker

import (
	"context"
	"errors"
	"testing"
)

func TestHostDialCancellationDoesNotPanic(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// Exercise the real vsock adapter without opening a socket. A typed nil
	// *vsock.Conn must not become a non-nil net.Conn on the error path: dialConn
	// closes connections returned alongside an error before rejecting the dial.
	conn, err := dialConn(ctx, dialHost)
	if conn != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("failed host dial returned (%v, %v), want (nil, context canceled)", conn, err)
	}
}
