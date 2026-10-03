// Package revenueshare splits confirmed native NKN TUNA receipts without
// changing upstream payment negotiation or charging the client a second time.
package revenueshare

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math"

	"github.com/golang/protobuf/proto"
	"github.com/nknorg/nkn/v2/pb"
)

type Receipt struct {
	TxType      string `json:"txType"`
	PayloadData string `json:"payloadData"`
	Hash        string `json:"hash"`
}
type Pending struct {
	Recipient string `json:"recipient"`
	Amount    int64  `json:"amount"`
	Fee       int64  `json:"fee"`
	Hash      string `json:"hash"`
	Raw       string `json:"raw"`
	Provider  int64  `json:"provider"`
	Platform  int64  `json:"platform"`
}
type State struct {
	ConfigHash   string           `json:"configHash"`
	Height       uint32           `json:"height"`
	BlockHash    string           `json:"blockHash"`
	Channels     map[string]int64 `json:"channels"`
	Gross        int64            `json:"gross"`
	ProviderPaid int64            `json:"providerPaid"`
	PlatformPaid int64            `json:"platformPaid"`
	FeesPaid     int64            `json:"feesPaid"`
	Pending      []Pending        `json:"pending"`
}

// Split uses quotient/remainder arithmetic: no overflow at Fixed64's maximum,
// and rounding once on the cumulative total is independent of receipt size.
func Split(gross int64, providerBps uint16) (provider, platform int64, err error) {
	if gross < 0 || providerBps > 10000 {
		return 0, 0, errors.New("invalid revenue or share")
	}
	provider = (gross/10000)*int64(providerBps) + (gross%10000)*int64(providerBps)/10000
	return provider, gross - provider, nil
}
func (s *State) Apply(receipts []Receipt, recipient []byte) error {
	// Build all changes first. A damaged receipt cannot partially advance a block.
	next := make(map[string]int64, len(s.Channels))
	for k, v := range s.Channels {
		next[k] = v
	}
	gross := s.Gross
	for _, r := range receipts {
		if r.TxType != "NANO_PAY_TYPE" {
			continue
		}
		raw, err := hex.DecodeString(r.PayloadData)
		if err != nil {
			return err
		}
		var p pb.NanoPay
		if err = proto.Unmarshal(raw, &p); err != nil {
			return err
		}
		if hex.EncodeToString(p.Recipient) != hex.EncodeToString(recipient) {
			continue
		}
		if len(p.Sender) != 20 || len(p.Recipient) != 20 || p.Amount < 0 {
			return errors.New("invalid nanopay receipt")
		}
		key := fmt.Sprintf("%x:%x:%d", p.Sender, p.Recipient, p.Id)
		old := next[key]
		if p.Amount < old {
			return errors.New("nanopay channel regressed")
		}
		delta := p.Amount - old
		if gross > math.MaxInt64-delta {
			return errors.New("revenue overflow")
		}
		gross += delta
		next[key] = p.Amount
	}
	s.Channels = next
	s.Gross = gross
	return nil
}

// Plan keeps the provider's gross share intact. Native transaction fees come
// from the platform share. Small amounts wait until both transfers are funded.
func (s *State) Plan(providerAddress, platformAddress string, bps uint16, fee, minimum int64) ([]Pending, error) {
	if len(s.Pending) > 0 {
		return nil, errors.New("reconcile persisted transfers before planning")
	}
	if fee < 0 || fee > math.MaxInt64/2 || minimum < 1 {
		return nil, errors.New("invalid fee or minimum")
	}
	provider, platform, err := Split(s.Gross, bps)
	if err != nil {
		return nil, err
	}
	if s.ProviderPaid < 0 || s.PlatformPaid < 0 || s.FeesPaid < 0 || s.ProviderPaid > provider || s.PlatformPaid > platform || s.FeesPaid > platform-s.PlatformPaid {
		return nil, errors.New("invalid cumulative payout state")
	}
	if bps == 10000 && fee > 0 {
		return nil, errors.New("100% provider share requires a separate native fee payer")
	}
	provider -= s.ProviderPaid
	platform -= s.PlatformPaid + s.FeesPaid
	if provider < 0 || platform < 0 {
		return nil, errors.New("share accounting regressed")
	}
	if provider+platform < minimum {
		return nil, nil
	}
	if providerAddress == platformAddress {
		if platform < fee || provider+platform <= fee {
			return nil, nil
		}
		return []Pending{{Recipient: providerAddress, Amount: provider + platform - fee, Fee: fee, Provider: provider, Platform: platform - fee}}, nil
	}
	transfers := int64(1)
	if provider > 0 {
		transfers++
	}
	if platform <= transfers*fee {
		return nil, nil
	}
	result := []Pending{}
	if provider > 0 {
		result = append(result, Pending{Recipient: providerAddress, Amount: provider, Fee: fee, Provider: provider})
	}
	result = append(result, Pending{Recipient: platformAddress, Amount: platform - transfers*fee, Fee: fee, Platform: platform - transfers*fee})
	return result, nil
}
func (s *State) ConfirmFirst(hash string) error {
	if len(s.Pending) == 0 || s.Pending[0].Hash != hash {
		return errors.New("unexpected confirmed transaction")
	}
	p := s.Pending[0]
	if p.Provider < 0 || p.Platform < 0 || p.Fee < 0 || p.Provider > math.MaxInt64-p.Platform || p.Amount != p.Provider+p.Platform || s.ProviderPaid > math.MaxInt64-p.Provider || s.PlatformPaid > math.MaxInt64-p.Platform || s.FeesPaid > math.MaxInt64-p.Fee {
		return errors.New("invalid confirmed payout")
	}
	s.ProviderPaid += p.Provider
	s.PlatformPaid += p.Platform
	s.FeesPaid += p.Fee
	s.Pending = s.Pending[1:]
	return nil
}

// Validate a recovered journal before any signing or broadcasting. Funding
// transfers are deliberately absent from Channels and cannot become revenue.
func (s *State) Validate(providerAddress, platformAddress string, bps uint16) error {
	var total int64
	for _, amount := range s.Channels {
		if amount < 0 || total > math.MaxInt64-amount {
			return errors.New("corrupt receipt totals")
		}
		total += amount
	}
	if total != s.Gross {
		return errors.New("receipt totals do not match gross revenue")
	}
	provider, platform, err := Split(s.Gross, bps)
	if err != nil {
		return err
	}
	if s.ProviderPaid < 0 || s.PlatformPaid < 0 || s.FeesPaid < 0 || s.ProviderPaid > provider || s.PlatformPaid > platform || s.FeesPaid > platform-s.PlatformPaid {
		return errors.New("corrupt paid shares")
	}
	provider -= s.ProviderPaid
	platform -= s.PlatformPaid + s.FeesPaid
	for _, p := range s.Pending {
		if p.Amount <= 0 || p.Fee < 0 || p.Provider < 0 || p.Platform < 0 || p.Provider > p.Amount || p.Platform != p.Amount-p.Provider || p.Provider > provider || p.Platform > platform || p.Fee > platform-p.Platform {
			return errors.New("unbacked pending payout")
		}
		if (p.Provider > 0 && p.Recipient != providerAddress) || (p.Platform > 0 && p.Recipient != platformAddress) {
			return errors.New("pending payout recipient changed")
		}
		provider -= p.Provider
		platform -= p.Platform + p.Fee
	}
	return nil
}
