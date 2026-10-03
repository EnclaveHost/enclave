// topup-privacy-wallets brings each privacy-agent wallet up to a target NKN balance from the funding wallet.
// Every signed transaction is written to an audit file BEFORE it is broadcast, so an uncertain broadcast is
// only ever retried with the same persisted raw transaction (no double payment).
//
//	topup-privacy-wallets -seed FILE -source NKN... -targets FILE -audit FILE [-dry-run]
//
// targets: one line per wallet group, "<label> <target NKN> <address> [<address>...]".
package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/nkn/v2/common"
	"github.com/nknorg/nkn/v2/transaction"
)

type record struct {
	Label   string `json:"label"`
	Address string `json:"address"`
	Before  string `json:"before"`
	Amount  string `json:"amount"`
	Nonce   uint64 `json:"nonce"`
	Hash    string `json:"hash"`
	Raw     string `json:"raw"`
	State   string `json:"state"`
}

func check(e error) {
	if e != nil {
		panic(e)
	}
}

// Refill to the existing target only after crossing the low-water mark. This
// permits frequent checks without creating a payment for every tiny debit.
func refillNeeded(balance, target, lowWatermark common.Fixed64) bool {
	threshold := target
	if lowWatermark > 0 && lowWatermark < target {
		threshold = lowWatermark
	}
	return balance < threshold
}

func main() {
	seedFile := flag.String("seed", "", "funding wallet seed file (hex)")
	source := flag.String("source", "", "expected funding wallet address")
	targetsFile := flag.String("targets", "", "targets file")
	audit := flag.String("audit", "", "audit JSON written before broadcast (must not exist)")
	dry := flag.Bool("dry-run", false, "print the plan only")
	lowWatermark := flag.String("low-watermark", "0", "refill only below this NKN balance (0 means target)")
	maxTotal := flag.String("max-total", "10", "refuse a plan above this many NKN")
	flag.Parse()
	b, e := os.ReadFile(*seedFile)
	check(e)
	seed, e := hex.DecodeString(strings.TrimSpace(string(b)))
	check(e)
	a, e := nkn.NewAccount(seed)
	check(e)
	rpc := nkn.NewStringArray("http://seed.nkn.org:30003", "http://mainnet-seed-0001.nkn.org:30003", "http://mainnet-seed-0002.nkn.org:30003")
	w, e := nkn.NewWallet(a, &nkn.WalletConfig{SeedRPCServerAddr: rpc, RPCTimeout: 12000})
	check(e)
	if w.Address() != *source {
		panic("funding wallet is not " + *source)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()
	fee, _ := common.StringToFixed64("0.001")
	limit, e := common.StringToFixed64(*maxTotal)
	check(e)
	low, e := common.StringToFixed64(*lowWatermark)
	check(e)
	if low < 0 {
		panic("low-watermark must not be negative")
	}
	var plan []record
	var total common.Fixed64
	seen := map[string]bool{}
	f, e := os.Open(*targetsFile)
	check(e)
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		parts := strings.Fields(sc.Text())
		if len(parts) < 3 {
			continue
		}
		target, e := common.StringToFixed64(parts[1])
		check(e)
		for _, addr := range parts[2:] {
			if seen[addr] {
				panic("duplicate address " + addr)
			}
			seen[addr] = true
			_, e := common.ToScriptHash(addr)
			check(e)
			bal, e := nkn.GetBalanceContext(ctx, addr, &nkn.RPCConfig{SeedRPCServerAddr: rpc, RPCTimeout: 12000})
			check(e)
			if !refillNeeded(bal.ToFixed64(), target, low) {
				continue
			}
			amt := target - bal.ToFixed64()
			plan = append(plan, record{Label: parts[0], Address: addr, Before: bal.String(), Amount: amt.String()})
			total += amt + fee
		}
	}
	check(sc.Err())
	src, e := w.BalanceContext(ctx)
	check(e)
	fmt.Printf("source %s balance %s; %d top-ups totalling %s NKN incl. fees\n", w.Address(), src.String(), len(plan), total.String())
	for _, r := range plan {
		fmt.Printf("  %-14s %s  %s -> +%s\n", r.Label, r.Address, r.Before, r.Amount)
	}
	if total > limit {
		panic("plan exceeds -max-total")
	}
	if src.ToFixed64() < total {
		panic("insufficient source balance")
	}
	if *dry || len(plan) == 0 {
		return
	}
	nonce, e := w.GetNonceContext(ctx, true)
	check(e)
	var txs []*transaction.Transaction
	for i := range plan {
		amt, _ := common.StringToFixed64(plan[i].Amount)
		to, _ := common.ToScriptHash(plan[i].Address)
		tx, e := transaction.NewTransferAssetTransaction(w.ProgramHash(), to, uint64(nonce)+uint64(i), amt, fee)
		check(e)
		check(w.SignTransaction(tx))
		raw, e := tx.Marshal()
		check(e)
		h := tx.Hash()
		plan[i].Nonce, plan[i].Hash, plan[i].Raw, plan[i].State = uint64(nonce)+uint64(i), h.ToHexString(), hex.EncodeToString(raw), "prepared"
		txs = append(txs, tx)
	}
	write := func(flags int) {
		out, e := os.OpenFile(*audit, flags, 0600)
		check(e)
		check(json.NewEncoder(out).Encode(plan))
		check(out.Sync())
		check(out.Close())
	}
	write(os.O_CREATE | os.O_EXCL | os.O_WRONLY)
	for i, tx := range txs {
		sent, e := w.SendRawTransactionContext(ctx, tx)
		if e != nil {
			fmt.Println("uncertain broadcast; reuse the persisted raw transaction only:", plan[i].Hash)
			check(e)
		}
		if sent != plan[i].Hash {
			panic("broadcast hash mismatch")
		}
		plan[i].State = "broadcast"
		write(os.O_WRONLY | os.O_TRUNC)
		fmt.Println(plan[i].Label, plan[i].Address, "+"+plan[i].Amount, sent)
	}
}
