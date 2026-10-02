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
		for _, service := range []string{"reverse", "socksproxy"} {
			r, e := nkn.GetSubscribersContext(ctx, "tuna_v1."+service, 0, 1000, true, false, nil, c)
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
		Identity    string   `json:"identity"`
		Address     string   `json:"address"`
		Price       string   `json:"price"`
		Beneficiary string   `json:"beneficiary"`
		Services    []string `json:"services"`
		ExpiresAt   int64    `json:"expiresAt"`
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
			if e != nil || m.Ip == "" || m.BeneficiaryAddr == "" {
				continue
			}
			n := nodes[id]
			if n == nil {
				n = &node{Identity: id, Address: m.Ip, Price: m.Price, Beneficiary: m.BeneficiaryAddr, ExpiresAt: expires}
				nodes[id] = n
			}
			if n.Address == m.Ip && n.Price == m.Price && n.Beneficiary == m.BeneficiaryAddr {
				n.Services = append(n.Services, service)
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
