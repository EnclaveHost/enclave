package main

// The measured chain reader every front can build (untagged): bootstrap.MeasuredConfig's chain, pinned ledger and RPC
// origins, reached only through this guest's egress, with TLS to the measured roots. The direct builds use it for their
// startup authority (shieldReader); the relay-release fronts use it for the lease's writer authority when the relay did
// not deliver it (writerauthority.go).

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m2/egress"
)

func measuredReader(roots *x509.CertPool, eg func() (net.Conn, error)) (*bootstrap.Reader, error) {
	conf := bootstrap.MeasuredConfig(nil)
	// the measured origins, plus the history sources of a VERIFIED owner-committed startup package (bootstrap
	// AllowOrigin, called only by Authorize after the owner's commitment matched)
	var mu sync.Mutex
	allowed := make(map[string]bool)
	for _, raw := range conf.RPCs {
		u, e := url.Parse(raw)
		if e != nil {
			return nil, e
		}
		allowed[net.JoinHostPort(u.Hostname(), "443")] = true
	}
	tr := &http.Transport{Proxy: nil, DisableCompression: true,
		TLSClientConfig:     &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 10 * time.Second,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			mu.Lock()
			ok := allowed[addr]
			mu.Unlock()
			if !ok || ctx.Err() != nil {
				return nil, errors.New("unmeasured bootstrap RPC origin")
			}
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return egress.DialOrigin(eg, egress.Origin{Host: host})
		}}
	conf.Client = &http.Client{Transport: tr}
	conf.AllowOrigin = func(hostport string) {
		mu.Lock()
		allowed[hostport] = true
		mu.Unlock()
	}
	return bootstrap.NewReader(conf)
}
