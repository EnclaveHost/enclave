// enclave-tuna is a local process adapter for the upstream TUNA protocol.
// stdin receives complete desired route sets; stdout contains allocation events.
// It never accepts a public management connection or implements a relay server.
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
	"net/url"
	"os"
	"os/signal"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/tuna"
)

type config struct {
	SeedFile   string   `json:"seedFile"`
	RPC        []string `json:"rpc"`
	MaxPrice   string   `json:"maxPrice"`
	MinBalance string   `json:"minBalance"`
}
type route struct {
	ID          string   `json:"id"`
	TCP         []uint32 `json:"tcp"`
	UDP         []uint32 `json:"udp"`
	RandomPorts bool     `json:"randomPorts"`
	Forward     bool     `json:"forward"`
}
type event struct {
	Type        string   `json:"type"`
	ID          string   `json:"id,omitempty"`
	Address     string   `json:"address,omitempty"`
	TCP         []uint32 `json:"tcp,omitempty"`
	UDP         []uint32 `json:"udp,omitempty"`
	Price       string   `json:"price,omitempty"`
	Beneficiary string   `json:"beneficiary,omitempty"`
	Error       string   `json:"error,omitempty"`
}

var outputMu sync.Mutex

func emit(e event) {
	outputMu.Lock()
	defer outputMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(e)
}

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9:_-]{1,100}$`)

func validateRoutes(routes []route) error {
	if len(routes) > 256 {
		return errors.New("at most 256 routes are allowed")
	}
	ids := map[string]bool{}
	for _, r := range routes {
		if !idPattern.MatchString(r.ID) || ids[r.ID] {
			return errors.New("invalid or duplicate route id")
		}
		ids[r.ID] = true
		if len(r.TCP)+len(r.UDP) == 0 || len(r.TCP)+len(r.UDP) > 255 {
			return errors.New("route needs 1..255 ports")
		}
		for _, ports := range [][]uint32{r.TCP, r.UDP} {
			seen := map[uint32]bool{}
			for _, p := range ports {
				if p == 0 || p > 65535 || seen[p] {
					return errors.New("invalid or duplicate local port")
				}
				seen[p] = true
			}
		}
		if r.Forward && (len(r.TCP) != 1 || len(r.UDP) != 0) {
			return errors.New("SOCKS forwarding needs one TCP port")
		}
	}
	return nil
}
func readConfig(file string) (config, error) {
	var c config
	b, err := os.ReadFile(file)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.SeedFile == "" || c.MaxPrice == "" || len(c.RPC) == 0 {
		return c, errors.New("seedFile, maxPrice and explicit rpc endpoints are required")
	}
	up, down, priceErr := tuna.ParsePrice(c.MaxPrice)
	if priceErr != nil || up < 0 || down < 0 || strings.Count(c.MaxPrice, ",") > 1 {
		return c, errors.New("maxPrice must contain one or two nonnegative NKN prices")
	}
	if c.MinBalance == "" {
		c.MinBalance = "0.01"
	}
	minimum, balanceErr := nkn.NewAmount(c.MinBalance)
	if balanceErr != nil || minimum.ToFixed64() < 0 {
		return c, errors.New("minBalance must be a nonnegative NKN amount")
	}
	for _, s := range c.RPC {
		u, e := url.Parse(s)
		if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return c, errors.New("invalid RPC endpoint")
		}
	}
	return c, nil
}
func readWallet(c config) (*nkn.Wallet, error) {
	st, e := os.Stat(c.SeedFile)
	if e != nil {
		return nil, e
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("wallet seed file must be accessible only to its owner (0600)")
	}
	b, e := os.ReadFile(c.SeedFile)
	if e != nil {
		return nil, e
	}
	seed, e := hex.DecodeString(strings.TrimSpace(string(b)))
	if e != nil || len(seed) != 32 {
		return nil, errors.New("wallet seed file must contain 32 bytes of hex")
	}
	a, e := nkn.NewAccount(seed)
	if e != nil {
		return nil, e
	}
	return nkn.NewWallet(a, &nkn.WalletConfig{SeedRPCServerAddr: nkn.NewStringArray(c.RPC...)})
}
func runRoute(ctx context.Context, c config, r route, w *nkn.Wallet, client *nkn.MultiClient) {
	for ctx.Err() == nil {
		var closeRoute func()
		done := make(chan error, 1)
		var connected <-chan struct{}
		var allocation func() event
		if r.Forward {
			entry, e := tuna.NewTunaEntry(tuna.Service{Name: "socksproxy", TCP: r.TCP, Encryption: "xsalsa20-poly1305"}, tuna.ServiceInfo{MaxPrice: c.MaxPrice, ListenIP: "127.0.0.1"}, w, client, &tuna.EntryConfiguration{SeedRPCServerAddr: c.RPC, DialTimeout: 5, UDPTimeout: 60, MinBalance: c.MinBalance})
			if e != nil {
				emit(event{Type: "down", ID: r.ID, Error: e.Error()})
				return
			}
			closeRoute = entry.Close
			connected = entry.OnConnect.C
			allocation = func() event {
				m := entry.GetMetadata()
				return event{Type: "ready", ID: r.ID, Address: m.Ip, TCP: entry.GetTCPPorts(), Price: m.Price, Beneficiary: m.BeneficiaryAddr}
			}
			go func() { done <- entry.Start(false) }()
		} else {
			exit, e := tuna.NewTunaExit([]tuna.Service{{Name: r.ID, TCP: r.TCP, UDP: r.UDP, Encryption: "xsalsa20-poly1305"}}, w, client, &tuna.ExitConfiguration{SeedRPCServerAddr: c.RPC, Reverse: true, ReverseRandomPorts: r.RandomPorts, ReverseMaxPrice: c.MaxPrice, ReverseMinBalance: c.MinBalance, DialTimeout: 5, UDPTimeout: 60, Services: map[string]tuna.ExitServiceInfo{r.ID: {Address: "127.0.0.1"}}})
			if e != nil {
				emit(event{Type: "down", ID: r.ID, Error: e.Error()})
				return
			}
			closeRoute = exit.Close
			connected = exit.OnConnect.C
			allocation = func() event {
				m := exit.GetMetadata()
				return event{Type: "ready", ID: r.ID, Address: exit.GetReverseIP().String(), TCP: exit.GetReverseTCPPorts(), UDP: exit.GetReverseUDPPorts(), Price: m.Price, Beneficiary: m.BeneficiaryAddr}
			}
			go func() { done <- exit.StartReverse(false) }()
		}
		finished := false
		retryDelay := 3 * time.Second
		for !finished {
			select {
			case <-ctx.Done():
				closeRoute()
				emit(event{Type: "down", ID: r.ID})
				return
			case _, ok := <-connected:
				if ok {
					emit(allocation())
				}
				connected = nil
			case err := <-done:
				closeRoute()
				e := event{Type: "down", ID: r.ID}
				if err != nil {
					e.Error = err.Error()
					if errors.Is(err, nkn.ErrInsufficientBalance) {
						retryDelay = 30 * time.Second
					}
				}
				emit(e)
				finished = true
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryDelay):
		}
	}
}

func main() {
	log.SetOutput(os.Stderr)
	file := flag.String("config", "", "local TUNA wallet/RPC/price configuration")
	initFile := flag.String("init-wallet", "", "create a new seed file exclusively, printing only its address")
	flag.Parse()
	if *initFile != "" {
		a, e := nkn.NewAccount(nil)
		if e != nil {
			log.Fatal(e)
		}
		f, e := os.OpenFile(*initFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			log.Fatal(e)
		}
		_, e = fmt.Fprintln(f, hex.EncodeToString(a.Seed()))
		if e != nil {
			log.Fatal(e)
		}
		if e = f.Close(); e != nil {
			log.Fatal(e)
		}
		w, e := nkn.NewWallet(a, nil)
		if e != nil {
			log.Fatal(e)
		}
		emit(event{Type: "wallet", Address: w.Address()})
		return
	}
	c, e := readConfig(*file)
	if e != nil {
		log.Fatal(e)
	}
	w, e := readWallet(c)
	if e != nil {
		log.Fatal(e)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client, e := nkn.NewMultiClient(w.Account(), "", 4, false, &nkn.ClientConfig{SeedRPCServerAddr: nkn.NewStringArray(c.RPC...), RPCTimeout: 5000})
	if e != nil {
		log.Fatal(e)
	}
	defer client.Close()
	type running struct {
		route  route
		cancel context.CancelFunc
		done   chan struct{}
	}
	active := map[string]running{}
	defer func() {
		for _, r := range active {
			r.cancel()
		}
		for _, r := range active {
			<-r.done
		}
	}()
	commands := make(chan []route)
	go func() {
		defer close(commands)
		s := bufio.NewScanner(os.Stdin)
		s.Buffer(make([]byte, 4096), 1<<20)
		for s.Scan() {
			var v struct {
				Routes []route `json:"routes"`
			}
			if e := json.Unmarshal(s.Bytes(), &v); e != nil {
				emit(event{Type: "error", Error: "invalid command JSON"})
				continue
			}
			if e := validateRoutes(v.Routes); e != nil {
				emit(event{Type: "error", Error: e.Error()})
				continue
			}
			select {
			case commands <- v.Routes:
			case <-ctx.Done():
				return
			}
		}
		if e := s.Err(); e != nil {
			log.Print(e)
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case routes, ok := <-commands:
			if !ok {
				return
			}
			want := map[string]route{}
			for _, r := range routes {
				want[r.ID] = r
			}
			for id, a := range active {
				r, ok := want[id]
				if !ok || !reflect.DeepEqual(r, a.route) {
					a.cancel()
					<-a.done
					delete(active, id)
				}
			}
			for id, r := range want {
				if _, ok := active[id]; ok {
					continue
				}
				sub, cancel := context.WithCancel(ctx)
				done := make(chan struct{})
				active[id] = running{r, cancel, done}
				go func(r route) { defer close(done); runRoute(sub, c, r, w, client) }(r)
			}
		}
	}
}
