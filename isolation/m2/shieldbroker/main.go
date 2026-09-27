// The measured guest broker. No host-supplied addresses, plaintext engine API,
// network listener, or CUDA device. Routes are fixed by this release.
package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"enclave.host/isolation/m2/shieldbridge"
	"enclave.host/isolation/m2/vsock"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	if err := os.MkdirAll("/run/enclave-shield", 0755); err != nil {
		os.Exit(1)
	}
	result := make(chan error, 2)
	for i, port := range []uint32{9501, 9502} {
		b := shieldbridge.Bridge{Path: fmt.Sprintf("/run/enclave-shield/gpu%d", i), UID: 1000,
			Dial: func(ctx context.Context) (net.Conn, error) {
				ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				defer cancel()
				return vsock.DialContext(ctx, vsock.CIDHost, port)
			}}
		ready := make(chan error, 1)
		go func() { result <- b.Serve(ctx, ready) }()
		if err := <-ready; err != nil {
			fmt.Fprintln(os.Stderr, "Shield broker startup refused")
			cancel()
			os.Exit(1)
		}
	}
	// The readiness message contains no input or worker reply bytes.
	fmt.Println("Shield private worker routes ready")
	select {
	case <-ctx.Done():
	case <-result:
		cancel()
		os.Exit(1)
	}
}
