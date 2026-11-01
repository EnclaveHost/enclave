package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
)

// Read again only to extract the full deployment binding, requiring the same
// complete AppID already derived from loaded code. A changed file cannot change
// the identity being authorized. The measured namespace must keep these files
// immutable, as for the front's existing loaded-code identity check.
func loadedRPCDeployment(path string, appID []byte) ([32]byte, error) {
	var id [32]byte
	f, err := os.Open(path)
	if err != nil {
		return id, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, contract.MaxRPCControllerBytes+(1<<20)+1))
	if err != nil {
		return id, err
	}
	if len(b) > contract.MaxRPCControllerBytes+(1<<20) {
		return id, errors.New("RPC bundle limit")
	}
	sum := contract.AppID(b)
	if !bytes.Equal(appID, sum[:]) {
		return id, errors.New("RPC bundle changed after loaded-code identity")
	}
	m, _, err := contract.ParseRPC(b)
	if err != nil {
		return id, err
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(m.SecretDeployment, "0x"))
	if err != nil || len(raw) != 32 {
		return id, errors.New("RPC full deployment identity required")
	}
	copy(id[:], raw)
	if id == [32]byte{} {
		return id, errors.New("RPC deployment is zero")
	}
	return id, nil
}

// No DNS prefix participates: the full deployment comes from the loaded V9
// bundle. Package bytes still undergo the existing chain/owner authorization.
func readRPCPackage(ctx context.Context, packages func() (net.Conn, error), id [32]byte) ([]byte, error) {
	if packages == nil || id == [32]byte{} {
		return nil, errors.New("RPC bound deployment and package transport required")
	}
	c, err := packages()
	if err != nil {
		return nil, errors.New("RPC package transport unavailable")
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	deadline := time.Now().Add(15 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err = c.SetDeadline(deadline); err != nil {
		return nil, err
	}
	return bootstrap.ReadPackage(c, id)
}

// Fresh off-chain health, not ledger Running, storage authority or attestation.
// No proxy/DNS/redirect/cache and one deadline covers connection through body.
func rpcHealth(ctx context.Context, upstream string) error {
	host, port, err := net.SplitHostPort(upstream)
	if err != nil || host != "127.0.0.1" {
		return errors.New("RPC health requires fixed loopback")
	}
	if _, err = netip.ParseAddrPort(host + ":" + port); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 11*time.Second)
	defer cancel()
	tr := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{}).DialContext, DisableKeepAlives: true, DisableCompression: true, MaxResponseHeaderBytes: 1024}
	defer tr.CloseIdleConnections()
	cl := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+upstream+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/json" || resp.ContentLength > 512 {
		return errors.New("RPC health not ready")
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 513))
	if err != nil {
		return err
	}
	if len(b) > 512 {
		return errors.New("RPC health body limit")
	}
	return rpcHealthBody(b)
}
func rpcHealthBody(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("RPC health object required")
	}
	seen := map[string]bool{}
	ready := false
	var chains []int
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return errors.New("duplicate RPC health field")
		}
		seen[key] = true
		switch key {
		case "localReady":
			err = d.Decode(&ready)
		case "chains":
			err = d.Decode(&chains)
		default:
			return errors.New("unknown RPC health field")
		}
		if err != nil {
			return err
		}
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return errors.New("RPC health incomplete")
	}
	var extra any
	if err = d.Decode(&extra); err != io.EOF {
		return errors.New("RPC health trailing data")
	}
	if len(seen) != 2 || !ready || len(chains) != 2 || chains[0] != 1 || chains[1] != 8453 {
		return errors.New("local RPC stack is not ready")
	}
	return nil
}
