// USDC-only TUNA provider. Its local controller verifies owner authorization
// and signs receipts. The SOCKS service is separately confined and qualified;
// this process never opens an unauthenticated public SOCKS listener.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/tuna"
)

type config struct {
	SeedFile        string               `json:"seedFile"`
	RPC             []string             `json:"rpc"`
	PublicIP        string               `json:"publicIP"`
	ForwardPort     uint16               `json:"forwardPort"`
	ReversePort     uint16               `json:"reversePort"`
	SocksPort       uint16               `json:"socksPort"`
	SubscriptionFee string               `json:"subscriptionFee"`
	USDC            tuna.USDCLocalConfig `json:"usdc"`
}

func run(file string) error {
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var cfg config
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&cfg); err != nil {
		return err
	}
	ip := net.ParseIP(cfg.PublicIP)
	if ip == nil || ip.To4() == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || cfg.ForwardPort < 1024 || cfg.ReversePort < 1024 || cfg.ForwardPort == cfg.ReversePort || cfg.SocksPort == 0 || len(cfg.RPC) < 2 {
		return errors.New("explicit public IPv4, distinct transport ports and native RPCs required")
	}
	origins := make(map[string]bool)
	for _, endpoint := range cfg.RPC {
		u, err := url.Parse(endpoint)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || origins[u.Hostname()] {
			return errors.New("independent native HTTPS RPC hosts required")
		}
		origins[u.Hostname()] = true
	}
	if !filepath.IsAbs(cfg.SeedFile) {
		return errors.New("absolute private native identity required")
	}
	st, err := os.Stat(cfg.SeedFile)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0 {
		return errors.New("private native identity permissions required")
	}
	key, err := os.ReadFile(cfg.SeedFile)
	if err != nil {
		return err
	}
	seed, err := hex.DecodeString(strings.TrimSpace(string(key)))
	if err != nil || len(seed) != 32 {
		return errors.New("native seed must be 32 bytes")
	}
	if len(cfg.USDC.ProviderID) != 66 || !strings.HasPrefix(cfg.USDC.ProviderID, "0x") {
		return errors.New("on-chain provider identity required")
	}
	if _, err = hex.DecodeString(cfg.USDC.ProviderID[2:]); err != nil {
		return err
	}
	if price, e := strconv.ParseUint(cfg.USDC.PricePerGiB6, 10, 64); e != nil || price == 0 {
		return errors.New("positive advertised USDC price required")
	}
	if amount, e := nkn.NewAmount(cfg.SubscriptionFee); e != nil || amount.ToFixed64() < 0 {
		return errors.New("nonnegative native subscription fee required")
	}
	controller, err := tuna.NewLocalUSDCController(cfg.USDC)
	if err != nil {
		return err
	}
	account, err := nkn.NewAccount(seed)
	if err != nil {
		return err
	}
	wallet, err := nkn.NewWallet(account, &nkn.WalletConfig{SeedRPCServerAddr: nkn.NewStringArray(cfg.RPC...), RPCTimeout: 10000})
	if err != nil {
		return err
	}
	forward, err := tuna.NewTunaExit([]tuna.Service{{Name: "socksproxy", TCP: []uint32{uint32(cfg.SocksPort)}, Encryption: "xsalsa20-poly1305"}}, wallet, nil, &tuna.ExitConfiguration{
		USDC: controller, USDCLocal: &cfg.USDC, PublicIP: cfg.PublicIP, SeedRPCServerAddr: cfg.RPC, ListenTCP: int32(cfg.ForwardPort), DialTimeout: 10, SubscriptionDuration: 40000, SubscriptionFee: cfg.SubscriptionFee,
		Services: map[string]tuna.ExitServiceInfo{"socksproxy": {Address: "127.0.0.1", Price: "0"}},
	})
	if err != nil {
		return err
	}
	defer forward.Close()
	if err = forward.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() {
		done <- tuna.StartReverse(&tuna.EntryConfiguration{USDC: controller, USDCLocal: &cfg.USDC, PublicIP: cfg.PublicIP, SeedRPCServerAddr: cfg.RPC, Reverse: true, ReverseTCP: int32(cfg.ReversePort), ReverseServiceListenIP: "0.0.0.0", ReversePrice: "0", ReverseSubscriptionDuration: 40000, ReverseSubscriptionFee: cfg.SubscriptionFee, DialTimeout: 10}, wallet)
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	select {
	case <-stop:
		return nil
	case err = <-done:
		return err
	}
}
func main() {
	file := flag.String("config", "", "USDC provider configuration")
	flag.Parse()
	if err := run(*file); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
