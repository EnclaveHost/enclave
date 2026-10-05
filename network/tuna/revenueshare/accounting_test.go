package revenueshare

import (
	"encoding/hex"
	"github.com/golang/protobuf/proto"
	"github.com/nknorg/nkn/v2/pb"
	"math"
	"testing"
)

func receipt(recipient []byte, amount int64) Receipt {
	p, _ := proto.Marshal(&pb.NanoPay{Sender: make([]byte, 20), Recipient: recipient, Id: 1, Amount: amount})
	return Receipt{TxType: "NANO_PAY_TYPE", PayloadData: hex.EncodeToString(p)}
}
func TestCumulativeAndReplay(t *testing.T) {
	r := make([]byte, 20)
	s := State{}
	for _, n := range []int64{1, 2, 2, 7, 100} {
		if e := s.Apply([]Receipt{receipt(r, n)}, r); e != nil {
			t.Fatal(e)
		}
	}
	if s.Gross != 100 {
		t.Fatal(s.Gross)
	}
	if e := s.Apply([]Receipt{receipt(r, 99)}, r); e == nil {
		t.Fatal("accepted regression")
	}
	if s.Gross != 100 {
		t.Fatal("changed on failure")
	}
	p, f, e := Split(s.Gross, 8000)
	if e != nil || p != 80 || f != 20 {
		t.Fatal(p, f, e)
	}
}
func TestFeesAndRecovery(t *testing.T) {
	s := State{Gross: 100000000}
	plan, e := s.Plan("provider", "platform", 8000, 100000, 1000000)
	if e != nil || len(plan) != 2 || plan[0].Amount != 80000000 || plan[1].Amount != 19800000 {
		t.Fatal(plan, e)
	}
	plan[0].Hash = "first"
	plan[1].Hash = "second"
	s.Pending = plan
	if _, e = s.Plan("provider", "platform", 8000, 100000, 1); e == nil {
		t.Fatal("planned twice")
	}
	if e = s.ConfirmFirst("second"); e == nil {
		t.Fatal("out of order")
	}
	if e = s.ConfirmFirst("first"); e != nil {
		t.Fatal(e)
	}
	if e = s.ConfirmFirst("second"); e != nil {
		t.Fatal(e)
	}
	if s.ProviderPaid+s.PlatformPaid+s.FeesPaid != s.Gross {
		t.Fatal("not conserved")
	}
	if p, e := s.Plan("provider", "platform", 8000, 100000, 1); e != nil || len(p) != 0 {
		t.Fatal(p, e)
	}
}
func TestLimitsAndCombinedDestination(t *testing.T) {
	for _, bps := range []uint16{0, 1, 5000, 8000, 10000} {
		p, f, e := Split(math.MaxInt64, bps)
		if e != nil || p+f != math.MaxInt64 || p < 0 || f < 0 {
			t.Fatal(p, f, e)
		}
	}
	s := State{Gross: 100000000}
	p, e := s.Plan("same", "same", 8000, 100000, 1)
	if e != nil || len(p) != 1 || p[0].Amount != 99900000 || p[0].Provider != 80000000 {
		t.Fatal(p, e)
	}
	s.Gross = 1
	p, e = s.Plan("a", "b", 8000, 100000, 1)
	if e != nil || len(p) != 0 {
		t.Fatal(p, e)
	}
}
func TestIgnoreFundingAndForeignReceipts(t *testing.T) {
	r := make([]byte, 20)
	foreign := make([]byte, 20)
	foreign[0] = 1
	s := State{}
	if e := s.Apply([]Receipt{{TxType: "TRANSFER_ASSET_TYPE", PayloadData: "not parsed"}, receipt(foreign, 1000)}, r); e != nil || s.Gross != 0 {
		t.Fatal(s, e)
	}
}

func TestRejectCorruptJournalAndUnfundedFees(t *testing.T) {
	s := State{Gross: 100, Channels: map[string]int64{"a": 100}}
	if e := s.Validate("provider", "platform", 8000); e != nil {
		t.Fatal(e)
	}
	s.Gross = 101
	if e := s.Validate("provider", "platform", 8000); e == nil {
		t.Fatal("accepted invented revenue")
	}
	s.Gross = 100
	s.Pending = []Pending{{Recipient: "attacker", Amount: 80, Provider: 80, Fee: 1}}
	if e := s.Validate("provider", "platform", 8000); e == nil {
		t.Fatal("accepted redirected revenue")
	}
	s.Pending = nil
	if _, e := s.Plan("provider", "platform", 10000, 1, 1); e == nil {
		t.Fatal("silently withheld a 100% provider share")
	}
	if _, e := s.Plan("provider", "platform", 8000, math.MaxInt64, 1); e == nil {
		t.Fatal("fee overflow")
	}
}
