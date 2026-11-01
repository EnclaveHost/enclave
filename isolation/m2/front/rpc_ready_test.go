//go:build linux && amd64

package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

func readyFixture(t *testing.T) (*rpcReadyDelivery, *os.File, *rpcStartApproval) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("isolated root user namespace required")
	}
	b := contract.RPCStartBinding{AppID: [32]byte{1}, RuntimeID: [32]byte{2}, Deployment: [32]byte{3}, Nonce: [32]byte{4}}
	frame, _ := b.Frame()
	ar, aw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ar.Close(); aw.Close() })
	a := &rpcStartApproval{writer: aw, fd: int(aw.Fd()), frame: frame}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close(); w.Close() })
	fd, err := syscall.Dup(int(w.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	ready, err := rpcReadyFromFD(fd, a)
	if err != nil {
		syscall.Close(fd)
		t.Fatal(err)
	}
	w.Close()
	t.Cleanup(func() { ready.writer.Close() })
	return ready, r, a
}

func TestRPCReadyActualHealthAndPrivateDelivery(t *testing.T) {
	r, reader, a := readyFixture(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, rpcHealthy)
	}))
	defer server.Close()
	check := func(ctx context.Context) error { return rpcHealth(ctx, strings.TrimPrefix(server.URL, "http://")) }
	if _, err := r.sample(context.Background(), check); err == nil || calls != 0 {
		t.Fatal("health before owner approval")
	}
	if err := a.approve(); err != nil {
		t.Fatal(err)
	}
	observed, err := r.sample(context.Background(), check)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal(calls)
	}
	if err = r.publish(observed); err != nil {
		t.Fatal(err)
	}
	if r.publish(observed) == nil {
		t.Fatal("readiness replayed")
	}
	raw, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	record, err := contract.ParseRPCLocalReady(raw)
	if err != nil {
		t.Fatal(err)
	}
	now, err := rpcReadyNow()
	if err != nil {
		t.Fatal(err)
	}
	if record.ObservedMono != observed || record.Validate(r.binding, now) != nil {
		t.Fatal(record)
	}
}

func TestRPCReadyFailedHealthAndStaleDelivery(t *testing.T) {
	r, reader, a := readyFixture(t)
	if err := a.approve(); err != nil {
		t.Fatal(err)
	}
	if _, err := r.sample(context.Background(), func(context.Context) error { return errors.New("syncing") }); err == nil {
		t.Fatal("unhealthy accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.sample(ctx, func(context.Context) error { return nil }); err == nil {
		t.Fatal("cancelled observation accepted")
	}
	now, err := rpcReadyNow()
	if err != nil {
		t.Fatal(err)
	}
	if r.publish(now-uint64(4*time.Second)) == nil {
		t.Fatal("old observation refreshed")
	}
	if r.publish(now) == nil {
		t.Fatal("failed delivery retried")
	}
	raw, err := io.ReadAll(reader)
	if err != nil || len(raw) != 0 {
		t.Fatal("failed observation wrote bytes", err)
	}
}

func TestRPCReadyRequiresDistinctWritableCapability(t *testing.T) {
	r, reader, a := readyFixture(t)
	defer r.writer.Close()
	for _, fd := range []int{a.fd, int(reader.Fd()), -1} {
		if _, err := rpcReadyFromFD(fd, a); err == nil {
			t.Fatal("bad readiness capability", fd)
		}
	}
}
