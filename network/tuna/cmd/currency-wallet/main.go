// currency-wallet is an offline native-NKN signer and transaction inspector.
// It has no RPC or broadcast operation. Keys never leave this process.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	nkn "github.com/nknorg/nkn-sdk-go"
	"github.com/nknorg/nkn/v2/common"
	"github.com/nknorg/nkn/v2/pb"
	"github.com/nknorg/nkn/v2/transaction"
)

type request struct {
	Action    string          `json:"action"`
	Address   string          `json:"address,omitempty"`
	Recipient string          `json:"recipient,omitempty"`
	Amount    string          `json:"amount,omitempty"`
	Fee       string          `json:"fee,omitempty"`
	Nonce     string          `json:"nonce,omitempty"`
	Raw       string          `json:"raw,omitempty"`
	Info      json.RawMessage `json:"info,omitempty"`
}
type result struct {
	Info    string `json:"info,omitempty"`
	Address string `json:"address,omitempty"`
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Amount  string `json:"amount,omitempty"`
	Fee     string `json:"fee,omitempty"`
	Nonce   string `json:"nonce,omitempty"`
	Raw     string `json:"raw,omitempty"`
	Hash    string `json:"hash,omitempty"`
}

var integer = regexp.MustCompile(`^(0|[1-9][0-9]{0,19})$`)

