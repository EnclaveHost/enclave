// transport-probe exercises existing TUNA providers without changing application
// routes. Use an isolated network namespace for the guarded canary mode.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/EnclaveHost/enclave/network/tuna/guard"
	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/tuna"
	"github.com/nknorg/tuna/filter"
)

type configuration struct {
	SeedFile string   `json:"seedFile"`
	RPC      []string `json:"rpc"`
	MaxPrice string   `json:"maxPrice"`
}
type candidate struct {
	Identity    string  `json:"identity"`
	IP          string  `json:"ip"`
	Metadata    string  `json:"-"`
	Price       string  `json:"price"`
	Beneficiary string  `json:"beneficiary"`
	Port        uint32  `json:"-"`
	DelayMS     float64 `json:"delayMs"`
}
type allocation struct {
	candidate
	PublicPort uint32 `json:"publicPort"`
	Verified   bool   `json:"verified"`
}

var outputMu sync.Mutex

func emit(v any) { outputMu.Lock(); defer outputMu.Unlock(); json.NewEncoder(os.Stdout).Encode(v) }
func fatal(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func main() {
	mode := flag.String("mode", "canary", "guard or canary")
	cfgFile := flag.String("config", "", "wallet configuration file")
	guardAddr := flag.String("guard", "", "mandatory SOCKS endpoint for canary")
	listen := flag.String("listen", "0.0.0.0:30489", "guard SOCKS listener")
	inventory := flag.String("inventory", "", "saved NKN provider inventory")
	excluded := flag.String("exclude", "", "comma-separated production provider IPs")
	prefer := flag.String("prefer", "", "comma-separated preferred provider IPs for repeatable experiments")
	count := flag.Int("count", 12, "simultaneous verified reverse allocations")
	hold := flag.Duration("hold", 2*time.Minute, "keep allocations for external verification")
	output := flag.String("output", "", "write allocation report")
	flag.Parse()
	if *count < 1 || *count > 24 {
		log.Fatal("count must be 1..24")
	}
	var cfg configuration
	b, e := os.ReadFile(*cfgFile)
	fatal(e)
	fatal(json.Unmarshal(b, &cfg))
	b, e = os.ReadFile(cfg.SeedFile)
	fatal(e)
	seed, e := hex.DecodeString(strings.TrimSpace(string(b)))
	fatal(e)
	if len(seed) != 32 || len(cfg.RPC) == 0 || cfg.MaxPrice == "" {
		log.Fatal("seed, RPC and price cap required")
	}
	a, e := nkn.NewAccount(seed)
	fatal(e)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	cc := &nkn.ClientConfig{SeedRPCServerAddr: nkn.NewStringArray(cfg.RPC...), RPCTimeout: 10000}
	var guarded *guard.Dialer
	if *mode == "canary" {
		guarded, e = guard.New(*guardAddr)
		fatal(e)
		cc.HttpDialContext = guarded.DialContext
		cc.WsDialContext = guarded.DialContext
	} else if *mode != "guard" {
		log.Fatal("unknown mode")
	}
	w, e := nkn.NewWallet(a, &nkn.WalletConfig{SeedRPCServerAddr: nkn.NewStringArray(cfg.RPC...), RPCTimeout: 10000, HttpDialContext: cc.HttpDialContext})
	fatal(e)
	client, e := nkn.NewMultiClient(a, "privacy-canary-"+*mode, 4, false, cc)
	fatal(e)
	defer client.Close()
	select {
	case <-client.OnConnect.C:
	case <-time.After(90 * time.Second):
		log.Fatal("NKN bootstrap timeout")
	case <-ctx.Done():
		return
	}
	if *mode == "guard" {
		h, p, e := net.SplitHostPort(*listen)
		fatal(e)
		var port uint32
		_, e = fmt.Sscan(p, &port)
		fatal(e)
		entry, e := tuna.NewTunaEntry(tuna.Service{Name: "socksproxy", TCP: []uint32{port}, Encryption: "xsalsa20-poly1305"}, tuna.ServiceInfo{MaxPrice: cfg.MaxPrice, ListenIP: h}, w, client, &tuna.EntryConfiguration{SeedRPCServerAddr: cfg.RPC, DialTimeout: 5, MinBalance: "0.01"})
		fatal(e)
		defer entry.Close()
		done := make(chan error, 1)
		go func() { done <- entry.Start(false) }()
		select {
		case <-entry.OnConnect.C:
			emit(map[string]any{"event": "guard-ready", "provider": entry.GetMetadata().Ip, "beneficiary": entry.GetMetadata().BeneficiaryAddr})
		case e := <-done:
			fatal(e)
			return
		case <-ctx.Done():
			return
		}
		select {
		case e := <-done:
			fatal(e)
		case <-ctx.Done():
		}
		return
	}
	var inv map[string]struct {
		Result struct {
			Subscribers map[string]string `json:"subscribers"`
		} `json:"result"`
	}
	b, e = os.ReadFile(*inventory)
	fatal(e)
	fatal(json.Unmarshal(b, &inv))
	exclude := map[string]bool{}
	for _, ip := range strings.Split(*excluded, ",") {
		exclude[ip] = true
	}
	up, down, e := tuna.ParsePrice(cfg.MaxPrice)
	fatal(e)
	var candidates []candidate
	for id, raw := range inv["reverse"].Result.Subscribers {
		m, e := tuna.ReadMetadata(raw)
		if e != nil || exclude[m.Ip] {
			continue
		}
		ip := net.ParseIP(m.Ip)
		if ip == nil || ip.IsPrivate() || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		u, d, e := tuna.ParsePrice(m.Price)
		if e != nil || u > up || d > down {
			continue
		}
		candidates = append(candidates, candidate{Identity: id, IP: m.Ip, Metadata: raw, Price: m.Price, Beneficiary: m.BeneficiaryAddr, Port: m.TcpPort})
	}
	// Measure via the guard, including the SOCKS handshake; never dial a provider directly.
	var measured []candidate
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for _, c := range candidates {
		c := c
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			probe, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			start := time.Now()
			conn, e := guarded.DialContext(probe, "tcp", net.JoinHostPort(c.IP, fmt.Sprint(c.Port)))
			if e != nil {
				return
			}
			conn.Close()
			c.DelayMS = float64(time.Since(start).Microseconds()) / 1000
			mu.Lock()
			measured = append(measured, c)
			mu.Unlock()
		}()
	}
	wg.Wait()
	preferred := map[string]int{}
	for i, ip := range strings.Split(*prefer, ",") {
		if ip != "" {
			preferred[ip] = i + 1
		}
	}
	sort.Slice(measured, func(i, j int) bool {
		a, b := preferred[measured[i].IP], preferred[measured[j].IP]
		if a == 0 {
			a = 100
		}
		if b == 0 {
			b = 100
		}
		if a != b {
			return a < b
		}
		return measured[i].DelayMS < measured[j].DelayMS
	})
	emit(map[string]any{"event": "inventory", "eligible": len(candidates), "reachableThroughGuard": len(measured)})
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	fatal(e)
	defer listener.Close()
	localPort := uint32(listener.Addr().(*net.TCPAddr).Port)
	go func() {
		for {
			c, e := listener.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	var allocations []allocation
	var exits []*tuna.TunaExit
	usedIP := map[string]bool{}
	defer func() {
		for _, x := range exits {
			x.Close()
		}
	}()
	type result struct {
		exit       *tuna.TunaExit
		allocation allocation
	}
	attempt := func(c candidate) result {
		x, e := tuna.NewTunaExit([]tuna.Service{{Name: "enclave-privacy-canary", TCP: []uint32{localPort}, Encryption: "xsalsa20-poly1305"}}, w, client, &tuna.ExitConfiguration{SeedRPCServerAddr: cfg.RPC, Reverse: true, ReverseTCPPorts: []uint32{443}, ReverseMaxPrice: cfg.MaxPrice, ReverseMinBalance: "0.01", DialTimeout: 5, TcpDialContext: guarded.DialContext, HttpDialContext: guarded.DialContext, WsDialContext: guarded.DialContext, ReverseNknFilter: filter.NknFilter{Allow: []filter.NknClient{{Address: c.Identity, Metadata: c.Metadata}}}, Services: map[string]tuna.ExitServiceInfo{"enclave-privacy-canary": {Address: "127.0.0.1"}}})
		if e != nil {
			emit(map[string]any{"event": "allocation-failed", "ip": c.IP, "error": e.Error()})
			return result{}
		}
		done := make(chan error, 1)
		x.SetLinger(0)
		go func() { done <- x.StartReverse(false) }()
		ready := false
		select {
		case _, ok := <-x.OnConnect.C:
			ready = ok
		case <-done:
		case <-time.After(18 * time.Second):
		case <-ctx.Done():
		}
		if !ready {
			go x.Close()
			emit(map[string]any{"event": "allocation-failed", "ip": c.IP, "error": "not ready within 18s"})
			return result{}
		}
		probe, cancel := context.WithTimeout(ctx, 8*time.Second)
		conn, e := guarded.DialContext(probe, "tcp", net.JoinHostPort(x.GetReverseIP().String(), "443"))
		verified := false
		if e == nil {
			conn.SetDeadline(time.Now().Add(8 * time.Second))
			payload := []byte("enclave-privacy-probe:" + c.Identity)
			_, e = conn.Write(payload)
			got := make([]byte, len(payload))
			if e == nil {
				_, e = io.ReadFull(conn, got)
			}
			verified = e == nil && bytes.Equal(got, payload)
			conn.Close()
		}
		cancel()
		if !verified {
			go x.Close()
			emit(map[string]any{"event": "allocation-failed", "ip": c.IP, "error": fmt.Sprint(e)})
			return result{}
		}
		return result{x, allocation{candidate: c, PublicPort: 443, Verified: true}}
	}
	// Four simultaneous candidates bound connection pressure and scan time.
	for offset := 0; offset < len(measured) && len(allocations) < *count; {
		if ctx.Err() != nil {
			return
		}
		results := make(chan result, 4)
		jobs := 0
		for offset < len(measured) && jobs < 4 {
			c := measured[offset]
			offset++
			if usedIP[c.IP] {
				continue
			}
			usedIP[c.IP] = true
			jobs++
			go func() { results <- attempt(c) }()
		}
		for i := 0; i < jobs; i++ {
			r := <-results
			if r.exit == nil {
				continue
			}
			if len(allocations) >= *count {
				r.exit.Close()
				continue
			}
			exits = append(exits, r.exit)
			allocations = append(allocations, r.allocation)
			emit(map[string]any{"event": "allocated", "count": len(allocations), "allocation": r.allocation})
			if *output != "" {
				b, _ := json.MarshalIndent(allocations, "", "  ")
				fatal(os.WriteFile(*output, b, 0600))
			}
		}
	}

	emit(map[string]any{"event": "capacity-result", "requested": *count, "allocated": len(allocations), "pass": len(allocations) >= *count, "holdSeconds": hold.Seconds()})
	select {
	case <-time.After(*hold):
	case <-ctx.Done():
	}
	if len(allocations) < *count {
		os.Exit(2)
	}
}
