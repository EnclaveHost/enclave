//go:build !windows

// split-provider-revenue settles a provider's confirmed native NKN receipts.
// The collection wallet stays on the payout machine, never on a provider host.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"golang.org/x/sys/unix"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/EnclaveHost/enclave/network/tuna/revenueshare"
	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/nkn/v2/common"
	"github.com/nknorg/nkn/v2/pb"
	"github.com/nknorg/nkn/v2/transaction"
)

type config struct {
	Collection      string   `json:"collection"`
	Provider        string   `json:"provider"`
	Platform        string   `json:"platform"`
	ProviderBps     uint16   `json:"providerBps"`
	StartHeight     uint32   `json:"startHeight"`
	Confirmations   uint32   `json:"confirmations"`
	FreshCollection bool     `json:"freshCollection"`
	RPC             []string `json:"rpc"`
	WalletFile      string   `json:"walletFile"`
	PasswordFile    string   `json:"passwordFile"`
	StateFile       string   `json:"stateFile"`
	Fee             string   `json:"fee"`
	Minimum         string   `json:"minimum"`
	MaxBlocks       uint32   `json:"maxBlocks"`
}
type header struct {
	Height    uint32 `json:"height"`
	Prev      string `json:"prevBlockHash"`
	Timestamp int64  `json:"timestamp"`
}
type block struct {
	Hash         string                 `json:"hash"`
	Header       header                 `json:"header"`
	Transactions []revenueshare.Receipt `json:"transactions"`
}

