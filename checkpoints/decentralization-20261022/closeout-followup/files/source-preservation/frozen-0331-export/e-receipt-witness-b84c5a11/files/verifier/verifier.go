// Package receiptwitness verifies an event-derived view of ONE Enclave deployment's lease against Base headers that
// are hash-linked to an anchor block, using only consensus data: header hashes, receiptsRoot and logsBloom.
//
// What is proven, given that the anchor hash is canonical:
//   - every header from the event block E to the anchor A is the one the anchor commits to (parentHash chain);
//   - every receipt list used hashes to its header's receiptsRoot (op-geth DeriveSha over consensus encodings, with
//     each receipt's bloom recomputed from its logs, never taken from the input);
//   - completeness over (E, A]: every block either has a header bloom that does not admit both the ledger address and
//     the deployment id (blooms have no false negatives), or has a verified receipt list scanned for such logs.
//
// What is NOT proven here, and must be said by the caller:
//   - that the anchor is canonical: that is the head source's job (a sequencer-signed gossip head, or later an
//     L1-finalized output root). This package takes the anchor hash as an input;
//   - anything before E: the operator of a lease renewed (not claimed) inside the window, and any state the lease
//     events do not carry (see the coverage matrix: retire() is silent, SharesSet rewrites leaseUntil silently).
package receiptwitness

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/trie"
)

// Fixture is the untrusted capture (probe/capture.mjs): raw JSON-RPC headers and receipt lists.
type Fixture struct {
	Ledger       common.Address             `json:"ledger"`
	DeploymentID common.Hash                `json:"deploymentId"`
	EventBlock   uint64                     `json:"eventBlock"`
	AnchorBlock  uint64                     `json:"anchorBlock"`
	Headers      []json.RawMessage          `json:"headers"`
	Receipts     map[string]json.RawMessage `json:"receipts"`
}

// Event signatures of the deployed ledger (sources/deployed/ledger-rev16d--EnclaveDeployments.sol:528,534-536).
var (
	topicClaimed   = crypto.Keccak256Hash([]byte("Claimed(bytes32,bytes32,address,uint64,uint256)"))
	topicRenewed   = crypto.Keccak256Hash([]byte("Renewed(bytes32,bytes32,uint64,uint256)"))
	topicReleased  = crypto.Keccak256Hash([]byte("Released(bytes32,bytes32,uint256)"))
	topicSharesSet = crypto.Keccak256Hash([]byte("SharesSet(bytes32,uint16,uint16,uint256)"))
)

// Event is one verified ledger log for the deployment, located by consensus position (not by provider metadata).
type Event struct {
	Kind         string      `json:"kind"`
	Block        uint64      `json:"block"`
	BlockHash    common.Hash `json:"blockHash"`
	ReceiptIndex int         `json:"receiptIndex"`
	LogIndex     int         `json:"logIndex"` // index within the block, counted from verified receipts
	Topic0       common.Hash `json:"topic0"`
}

// View is the lease state of the deployment as of the anchor block, with what proves it.
type View struct {
	DeploymentID     common.Hash     `json:"deploymentId"`
	AnchorBlock      uint64          `json:"anchorBlock"`
	AnchorHash       common.Hash     `json:"anchorHash"`
	AnchorTimestamp  uint64          `json:"anchorTimestamp"`
	Runner           common.Hash     `json:"runner"`
	RunnerOperator   *common.Address `json:"runnerOperator"` // nil: not determined inside the window
	LeaseUntil       *uint64         `json:"leaseUntil"`     // nil: rewritten silently (SharesSet while leased)
	Leased           *bool           `json:"leased"`
	LastLeaseEvent   Event           `json:"lastLeaseEvent"`
	OtherEvents      int             `json:"otherDeploymentEvents"`
	BlocksChecked    int             `json:"blocksChecked"`
	BloomNegative    int             `json:"bloomNegativeBlocks"`
	ReceiptVerified  int             `json:"receiptVerifiedBlocks"`
	ReceiptsVerified int             `json:"receiptsVerified"`
	Caveats          []string        `json:"caveats"`
}

type header struct {
	h    *types.Header
	hash common.Hash
}

