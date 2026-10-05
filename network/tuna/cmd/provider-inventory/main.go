// provider-inventory decodes NKN's public subscriptions using the same pinned
// metadata implementation as the transport. It holds no account or wallet.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/tuna"
	"os"
	"strings"
	"time"
)

func main() {
	includeUSDC := flag.Bool("usdc", false, "include USDC provider subscriptions")
	rpc := flag.String("rpc", "", "comma-separated native NKN RPCs")
	saved := flag.String("saved", "", "optional saved RPC responses for offline inspection")
	flag.Parse()
	var inventory map[string]struct {
		Result struct {
			Subscribers map[string]string `json:"subscribers"`
		} `json:"result"`
	}
	if *saved != "" {
		b, e := os.ReadFile(*saved)
		if e != nil {
			panic(e)
		}
		if e = json.Unmarshal(b, &inventory); e != nil {
			panic(e)
		}
	} else {
		if *rpc == "" {
			panic("explicit RPCs required")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		c := &nkn.WalletConfig{SeedRPCServerAddr: nkn.NewStringArray(strings.Split(*rpc, ",")...), RPCTimeout: 10000}
		inventory = make(map[string]struct {
			Result struct {
				Subscribers map[string]string `json:"subscribers"`
			} `json:"result"`
		})
		services := []string{"reverse", "socksproxy"}
		if *includeUSDC {
			services = append(services, "usdc:reverse", "usdc:socksproxy")
		}
		for _, service := range services {
			prefix, name := tuna.DefaultSubscriptionPrefix, service
			if strings.HasPrefix(service, "usdc:") {
				prefix = tuna.USDCSubscriptionPrefix
				name = strings.TrimPrefix(service, "usdc:")
			}
			r, e := nkn.GetSubscribersContext(ctx, prefix+name, 0, 1000, true, false, nil, c)
			if e != nil {
				fmt.Fprintln(os.Stderr, e)
				os.Exit(1)
			}
			v := inventory[service]
			v.Result.Subscribers = r.Subscribers.Map()
			inventory[service] = v
		}
	}
	type node struct {
		Currency     string   `json:"currency,omitempty"`
		RegistryID   string   `json:"registryId,omitempty"`
		PricePerGiB6 string   `json:"pricePerGiB6,omitempty"`
		Identity     string   `json:"identity"`
		Address      string   `json:"address"`
		Price        string   `json:"price"`
		Beneficiary  string   `json:"beneficiary"`
		Services     []string `json:"services"`
		ExpiresAt    int64    `json:"expiresAt"`
	}
	nodes := map[string]*node{}
	expires := time.Now().Add(60 * time.Second).UnixMilli()
	if *saved != "" {
		info, err := os.Stat(*saved)
		if err != nil {
			panic(err)
		}
		expires = info.ModTime().Add(60 * time.Second).UnixMilli()
	}
	for service, response := range inventory {
		for id, raw := range response.Result.Subscribers {
			m, e := tuna.ReadMetadata(raw)
			if e != nil || m.Ip == "" {
				continue
			}
			if m.BeneficiaryAddr == "" {
				// The SDK pays the wallet derived from the provider's NKN key
				// when its advertisement does not override the beneficiary.
				m.BeneficiaryAddr, e = nkn.ClientAddrToWalletAddr(id)
				if e != nil {
					continue
				}
			}
			currency, key := "NKN", id
			if strings.HasPrefix(service, "usdc:") {
				if m.SettlementMode != 1 || len(m.RegistryId) != 66 || m.UsdcPricePerGib6 == 0 {
					continue
				}
				currency = "USDC"
				key = "usdc:" + id
			}
			n := nodes[key]
			if n == nil {
				n = &node{Identity: id, Address: m.Ip, Price: m.Price, Beneficiary: m.BeneficiaryAddr, ExpiresAt: expires, Currency: currency, RegistryID: m.RegistryId, PricePerGiB6: fmt.Sprint(m.UsdcPricePerGib6)}
				nodes[key] = n
			}
			if n.Address == m.Ip && n.Price == m.Price && n.Beneficiary == m.BeneficiaryAddr {
				if n.RegistryID != m.RegistryId || n.PricePerGiB6 != fmt.Sprint(m.UsdcPricePerGib6) {
					continue
				}
				n.Services = append(n.Services, strings.TrimPrefix(service, "usdc:"))
			}
		}
	}
	list := make([]*node, 0, len(nodes))
	for _, n := range nodes {
		list = append(list, n)
	}
	if e := json.NewEncoder(os.Stdout).Encode(list); e != nil {
		panic(e)
	}
}
