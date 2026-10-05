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
	"net"
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

	"github.com/EnclaveHost/enclave/network/tuna/guard"
	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/tuna"
	"github.com/nknorg/tuna/filter"
)

type config struct {
	USDC           *tuna.USDCLocalConfig `json:"usdc,omitempty"`
	ListenIP       string                `json:"listenIp,omitempty"`
	SeedFile       string                `json:"seedFile"`
	RPC            []string              `json:"rpc"`
	MaxPrice       string                `json:"maxPrice"`
	MinBalance     string                `json:"minBalance"`
	GuardSOCKS     string                `json:"guardSocks,omitempty"`
	RequireGuard   bool                  `json:"requireGuard,omitempty"`
	AllowProviders []string              `json:"allowProviders,omitempty"`
	DenyProviders  []string              `json:"denyProviders,omitempty"`
}
type route struct {
	ID          string   `json:"id"`
	TCP         []uint32 `json:"tcp"`
	UDP         []uint32 `json:"udp"`
	RandomPorts bool     `json:"randomPorts"`
	Forward     bool     `json:"forward"`
	PublicTCP   []uint32 `json:"publicTcp,omitempty"`
}
type event struct {
	Currency    string   `json:"currency,omitempty"`
	RegistryID  string   `json:"registryId,omitempty"`
	Type        string   `json:"type"`
	ID          string   `json:"id,omitempty"`
	Address     string   `json:"address,omitempty"`
	TCP         []uint32 `json:"tcp,omitempty"`
	UDP         []uint32 `json:"udp,omitempty"`
	Price       string   `json:"price,omitempty"`
	Beneficiary string   `json:"beneficiary,omitempty"`
	Provider    string   `json:"provider,omitempty"`
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
		if len(r.PublicTCP) > 0 {
			if r.Forward || r.RandomPorts || len(r.PublicTCP) != len(r.TCP) {
				return errors.New("public TCP mapping requires fixed reverse ports matching local ports")
			}
			seen := map[uint32]bool{}
			for _, p := range r.PublicTCP {
				if p == 0 || p > 65535 || seen[p] {
					return errors.New("invalid public TCP port")
				}
				seen[p] = true
			}
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
	if c.ListenIP == "" {
		c.ListenIP = "127.0.0.1"
	}
	if net.ParseIP(c.ListenIP) == nil {
		return c, errors.New("listenIp must be an IP literal")
	}
	if c.RequireGuard && c.GuardSOCKS == "" {
		return c, errors.New("privacy mode requires a guard; direct fallback forbidden")
	}
	if c.GuardSOCKS != "" {
		if _, err := guard.New(c.GuardSOCKS); err != nil {
			return c, err
		}
	}
	providerID := regexp.MustCompile(`^(?:[a-zA-Z0-9_.-]{1,128}\.)?[0-9a-f]{64}$`)
	for _, ids := range [][]string{c.AllowProviders, c.DenyProviders} {
		if len(ids) > 256 {
			return c, errors.New("too many provider identities")
		}
		for _, id := range ids {
			if !providerID.MatchString(id) {
				return c, errors.New("invalid provider identity")
			}
		}
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
	wc := &nkn.WalletConfig{SeedRPCServerAddr: nkn.NewStringArray(c.RPC...), RPCTimeout: 10000}
	if c.GuardSOCKS != "" {
		d, err := guard.New(c.GuardSOCKS)
		if err != nil {
			return nil, err
		}
		wc.HttpDialContext = d.DialContext
	}
	return nkn.NewWallet(a, wc)
}
func runRoute(ctx context.Context, c config, r route, w *nkn.Wallet, client *nkn.MultiClient) {
	if c.GuardSOCKS != "" && len(r.UDP) > 0 {
		emit(event{Type: "down", ID: r.ID, Error: "guarded UDP is unavailable; direct fallback forbidden"})
		return
	}
	var dial func(context.Context, string, string) (net.Conn, error)
	if c.GuardSOCKS != "" {
		d, e := guard.New(c.GuardSOCKS)
		if e != nil {
			emit(event{Type: "down", ID: r.ID, Error: e.Error()})
			return
		}
		dial = d.DialContext
	}
	providerFilter := filter.NknFilter{}
	for _, id := range c.AllowProviders {
		providerFilter.Allow = append(providerFilter.Allow, filter.NknClient{Address: id})
	}
	for _, id := range c.DenyProviders {
		providerFilter.Disallow = append(providerFilter.Disallow, filter.NknClient{Address: id})
	}
	for ctx.Err() == nil {
		var closeRoute func()
		done := make(chan error, 1)
		var connected <-chan struct{}
		var allocation func() event
		if r.Forward {
			entry, e := tuna.NewTunaEntry(tuna.Service{Name: "socksproxy", TCP: r.TCP, Encryption: "xsalsa20-poly1305"}, tuna.ServiceInfo{MaxPrice: c.MaxPrice, ListenIP: c.ListenIP, NknFilter: &providerFilter}, w, client, &tuna.EntryConfiguration{USDCLocal: c.USDC, SeedRPCServerAddr: c.RPC, DialTimeout: 5, UDPTimeout: 60, MinBalance: c.MinBalance, TcpDialContext: dial, HttpDialContext: dial, WsDialContext: dial})
			if e != nil {
				emit(event{Type: "down", ID: r.ID, Error: e.Error()})
				return
			}
			closeRoute = entry.Close
			connected = entry.OnConnect.C
			allocation = func() event {
				m := entry.GetMetadata()
				return event{Type: "ready", ID: r.ID, Address: m.Ip, TCP: entry.GetTCPPorts(), Price: m.Price, Beneficiary: paymentBeneficiary(m.BeneficiaryAddr, entry.GetRemoteNknAddress()), Provider: entry.GetRemoteNknAddress()}
			}
			go func() { done <- entry.Start(false) }()
		} else {
			exit, e := tuna.NewTunaExit([]tuna.Service{{Name: r.ID, TCP: r.TCP, UDP: r.UDP, Encryption: "xsalsa20-poly1305"}}, w, client, &tuna.ExitConfiguration{USDCLocal: c.USDC, SeedRPCServerAddr: c.RPC, Reverse: true, ReverseRandomPorts: r.RandomPorts, ReverseTCPPorts: r.PublicTCP, ReverseMaxPrice: c.MaxPrice, ReverseMinBalance: c.MinBalance, DialTimeout: 5, UDPTimeout: 60, Services: map[string]tuna.ExitServiceInfo{r.ID: {Address: "127.0.0.1"}}, ReverseNknFilter: providerFilter, TcpDialContext: dial, HttpDialContext: dial, WsDialContext: dial})
			if e != nil {
				emit(event{Type: "down", ID: r.ID, Error: e.Error()})
				return
			}
			closeRoute = exit.Close
			connected = exit.OnConnect.C
			allocation = func() event {
				m := exit.GetMetadata()
				return event{Type: "ready", ID: r.ID, Address: exit.GetReverseIP().String(), TCP: exit.GetReverseTCPPorts(), UDP: exit.GetReverseUDPPorts(), Price: m.Price, Beneficiary: paymentBeneficiary(m.BeneficiaryAddr, exit.GetRemoteNknAddress()), Provider: exit.GetRemoteNknAddress()}
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
					value := allocation()
					value.Currency = "NKN"
					if c.USDC != nil {
						value.Currency = "USDC"
						value.RegistryID = c.USDC.ProviderID
					}
					emit(value)
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
	walletAddress := flag.String("wallet-address", "", "read a seed file and print only its native NKN address")
	flag.Parse()
	if *walletAddress != "" {
		w, err := readWallet(config{SeedFile: *walletAddress})
		if err != nil {
			log.Fatal(err)
		}
		emit(event{Type: "wallet", Address: w.Address()})
		return
	}
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
	cc := &nkn.ClientConfig{SeedRPCServerAddr: nkn.NewStringArray(c.RPC...), RPCTimeout: 10000}
	if c.GuardSOCKS != "" {
		d, err := guard.New(c.GuardSOCKS)
		if err != nil {
			log.Fatal(err)
		}
		cc.HttpDialContext = d.DialContext
		cc.WsDialContext = d.DialContext
	}
	client, e := nkn.NewMultiClient(w.Account(), "", 4, false, cc)
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

// Mirror the pinned SDK's actual payment receiver when metadata omits an override.
func paymentBeneficiary(explicit, provider string) string {
	if explicit != "" {
		return explicit
	}
	address, err := nkn.ClientAddrToWalletAddr(provider)
	if err != nil {
		return ""
	}
	return address
}
