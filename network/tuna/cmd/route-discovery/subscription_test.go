package main

import (
	"bytes"
	"context"
	"errors"
	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/nkn/v2/transaction"
	"os"
	"path/filepath"
	"testing"
)

type fakeWallet struct {
	*nkn.Wallet
	height     int32
	expiration int32
	nonceCalls int
	sendError  error
	sent       [][]byte
}

func (f *fakeWallet) GetHeightContext(context.Context) (int32, error) { return f.height, nil }
func (f *fakeWallet) GetSubscriptionContext(context.Context, string, string) (*nkn.Subscription, error) {
	return &nkn.Subscription{ExpiresAt: f.expiration}, nil
}
func (f *fakeWallet) GetNonceContext(context.Context, bool) (int64, error) {
	f.nonceCalls++
	return int64(f.nonceCalls), nil
}
func (f *fakeWallet) SendRawTransactionContext(_ context.Context, tx *transaction.Transaction) (string, error) {
	b, _ := tx.Marshal()
	f.sent = append(f.sent, b)
	return "signed-transaction", f.sendError
}
func testWallet(t *testing.T) *fakeWallet {
	t.Helper()
	a, e := nkn.NewAccount(bytes.Repeat([]byte{7}, 32))
	if e != nil {
		t.Fatal(e)
	}
	w, e := nkn.NewWallet(a, nil)
	if e != nil {
		t.Fatal(e)
	}
	return &fakeWallet{Wallet: w, height: 1000}
}
func TestRenewalPersistsBeforeAmbiguousBroadcastAndReusesTransaction(t *testing.T) {
	w := testWallet(t)
	file := filepath.Join(t.TempDir(), "pending.json")
	ctx := context.Background()
	w.sendError = errors.New("ambiguous RPC timeout")
	if _, e := renewSubscription(ctx, w, file, "topic", "routes.key"); e == nil {
		t.Fatal("expected timeout")
	}
	if _, e := os.Stat(file); e != nil {
		t.Fatal("transaction not persisted before sending")
	}
	// A completely fresh call after restart must not ask for a fresh nonce.
	w.sendError = nil
	w.height++
	if _, e := renewSubscription(ctx, w, file, "topic", "routes.key"); e != nil {
		t.Fatal(e)
	}
	if w.nonceCalls != 1 || len(w.sent) != 2 || !bytes.Equal(w.sent[0], w.sent[1]) {
		t.Fatal("retry could pay twice")
	}
	w.expiration = 3401
	if _, e := renewSubscription(ctx, w, file, "topic", "routes.key"); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(file); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("confirmed pending transaction retained")
	}
	if len(w.sent) != 2 {
		t.Fatal("healthy subscription renewed early")
	}
	w.height = 3300
	if _, e := renewSubscription(ctx, w, file, "topic", "routes.key"); e != nil {
		t.Fatal(e)
	}
	if w.nonceCalls != 2 || len(w.sent) != 3 || bytes.Equal(w.sent[1], w.sent[2]) {
		t.Fatal("subscription was not renewed before expiry")
	}
}
func TestFailedPersistenceAndWrongIdentityNeverSpend(t *testing.T) {
	w := testWallet(t)
	ctx := context.Background()
	dir := t.TempDir()
	if _, e := renewSubscription(ctx, w, filepath.Join(dir, "absent", "pending.json"), "topic", "routes.key"); e == nil {
		t.Fatal("missing persistence accepted")
	}
	if len(w.sent) != 0 {
		t.Fatal("broadcast without durable state")
	}
	file := filepath.Join(dir, "pending.json")
	if _, e := renewSubscription(ctx, w, file, "topic", "routes.key"); e != nil {
		t.Fatal(e)
	}
	if _, e := renewSubscription(ctx, w, file, "another-topic", "routes.key"); e == nil {
		t.Fatal("other app's pending transaction accepted")
	}
	if len(w.sent) != 1 {
		t.Fatal("invalid transaction sent")
	}
}
