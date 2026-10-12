// sweep-wallet sends a retired privacy wallet's whole NKN balance, less the fee, back to one address (the funding
// wallet). As topup-privacy-wallets, the signed transaction is written to an audit file BEFORE it is broadcast.
//
//	sweep-wallet -seed FILE -to NKN... -audit FILE [-dry-run]
package main

import (
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

func check(e error) {
	if e != nil {
		panic(e)
	}
}

func main() {
	seedFile := flag.String("seed", "", "the retired wallet's seed file (hex)")
	to := flag.String("to", "", "where its balance goes")
	audit := flag.String("audit", "", "audit JSON written before broadcast (must not exist)")
	dry := flag.Bool("dry-run", false, "print the plan only")
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
	dest, e := common.ToScriptHash(*to)
	check(e)
	if *to == w.Address() {
		panic("refusing to sweep a wallet into itself")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	bal, e := w.BalanceContext(ctx)
	check(e)
	fee, _ := common.StringToFixed64("0.001")
	amt := bal.ToFixed64() - fee
	if amt <= 0 {
		fmt.Println(w.Address(), "balance", bal.String(), "- nothing to sweep")
		return
	}
	fmt.Println(w.Address(), "balance", bal.String(), "-> sweep", amt.String(), "to", *to)
	if *dry {
		return
	}
	nonce, e := w.GetNonceContext(ctx, true)
	check(e)
	tx, e := transaction.NewTransferAssetTransaction(w.ProgramHash(), dest, uint64(nonce), amt, fee)
	check(e)
	check(w.SignTransaction(tx))
	raw, e := tx.Marshal()
	check(e)
	h := tx.Hash()
	rec := map[string]string{"from": w.Address(), "to": *to, "amount": amt.String(), "hash": h.ToHexString(), "raw": hex.EncodeToString(raw), "state": "prepared"}
	out, e := os.OpenFile(*audit, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	check(e)
	check(json.NewEncoder(out).Encode(rec))
	check(out.Close())
	sent, e := w.SendRawTransactionContext(ctx, tx)
	if e != nil {
		fmt.Println("uncertain broadcast; reuse the persisted raw transaction only:", rec["hash"])
		check(e)
	}
	if sent != rec["hash"] {
		panic("broadcast hash mismatch")
	}
	fmt.Println("broadcast", sent)
}