func parseHeader(raw json.RawMessage) (header, error) {
	var h types.Header
	if err := json.Unmarshal(raw, &h); err != nil {
		return header{}, fmt.Errorf("header: %w", err)
	}
	if h.Number == nil {
		return header{}, errors.New("header without a number")
	}
	var claimed struct {
		Hash common.Hash `json:"hash"`
	}
	if err := json.Unmarshal(raw, &claimed); err != nil {
		return header{}, err
	}
	hash := h.Hash() // keccak256(rlp(header)) recomputed: the provider's "hash" is only compared, never used
	if hash != claimed.Hash {
		return header{}, fmt.Errorf("block %d: recomputed hash %s differs from the claimed %s (unknown header field or tampering)",
			h.Number, hash, claimed.Hash)
	}
	return header{&h, hash}, nil
}

// Limits bound every untrusted input BEFORE it is parsed. A refusal never changes what a successful proof means.
type Limits struct {
	MaxWindow           uint64 // blocks E..A
	MaxHeaderBytes      int    // one raw header
	MaxReceiptListBytes int    // one block's raw receipt list
	MaxReceiptsPerBlock int
	MaxLogsPerReceipt   int
	MaxTotalBytes       int64 // all raw headers + receipt lists
}

// DefaultLimits are generous for Base mainnet: the largest observed receipt list was 1.8 MB of JSON (485 receipts).
var DefaultLimits = Limits{MaxWindow: 10000, MaxHeaderBytes: 64 << 10, MaxReceiptListBytes: 32 << 20,
	MaxReceiptsPerBlock: 20000, MaxLogsPerReceipt: 10000, MaxTotalBytes: 512 << 20}

// receiptsFor verifies one block's receipt list against its header and returns it.
func receiptsFor(raw json.RawMessage, hd header, lim Limits) (types.Receipts, error) {
	if len(raw) > lim.MaxReceiptListBytes {
		return nil, fmt.Errorf("block %d: receipt list of %d bytes exceeds %d", hd.h.Number, len(raw), lim.MaxReceiptListBytes)
	}
	var rs []*types.Receipt
	if err := json.Unmarshal(raw, &rs); err != nil {
		return nil, fmt.Errorf("block %d receipts: %w", hd.h.Number, err)
	}
	if len(rs) > lim.MaxReceiptsPerBlock {
		return nil, fmt.Errorf("block %d: %d receipts exceed %d", hd.h.Number, len(rs), lim.MaxReceiptsPerBlock)
	}
	for i, r := range rs { // untrusted JSON may hold null entries; refuse them instead of dereferencing
		if r == nil {
			return nil, fmt.Errorf("block %d: receipt %d is null", hd.h.Number, i)
		}
		if len(r.Logs) > lim.MaxLogsPerReceipt {
			return nil, fmt.Errorf("block %d: receipt %d has %d logs, above %d", hd.h.Number, i, len(r.Logs), lim.MaxLogsPerReceipt)
		}
		for j, lg := range r.Logs {
			if lg == nil {
				return nil, fmt.Errorf("block %d: receipt %d log %d is null", hd.h.Number, i, j)
			}
		}
	}
	var union types.Bloom
	for _, r := range rs {
		r.Bloom = types.CreateBloom(r) // derived from the logs; the input bloom is ignored
		for i := range union {
			union[i] |= r.Bloom[i]
		}
	}
	root := types.DeriveSha(types.Receipts(rs), trie.NewStackTrie(nil))
	if root != hd.h.ReceiptHash {
		return nil, fmt.Errorf("block %d: receipts root %s differs from the header's %s (omitted, altered or extra receipts)",
			hd.h.Number, root, hd.h.ReceiptHash)
	}
	if union != hd.h.Bloom {
		return nil, fmt.Errorf("block %d: logsBloom is not the union of its receipts' blooms", hd.h.Number)
	}
	return rs, nil
}

func u64word(data []byte, i int) (uint64, error) {
	if len(data) < 32*(i+1) {
		return 0, errors.New("short event data")
	}
	v := new(big.Int).SetBytes(data[32*i : 32*(i+1)])
	if !v.IsUint64() {
		return 0, errors.New("event word exceeds uint64")
	}
	return v.Uint64(), nil
}