func amount(s string, positive bool) (int64, error) {
	if !integer.MatchString(s) {
		return 0, errors.New("invalid integer amount")
	}
	n, e := strconv.ParseInt(s, 10, 64)
	if e != nil || n < 0 || (positive && n == 0) {
		return 0, errors.New("amount out of range")
	}
	return n, nil
}
func wallet(file string) (*nkn.Wallet, error) {
	st, e := os.Stat(file)
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || (runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0) {
		return nil, errors.New("private seed file permissions required")
	}
	b, e := os.ReadFile(file)
	if e != nil {
		return nil, e
	}
	seed, e := hex.DecodeString(strings.TrimSpace(string(b)))
	if e != nil || len(seed) != 32 {
		return nil, errors.New("32-byte private seed required")
	}
	account, e := nkn.NewAccount(seed)
	if e != nil {
		return nil, e
	}
	return nkn.NewWallet(account, nil)
}
func inspect(tx *transaction.Transaction) (result, error) {
	var out result
	if tx.Transaction == nil || tx.UnsignedTx == nil || tx.UnsignedTx.Payload == nil || tx.UnsignedTx.Payload.Type != pb.PayloadType_TRANSFER_ASSET_TYPE || len(tx.Programs) != 1 || tx.UnsignedTx.Fee < 0 {
		return out, errors.New("signed native transfer required")
	}
	if e := tx.VerifySignature(); e != nil {
		return out, errors.New("invalid native transfer signature")
	}
	payload, e := transaction.Unpack(tx.UnsignedTx.Payload)
	if e != nil {
		return out, e
	}
	p, ok := payload.(*pb.TransferAsset)
	if !ok || p.Amount <= 0 {
		return out, errors.New("positive native transfer required")
	}
	from, e := common.Uint160ParseFromBytes(p.Sender)
	if e != nil {
		return out, e
	}
	to, e := common.Uint160ParseFromBytes(p.Recipient)
	if e != nil {
		return out, e
	}
	out.From, e = from.ToAddress()
	if e != nil {
		return out, e
	}
	out.To, e = to.ToAddress()
	if e != nil {
		return out, e
	}
	out.Amount = strconv.FormatInt(p.Amount, 10)
	out.Fee = strconv.FormatInt(tx.UnsignedTx.Fee, 10)
	out.Nonce = strconv.FormatUint(tx.UnsignedTx.Nonce, 10)
	wire, e := tx.Marshal()
	if e != nil {
		return out, e
	}
	info, e := tx.GetInfo()
	if e != nil {
		return out, e
	}
	out.Info = string(info)
	out.Raw = hex.EncodeToString(wire)
	hash := tx.Hash()
	out.Hash = hash.ToHexString()
	return out, nil
}
func fromInfo(raw json.RawMessage) (*transaction.Transaction, string, error) {
	// Parse JSON integers in Go, without JavaScript's 53-bit rounding.
	var info struct {
		TxType     string `json:"txType"`
		Payload    string `json:"payloadData"`
		Nonce      uint64 `json:"nonce"`
		Fee        int64  `json:"fee"`
		Attributes string `json:"attributes"`
		Programs   []struct {
			Code      string `json:"code"`
			Parameter string `json:"parameter"`
		} `json:"programs"`
		Hash string `json:"hash"`
	}
	if e := json.Unmarshal(raw, &info); e != nil {
		return nil, "", e
	}
	if info.TxType != "TRANSFER_ASSET_TYPE" {
		return nil, "", errors.New("native transfer required")
	}
	payload, e := hex.DecodeString(info.Payload)
	if e != nil {
		return nil, "", e
	}
	attrs, e := hex.DecodeString(info.Attributes)
	if e != nil {
		return nil, "", e
	}
	tx := &transaction.Transaction{Transaction: &pb.Transaction{UnsignedTx: &pb.UnsignedTx{Payload: &pb.Payload{Type: pb.PayloadType_TRANSFER_ASSET_TYPE, Data: payload}, Nonce: info.Nonce, Fee: info.Fee, Attributes: attrs}}}
	for _, p := range info.Programs {
		code, e := hex.DecodeString(p.Code)
		if e != nil {
			return nil, "", e
		}
		parameter, e := hex.DecodeString(p.Parameter)
		if e != nil {
			return nil, "", e
		}
		tx.Programs = append(tx.Programs, &pb.Program{Code: code, Parameter: parameter})
	}
	return tx, info.Hash, nil
}
func run(r request, seedFile string) (result, error) {
	switch r.Action {
	case "validateAddress":
		_, e := common.ToScriptHash(r.Address)
		return result{Address: r.Address}, e
	case "inspect":
		tx := &transaction.Transaction{}
		var expected string
		if len(r.Info) > 0 {
			var e error
			tx, expected, e = fromInfo(r.Info)
			if e != nil {
				return result{}, e
			}
		} else {
			wire, e := hex.DecodeString(r.Raw)
			if e != nil || len(wire) > 8192 {
				return result{}, errors.New("invalid signed transaction")
			}
			if e = tx.Unmarshal(wire); e != nil {
				return result{}, e
			}
		}
		out, e := inspect(tx)
		if e != nil {
			return result{}, e
		}
		if expected != "" && out.Hash != expected {
			return result{}, errors.New("transaction hash mismatch")
		}
		return out, nil
	case "address", "prepare":
		w, e := wallet(seedFile)
		if e != nil {
			return result{}, e
		}
		if r.Action == "address" {
			return result{Address: w.Address()}, nil
		}
		to, e := common.ToScriptHash(r.Recipient)
		if e != nil {
			return result{}, e
		}
		n, e := amount(r.Amount, true)
		if e != nil {
			return result{}, e
		}
		fee, e := amount(r.Fee, false)
		if e != nil {
			return result{}, e
		}
		if !integer.MatchString(r.Nonce) {
			return result{}, errors.New("invalid nonce")
		}
		nonce, e := strconv.ParseUint(r.Nonce, 10, 64)
		if e != nil {
			return result{}, e
		}
		tx, e := transaction.NewTransferAssetTransaction(w.ProgramHash(), to, nonce, common.Fixed64(n), common.Fixed64(fee))
		if e != nil {
			return result{}, e
		}
		if e = w.SignTransaction(tx); e != nil {
			return result{}, e
		}
		return inspect(tx)
	default:
		return result{}, errors.New("unsupported offline wallet operation")
	}
}
func main() {
	seed := flag.String("seed-file", "", "private provider seed file (prepare/address only)")
	flag.Parse()
	var r request
	d := json.NewDecoder(io.LimitReader(os.Stdin, 32769))
	d.DisallowUnknownFields()
	if e := d.Decode(&r); e != nil {
		fmt.Fprintln(os.Stderr, "invalid wallet request")
		os.Exit(1)
	}
	if d.Decode(new(any)) != io.EOF {
		fmt.Fprintln(os.Stderr, "one wallet request required")
		os.Exit(1)
	}
	out, e := run(r, *seed)
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	if e = json.NewEncoder(os.Stdout).Encode(out); e != nil {
		os.Exit(1)
	}
}