func rpcConfig(endpoint string) *nkn.WalletConfig {
	return &nkn.WalletConfig{SeedRPCServerAddr: nkn.NewStringArray(endpoint), RPCTimeout: 15000}
}
func quorum[T any](ctx context.Context, endpoints []string, method string, params any) (T, error) {
	type result struct {
		value T
		err   error
	}
	ch := make(chan result, len(endpoints))
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	for _, endpoint := range endpoints {
		go func(endpoint string) {
			var v T
			e := nkn.RPCCall(ctx, method, params, &v, rpcConfig(endpoint))
			ch <- result{v, e}
		}(endpoint)
	}
	seen := map[string]bool{}
	for range endpoints {
		r := <-ch
		if r.err != nil {
			continue
		}
		b, e := json.Marshal(r.value)
		if e != nil {
			continue
		}
		key := string(b)
		if seen[key] {
			return r.value, nil
		}
		seen[key] = true
	}
	var empty T
	return empty, fmt.Errorf("independent NKN RPCs did not agree on %s", method)
}
func readBlock(ctx context.Context, c config, height uint32) (block, error) {
	b, e := quorum[block](ctx, c.RPC, "getblock", map[string]any{"height": height})
	if e == nil && (b.Header.Height != height || len(b.Hash) != 64 || len(b.Header.Prev) != 64) {
		e = errors.New("invalid confirmed block")
	}
	return b, e
}
func save(file string, s revenueshare.State) error {
	raw, e := json.MarshalIndent(s, "", "  ")
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(file), 0700); e != nil {
		return e
	}
	f, e := os.OpenFile(file+".tmp", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(raw); e == nil {
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
	dir, e := os.Open(filepath.Dir(file))
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}
func run(file string, execute bool) error {
	raw, e := os.ReadFile(file)
	if e != nil {
		return e
	}
	var c config
	if e = json.Unmarshal(raw, &c); e != nil {
		return e
	}
	if c.ProviderBps > 10000 || c.StartHeight == 0 || c.Confirmations < 10 || !c.FreshCollection || c.MaxBlocks < 1 || c.MaxBlocks > 1000 {
		return errors.New("invalid pinned revenue policy; requires fresh collection and >=10 confirmations")
	}
	for _, a := range []string{c.Collection, c.Provider, c.Platform} {
		if _, e = common.ToScriptHash(a); e != nil {
			return errors.New("valid native NKN recipients required")
		}
	}
	if c.Collection == c.Provider || c.Collection == c.Platform {
		return errors.New("collection must be separate from payout wallets")
	}
	origins := map[string]bool{}
	for _, r := range c.RPC {
		u, e := url.Parse(r)
		if e != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return errors.New("invalid RPC")
		}
		if origins[u.Hostname()] {
			return errors.New("duplicate RPC host cannot form an independent quorum")
		}
		origins[u.Hostname()] = true
	}
	if len(origins) < 2 || len(c.RPC) > 5 {
		return errors.New("at least two independent RPC hosts required")
	}
	if !filepath.IsAbs(c.StateFile) || !filepath.IsAbs(c.WalletFile) || !filepath.IsAbs(c.PasswordFile) {
		return errors.New("absolute private state paths required")
	}
	fee, e := common.StringToFixed64(c.Fee)
	if e != nil || fee < 0 {
		return errors.New("invalid fee")
	}
	minimum, e := common.StringToFixed64(c.Minimum)
	if e != nil || minimum <= 0 {
		return errors.New("invalid minimum")
	}
	// Immutable policy identity prevents a config edit redirecting pending funds.
	identity, _ := json.Marshal(struct {
		Collection, Provider, Platform string
		Bps                            uint16
		Start                          uint32
	}{c.Collection, c.Provider, c.Platform, c.ProviderBps, c.StartHeight})
	digest := sha256.Sum256(identity)
	configHash := hex.EncodeToString(digest[:])
	if e = os.MkdirAll(filepath.Dir(c.StateFile), 0700); e != nil {
		return e
	}
	// The OS releases this lock on process exit, including crashes. A stale
	// pathname never causes a duplicate signer or an unrecoverable timer stall.
	lock, e := os.OpenFile(c.StateFile+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		return errors.New("collection wallet already locked")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	s := revenueshare.State{ConfigHash: configHash, Height: c.StartHeight - 1}
	old, e := os.ReadFile(c.StateFile)
	if e == nil {
		if e = json.Unmarshal(old, &s); e != nil {
			return e
		}
		if s.ConfigHash != configHash {
			return errors.New("revenue policy changed; use an explicit reconciled migration")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	if e = s.Validate(c.Provider, c.Platform, c.ProviderBps); e != nil {
		return e
	}
	prior, e := readBlock(ctx, c, s.Height)
	if e != nil {
		return e
	}
	if s.BlockHash != "" && s.BlockHash != prior.Hash {
		return errors.New("confirmed chain changed; settlement stopped for reconciliation")
	}
	s.BlockHash = prior.Hash
	// Two agreeing finalized blocks are authoritative; heights only choose a
	// common recent candidate and cannot authorize receipts by themselves.
	heights := []uint32{}
	for _, endpoint := range c.RPC {
		var h uint32
		if nkn.RPCCall(ctx, "getlatestblockheight", map[string]any{}, &h, rpcConfig(endpoint)) == nil {
			heights = append(heights, h)
		}
	}
	if len(heights) < 2 {
		return errors.New("chain height quorum unavailable")
	}
	sort.Slice(heights, func(i, j int) bool { return heights[i] > heights[j] })
	if heights[1] < c.Confirmations {
		return errors.New("invalid chain head")
	}
	head := heights[1] - c.Confirmations
	final, e := readBlock(ctx, c, head)
	if e != nil {
		return e
	}
	if final.Header.Timestamp > time.Now().Unix()+30 || time.Now().Unix()-final.Header.Timestamp > 900 {
		return errors.New("stale NKN chain")
	}
	if head < s.Height {
		return errors.New("NKN chain regressed")
	}
	recipient, e := common.ToScriptHash(c.Collection)
	if e != nil {
		return e
	}
	stop := head
	if uint64(stop) > uint64(s.Height)+uint64(c.MaxBlocks) {
		stop = s.Height + c.MaxBlocks
	}
	for h := s.Height + 1; h <= stop; h++ {
		b, e := readBlock(ctx, c, h)
		if e != nil {
			return e
		}
		if b.Header.Prev != s.BlockHash {
			return errors.New("NKN block parent mismatch")
		}
		if e = s.Apply(b.Transactions, recipient.ToArray()); e != nil {
			return e
		}
		for _, tx := range b.Transactions {
			if len(s.Pending) > 0 && tx.Hash == s.Pending[0].Hash {
				if e = s.ConfirmFirst(tx.Hash); e != nil {
					return e
				}
			}
		}
		s.Height = h
		s.BlockHash = b.Hash
		if e = save(c.StateFile, s); e != nil {
			return e
		}
	}
	provider, platform, e := revenueshare.Split(s.Gross, c.ProviderBps)
	if e != nil {
		return e
	}
	fmt.Printf("confirmedHeight=%d gross=%s providerEarned=%s platformEarned=%s pending=%d caughtUp=%t\n", s.Height, common.Fixed64(s.Gross).String(), common.Fixed64(provider).String(), common.Fixed64(platform).String(), len(s.Pending), s.Height == head)
	if !execute || s.Height != head {
		return save(c.StateFile, s)
	}
	walletJSON, e := os.ReadFile(c.WalletFile)
	if e != nil {
		return e
	}
	password, e := os.ReadFile(c.PasswordFile)
	if e != nil {
		return e
	}
	w, e := nkn.WalletFromJSON(string(walletJSON), &nkn.WalletConfig{Password: strings.TrimSpace(string(password)), SeedRPCServerAddr: nkn.NewStringArray(c.RPC...), RPCTimeout: 15000})
	if e != nil {
		return errors.New("cannot open collection wallet")
	}
	if w.Address() != c.Collection {
		return errors.New("collection wallet mismatch")
	}
	if len(s.Pending) == 0 {
		plan, e := s.Plan(c.Provider, c.Platform, c.ProviderBps, int64(fee), int64(minimum))
		if e != nil {
			return e
		}
		if len(plan) == 0 {
			return save(c.StateFile, s)
		}
		balance, e := w.BalanceContext(ctx)
		if e != nil {
			return e
		}
		var total int64
		for _, p := range plan {
			total += p.Amount + p.Fee
		}
		if balance.ToFixed64() < common.Fixed64(total) {
			return errors.New("collection balance does not back payout plan")
		}
		nonce, e := w.GetNonceContext(ctx, true)
		if e != nil || nonce < 0 {
			return errors.New("cannot read collection nonce")
		}
		for i := range plan {
			to, _ := common.ToScriptHash(plan[i].Recipient)
			tx, e := transaction.NewTransferAssetTransaction(w.ProgramHash(), to, uint64(nonce)+uint64(i), common.Fixed64(plan[i].Amount), fee)
			if e != nil {
				return e
			}
			if e = w.SignTransaction(tx); e != nil {
				return e
			}
			wire, e := tx.Marshal()
			if e != nil {
				return e
			}
			hash := tx.Hash()
			plan[i].Hash = hash.ToHexString()
			plan[i].Raw = hex.EncodeToString(wire)
		}
		s.Pending = plan
		if e = save(c.StateFile, s); e != nil {
			return e
		}
	}
	if e = s.Validate(c.Provider, c.Platform, c.ProviderBps); e != nil {
		return e
	}
	// Every retry broadcasts only the journal's identical signed bytes. No new
	// nonce or amount is invented after an uncertain response.
	for _, p := range s.Pending {
		sender := w.ProgramHash()
		if e = validatePending(p, sender.ToArray()); e != nil {
			return e
		}
		wire, e := hex.DecodeString(p.Raw)
		if e != nil {
			return e
		}
		tx := &transaction.Transaction{}
		if e = tx.Unmarshal(wire); e != nil {
			return e
		}
		hash := tx.Hash()
		if hash.ToHexString() != p.Hash {
			return errors.New("corrupt payout journal")
		}
		sent, e := w.SendRawTransactionContext(ctx, tx)
		if e != nil {
			return fmt.Errorf("payout %s pending; retry same journal: %w", p.Hash, e)
		}
		if sent != p.Hash {
			return errors.New("broadcast hash mismatch")
		}
		fmt.Printf("submitted=%s recipient=%s amount=%s\n", p.Hash, p.Recipient, common.Fixed64(p.Amount).String())
	}
	return nil
}
func validatePending(p revenueshare.Pending, sender []byte) error {
	wire, e := hex.DecodeString(p.Raw)
	if e != nil {
		return e
	}
	tx := &transaction.Transaction{}
	if e = tx.Unmarshal(wire); e != nil {
		return e
	}
	if tx.UnsignedTx == nil || tx.UnsignedTx.Payload == nil || tx.UnsignedTx.Payload.Type != pb.PayloadType_TRANSFER_ASSET_TYPE {
		return errors.New("payout must be a native transfer")
	}
	payload, e := transaction.Unpack(tx.UnsignedTx.Payload)
	if e != nil {
		return e
	}
	transfer, ok := payload.(*pb.TransferAsset)
	if !ok {
		return errors.New("invalid payout payload")
	}
	recipient, e := common.ToScriptHash(p.Recipient)
	if e != nil {
		return e
	}
	hash := tx.Hash()
	if hash.ToHexString() != p.Hash || !bytes.Equal(transfer.Sender, sender) || !bytes.Equal(transfer.Recipient, recipient.ToArray()) || transfer.Amount != p.Amount || tx.UnsignedTx.Fee != p.Fee || p.Provider < 0 || p.Platform < 0 || p.Provider > p.Amount || p.Platform != p.Amount-p.Provider {
		return errors.New("payout journal fields do not match signed transfer")
	}
	return nil
}
func main() {
	file := flag.String("config", "", "private revenue policy file")
	execute := flag.Bool("execute", false, "submit journaled native NKN payouts")
	flag.Parse()
	if e := run(*file, *execute); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
