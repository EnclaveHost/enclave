// route-discovery distributes signed records over NKN messaging. NKN's public
// subscription ledger locates peers; it never authorizes an Enclave route.
package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/EnclaveHost/enclave/network/tuna/guard"
	nkn "github.com/nknorg/nkn-sdk-go"
)

type config struct {
	SeedFile string   `json:"seedFile"`
	RPC      []string `json:"rpc"`
	Guard    string   `json:"guardSocks"`
}
type record struct {
	DeploymentID string `json:"deploymentId"`
	ExpiresAt    int64  `json:"expiresAt"`
	Name         string `json:"name"`
	CID          string `json:"cid"`
	Block        string `json:"block"`
	IPNS         string `json:"ipns"`
}

var output sync.Mutex

func emit(v any) { output.Lock(); defer output.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
func fail(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
func connect(c config, identifier string) (*nkn.Wallet, *nkn.MultiClient, error) {
	if c.Guard == "" || len(c.RPC) == 0 {
		return nil, nil, errors.New("explicit guard and NKN RPCs required")
	}
	dial, e := guard.New(c.Guard)
	if e != nil {
		return nil, nil, e
	}
	var seed []byte
	if c.SeedFile != "" {
		b, e := os.ReadFile(c.SeedFile)
		if e != nil {
			return nil, nil, e
		}
		seed, e = hex.DecodeString(strings.TrimSpace(string(b)))
		if e != nil || len(seed) != 32 {
			return nil, nil, errors.New("invalid discovery seed")
		}
	}
	account, e := nkn.NewAccount(seed)
	if e != nil {
		return nil, nil, e
	}
	rpc := nkn.NewStringArray(c.RPC...)
	wallet, e := nkn.NewWallet(account, &nkn.WalletConfig{SeedRPCServerAddr: rpc, RPCTimeout: 8000, HttpDialContext: dial.DialContext})
	if e != nil {
		return nil, nil, e
	}
	client, e := nkn.NewMultiClient(account, identifier, 4, false, &nkn.ClientConfig{SeedRPCServerAddr: rpc, RPCTimeout: 8000, HttpDialContext: dial.DialContext, WsDialContext: dial.DialContext})
	return wallet, client, e
}
func main() {
	file := flag.String("config", "", "guarded RPC and optional seed configuration")
	id := flag.String("deployment", "", "exact deployment ID")
	mode := flag.String("mode", "serve", "serve or lookup")
	flag.Parse()
	if !regexp.MustCompile(`^0x[0-9a-f]{64}$`).MatchString(*id) {
		log.Fatal("exact deployment required")
	}
	var c config
	b, e := os.ReadFile(*file)
	fail(e)
	fail(json.Unmarshal(b, &c))
	if *mode != "serve" && *mode != "lookup" {
		log.Fatal("serve or lookup required")
	}
	if *mode == "serve" && c.SeedFile == "" {
		log.Fatal("funded per-circuit seed required")
	}
	wallet, client, e := connect(c, "routes")
	fail(e)
	defer client.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	select {
	case <-client.OnConnect.C:
	case <-time.After(30 * time.Second):
		log.Fatal("NKN connection timeout")
	case <-ctx.Done():
		return
	}
	topic := "enclave.route.v2." + strings.TrimPrefix(*id, "0x")
	if *mode == "lookup" {
		fail(lookup(ctx, client, topic, *id))
		return
	}
	updates := make(chan record, 1)
	go func() {
		defer cancel()
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 65536)
		for scanner.Scan() {
			var r record
			if json.Unmarshal(scanner.Bytes(), &r) != nil || r.DeploymentID != *id || r.ExpiresAt > time.Now().Add(120*time.Second).UnixMilli() || len(r.Block) > 44000 || len(r.IPNS) > 14000 {
				return
			}
			select {
			case updates <- r:
			case <-ctx.Done():
				return
			}
		}
	}()
	// Register at most once per process. An ambiguous transaction response must
	// not trigger repeated spending. The existing subscription is checked first.
	checkCtx, stop := context.WithTimeout(ctx, 15*time.Second)
	height, e := wallet.GetHeightContext(checkCtx)
	fail(e)
	sub, e := wallet.GetSubscriptionContext(checkCtx, topic, client.Address())
	fail(e)
	if sub == nil || sub.ExpiresAt < height+120 {
		tx, e := wallet.SubscribeContext(checkCtx, "routes", topic, 2400, `{"version":2}`, &nkn.TransactionConfig{Fee: "0.001"})
		fail(e)
		emit(map[string]any{"type": "subscription", "transaction": tx})
	}
	stop()
	emit(map[string]any{"type": "ready", "address": client.Address(), "topic": topic})
	var current record
	var encoded []byte
	lastReply := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case r := <-updates:
			current = r
			encoded, _ = json.Marshal(r)
		case msg, ok := <-client.OnMessage.C:
			if !ok {
				return
			}
			if msg == nil || !msg.Encrypted || len(msg.Data) > 256 || current.ExpiresAt <= time.Now().UnixMilli() || time.Since(lastReply) < 100*time.Millisecond {
				continue
			}
			var request struct {
				Version      int    `json:"version"`
				DeploymentID string `json:"deploymentId"`
			}
			if json.Unmarshal(msg.Data, &request) != nil || request.Version != 2 || request.DeploymentID != *id {
				continue
			}
			lastReply = time.Now()
			if e := msg.ReplyBinary(encoded); e != nil {
				log.Print("discovery reply failed")
			}
		}
	}
}
func lookup(parent context.Context, client *nkn.MultiClient, topic, id string) error {
	ctx, cancel := context.WithTimeout(parent, 25*time.Second)
	defer cancel()
	subscribers, e := client.GetSubscribersContext(ctx, topic, 0, 64, true, true, nil)
	if e != nil {
		return e
	}
	addresses := map[string]bool{}
	for address := range subscribers.Subscribers.Map() {
		addresses[address] = true
	}
	for address := range subscribers.SubscribersInTxPool.Map() {
		addresses[address] = true
	}
	if len(addresses) == 0 {
		return errors.New("no discovery peers")
	}
	request, _ := json.Marshal(map[string]any{"version": 2, "deploymentId": id})
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for address := range addresses {
		wg.Add(1)
		go func(address string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			reply, e := client.Send(nkn.NewStringArray(address), request, &nkn.MessageConfig{MessageID: nil, NoReply: false})
			if e != nil {
				return
			}
			select {
			case msg := <-reply.C:
				if msg == nil || len(msg.Data) > 65536 {
					return
				}
				var r record
				if json.Unmarshal(msg.Data, &r) == nil && r.DeploymentID == id && r.ExpiresAt > time.Now().UnixMilli() {
					emit(map[string]any{"type": "record", "source": address, "record": r})
				}
			case <-ctx.Done():
				return
			case <-time.After(8 * time.Second):
				return
			}
		}(address)
	}
	wg.Wait()
	fmt.Fprintln(os.Stderr, "discovery lookup complete; callers must verify signatures, CID and fresh lease")
	return nil
}
