package main

// A pending subscription is persisted BEFORE broadcast. Retrying an ambiguous
// RPC response or restarting a circuit can only rebroadcast the identical signed
// transaction, never generate another fee-paying transaction with a new nonce.
import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/nkn/v2/common"
	"github.com/nknorg/nkn/v2/transaction"
)

const subscriptionDuration = 2400
const renewBefore = 120

type subscriptionWallet interface {
	GetHeightContext(context.Context) (int32, error)
	GetSubscriptionContext(context.Context, string, string) (*nkn.Subscription, error)
	GetNonceContext(context.Context, bool) (int64, error)
	PubKey() []byte
	SignTransaction(*transaction.Transaction) error
	SendRawTransactionContext(context.Context, *transaction.Transaction) (string, error)
}
type pendingSubscription struct {
	Topic              string `json:"topic"`
	Subscriber         string `json:"subscriber"`
	Height             int    `json:"height"`
	PreviousExpiration int    `json:"previousExpiration"`
	Transaction        string `json:"transaction"`
}

func savePending(file string, p pendingSubscription) error {
	b, e := json.Marshal(p)
	if e != nil {
		return e
	}
	f, e := os.OpenFile(file+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	if e = os.Rename(file+".tmp", file); e != nil {
		return e
	}
	// Flush the directory on Unix; Windows has no portable directory fsync.
	if d, e := os.Open(filepath.Dir(file)); e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
func renewSubscription(ctx context.Context, w subscriptionWallet, file, topic, subscriber string) (string, error) {
	if !filepath.IsAbs(file) {
		return "", errors.New("absolute persistent subscription state required")
	}
	observedHeight, e := w.GetHeightContext(ctx)
	if e != nil {
		return "", e
	}
	height := int(observedHeight)
	sub, e := w.GetSubscriptionContext(ctx, topic, subscriber)
	if e != nil {
		return "", e
	}
	expiration := 0
	if sub != nil {
		expiration = int(sub.ExpiresAt)
	}
	var pending pendingSubscription
	b, e := os.ReadFile(file)
	if e == nil {
		if len(b) > 16384 || json.Unmarshal(b, &pending) != nil || pending.Topic != topic || pending.Subscriber != subscriber || pending.Height < 0 || pending.PreviousExpiration < 0 {
			return "", errors.New("invalid pending subscription")
		}
		if expiration > pending.PreviousExpiration && expiration >= pending.Height+subscriptionDuration {
			if e = os.Remove(file); e != nil {
				return "", e
			}
			pending = pendingSubscription{}
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return "", e
	}
	if expiration >= height+renewBefore {
		return "", nil
	}
	var tx transaction.Transaction
	if pending.Transaction != "" {
		encoded, e := hex.DecodeString(pending.Transaction)
		if e != nil {
			return "", e
		}
		if e = tx.Unmarshal(encoded); e != nil {
			return "", e
		}
	} else {
		nonce, e := w.GetNonceContext(ctx, true)
		if e != nil || nonce < 0 {
			return "", errors.New("subscription nonce unavailable")
		}
		fee, _ := common.StringToFixed64("0.001")
		made, e := transaction.NewSubscribeTransaction(w.PubKey(), "routes", topic, subscriptionDuration, `{"version":2}`, uint64(nonce), fee)
		if e != nil {
			return "", e
		}
		if e = w.SignTransaction(made); e != nil {
			return "", e
		}
		tx = *made
		encoded, e := tx.Marshal()
		if e != nil {
			return "", e
		}
		pending = pendingSubscription{Topic: topic, Subscriber: subscriber, Height: height, PreviousExpiration: expiration, Transaction: hex.EncodeToString(encoded)}
		if e = savePending(file, pending); e != nil {
			return "", e
		}
	}
	return w.SendRawTransactionContext(ctx, &tx)
}