// Verify checks the fixture against anchorHash with DefaultLimits and derives the deployment's lease view.
func Verify(fx Fixture, anchorHash common.Hash) (*View, error) {
	return VerifyWithLimits(fx, anchorHash, DefaultLimits)
}

// VerifyWithLimits is Verify with explicit input bounds, all checked before any header or receipt is parsed.
func VerifyWithLimits(fx Fixture, anchorHash common.Hash, lim Limits) (*View, error) {
	if fx.AnchorBlock < fx.EventBlock || fx.AnchorBlock-fx.EventBlock >= lim.MaxWindow {
		return nil, errors.New("window out of range")
	}
	if want := fx.AnchorBlock - fx.EventBlock + 1; uint64(len(fx.Headers)) != want {
		return nil, fmt.Errorf("need exactly the %d headers %d..%d, got %d", want, fx.EventBlock, fx.AnchorBlock, len(fx.Headers))
	}
	if len(fx.Receipts) > len(fx.Headers) {
		return nil, fmt.Errorf("%d receipt lists for %d headers", len(fx.Receipts), len(fx.Headers))
	}
	var total int64
	for _, raw := range fx.Headers {
		if len(raw) > lim.MaxHeaderBytes {
			return nil, fmt.Errorf("a header of %d bytes exceeds %d", len(raw), lim.MaxHeaderBytes)
		}
		total += int64(len(raw))
	}
	for _, raw := range fx.Receipts {
		total += int64(len(raw))
	}
	if total > lim.MaxTotalBytes {
		return nil, fmt.Errorf("inputs of %d bytes exceed %d", total, lim.MaxTotalBytes)
	}
	hs := make([]header, 0, len(fx.Headers))
	for _, raw := range fx.Headers {
		hd, err := parseHeader(raw)
		if err != nil {
			return nil, err
		}
		hs = append(hs, hd)
	}
	sort.Slice(hs, func(i, j int) bool { return hs[i].h.Number.Cmp(hs[j].h.Number) < 0 })
	want := int(fx.AnchorBlock - fx.EventBlock + 1)
	if len(hs) != want || hs[0].h.Number.Uint64() != fx.EventBlock {
		return nil, fmt.Errorf("need exactly the %d headers %d..%d, got %d", want, fx.EventBlock, fx.AnchorBlock, len(hs))
	}
	for i := 1; i < len(hs); i++ {
		if hs[i].h.Number.Uint64() != hs[i-1].h.Number.Uint64()+1 {
			return nil, fmt.Errorf("headers are not contiguous at %d", hs[i].h.Number)
		}
		if hs[i].h.ParentHash != hs[i-1].hash {
			return nil, fmt.Errorf("block %d does not link to block %d (fork or tampering)", hs[i].h.Number, hs[i-1].h.Number)
		}
	}
	top := hs[len(hs)-1]
	if top.hash != anchorHash {
		return nil, fmt.Errorf("block %d hash %s is not the anchor %s", top.h.Number, top.hash, anchorHash)
	}

	v := &View{DeploymentID: fx.DeploymentID, AnchorBlock: fx.AnchorBlock, AnchorHash: anchorHash,
		AnchorTimestamp: top.h.Time, BlocksChecked: len(hs)}
	type leaseLog struct {
		ev  Event
		log *types.Log
	}
	var leaseLogs []leaseLog
	for i, hd := range hs {
		n := hd.h.Number.Uint64()
		raw, have := fx.Receipts[strconv.FormatUint(n, 10)]
		mayHold := types.BloomLookup(hd.h.Bloom, fx.Ledger) && types.BloomLookup(hd.h.Bloom, fx.DeploymentID)
		if i == 0 && !mayHold {
			return nil, fmt.Errorf("event block %d's bloom does not admit the deployment's ledger logs", n)
		}
		if !mayHold {
			v.BloomNegative++
			continue
		}
		if !have {
			return nil, fmt.Errorf("block %d's bloom admits the deployment but its receipts were not supplied", n)
		}
		rs, err := receiptsFor(raw, hd, lim)
		if err != nil {
			return nil, err
		}
		v.ReceiptVerified++
		v.ReceiptsVerified += len(rs)
		li := 0
		for ri, r := range rs {
			for _, lg := range r.Logs {
				if lg.Address == fx.Ledger && len(lg.Topics) >= 2 && lg.Topics[1] == fx.DeploymentID {
					ev := Event{Block: n, BlockHash: hd.hash, ReceiptIndex: ri, LogIndex: li, Topic0: lg.Topics[0]}
					switch lg.Topics[0] {
					case topicClaimed:
						ev.Kind = "Claimed"
					case topicRenewed:
						ev.Kind = "Renewed"
					case topicReleased:
						ev.Kind = "Released"
					case topicSharesSet:
						ev.Kind = "SharesSet"
					default:
						ev.Kind = "other"
					}
					if r.Status != types.ReceiptStatusSuccessful {
						return nil, fmt.Errorf("log in a failed receipt at block %d", n) // impossible in a valid block
					}
					if ev.Kind != "other" {
						leaseLogs = append(leaseLogs, leaseLog{ev, lg})
					} else {
						v.OtherEvents++
					}
				}
				li++
			}
		}
	}
	if len(leaseLogs) == 0 || leaseLogs[0].ev.Block != fx.EventBlock {
		return nil, fmt.Errorf("no verified lease event in the event block %d", fx.EventBlock)
	}
	// Apply in consensus order. Only Claimed/Renewed/Released set the lease fields from event data; a SharesSet while
	// leased recomputes leaseUntil inside the contract with no event carrying it (ledger :848-875).
	v.Caveats = []string{
		"anchor canonicality is an input (sequencer-signed gossip head or L1-finalized output root), not proven here",
		"retire() writes `retired` with no event (ledger :1733-1736): claim/renew/fund refusal is not covered by this view",
	}
	for _, ll := range leaseLogs {
		lg := ll.log
		switch ll.ev.Kind {
		case "Claimed":
			until, err := u64word(lg.Data, 0)
			if err != nil || len(lg.Topics) < 4 {
				return nil, fmt.Errorf("malformed Claimed at block %d", ll.ev.Block)
			}
			op := common.BytesToAddress(lg.Topics[3].Bytes())
			v.Runner, v.RunnerOperator, v.LeaseUntil = lg.Topics[2], &op, &until
		case "Renewed":
			until, err := u64word(lg.Data, 0)
			if err != nil || len(lg.Topics) < 3 {
				return nil, fmt.Errorf("malformed Renewed at block %d", ll.ev.Block)
			}
			v.Runner, v.LeaseUntil = lg.Topics[2], &until // renew keeps the operator: only a Claimed names it
		case "Released":
			zero := uint64(0)
			v.Runner, v.RunnerOperator, v.LeaseUntil = common.Hash{}, &common.Address{}, &zero
		case "SharesSet":
			if v.LeaseUntil != nil && *v.LeaseUntil > hs[ll.ev.Block-fx.EventBlock].h.Time {
				v.LeaseUntil = nil
				v.Caveats = append(v.Caveats, fmt.Sprintf("SharesSet at block %d rewrote leaseUntil without an event: unknown", ll.ev.Block))
			}
		}
		v.LastLeaseEvent = ll.ev
	}
	if v.RunnerOperator == nil {
		v.Caveats = append(v.Caveats, "runnerOperator is named only by Claimed, which precedes this window: not determined")
	}
	if v.LeaseUntil != nil {
		leased := *v.LeaseUntil > v.AnchorTimestamp
		v.Leased = &leased
	}
	return v, nil
}

// ReadFixtureFile reads a fixture (".gz" is decompressed) and refuses one whose file or decompressed size exceeds
// max bytes, reading at most max+1 bytes of either.
func ReadFixtureFile(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var rd io.Reader = io.LimitReader(f, max+1)
	if strings.HasSuffix(path, ".gz") {
		z, err := gzip.NewReader(rd)
		if err != nil {
			return nil, err
		}
		defer z.Close()
		rd = z
	}
	raw, err := io.ReadAll(io.LimitReader(rd, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > max {
		return nil, fmt.Errorf("fixture exceeds %d bytes", max)
	}
	return raw, nil
}
