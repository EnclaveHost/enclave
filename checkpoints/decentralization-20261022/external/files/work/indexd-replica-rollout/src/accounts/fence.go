package accounts

// FENCING PATCH (work/indexd-fencing-implementation-interface.txt): writer fences (ballots) per account.

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
)

// A Fence is a writer's ballot: gen u64 big-endian || counter u64 big-endian || iid 16 bytes. Fences are ordered
// bytewise, which is lexicographic (gen, counter, iid) and PostgreSQL's bytea order.
type Fence [32]byte

var (
	// ErrSeqNotEnabled is returned by the sequence listing of an account that never installed a fence.
	ErrSeqNotEnabled = errors.New("the account's object sequence is not enabled: install a fence first")
	// ErrNonCanonicalFence is returned for a fence that is not exactly 64 lowercase hex characters, or whose gen or
	// counter has its top bit set.
	ErrNonCanonicalFence = errors.New("non-canonical fence")
)

// A FencedError refuses a mutation or a raise. Current is the account's installed fence (nil: none installed).
type FencedError struct {
	Current *Fence
}

func (e *FencedError) Error() string {
	if e.Current == nil {
		return "account has no fence installed"
	}
	return fmt.Sprintf("account is fenced by %x", e.Current[:])
}

// ParseFence parses the canonical text form: exactly 64 lowercase hex characters, top bits of gen and counter clear.
func ParseFence(s string) (Fence, error) {
	var f Fence
	if len(s) != 64 || !isLowerHex(s) {
		return f, ErrNonCanonicalFence
	}
	if _, err := hex.Decode(f[:], []byte(s)); err != nil {
		return f, ErrNonCanonicalFence
	}
	return f, f.Validate()
}

// Validate checks the bounds of a decoded fence: gen < 2^63 and counter < 2^63.
func (f Fence) Validate() error {
	if f[0]&0x80 != 0 || f[8]&0x80 != 0 {
		return ErrNonCanonicalFence
	}
	return nil
}

// String returns the canonical text form.
func (f Fence) String() string {
	return hex.EncodeToString(f[:])
}

// Compare orders fences bytewise.
func (f Fence) Compare(g Fence) int {
	return bytes.Compare(f[:], g[:])
}

// MarshalText implements encoding.TextMarshaler (canonical form).
func (f Fence) MarshalText() ([]byte, error) {
	return []byte(f.String()), nil
}

// UnmarshalText implements encoding.TextUnmarshaler (canonical form only).
func (f *Fence) UnmarshalText(b []byte) error {
	p, err := ParseFence(string(b))
	if err != nil {
		return err
	}
	*f = p
	return nil
}

// A Receipt is issued by indexd (crypto/rand) each time it installs a fence; the client never chooses it.
type Receipt [16]byte

// A Credential is what a fenced mutation presents in sf: the installed fence and the receipt issued for it. Holding
// only the (predictable, possibly cloned) fence is not enough to write.
type Credential struct {
	Fence   Fence
	Receipt Receipt
}

// Bytes returns fence || receipt (48 bytes), as covered by the request signature.
func (c Credential) Bytes() (b [48]byte) {
	copy(b[:32], c.Fence[:])
	copy(b[32:], c.Receipt[:])
	return
}

// String returns the canonical text form: 96 lowercase hex characters.
func (c Credential) String() string {
	b := c.Bytes()
	return hex.EncodeToString(b[:])
}

// ParseCredential parses the canonical text form of a credential: exactly 96 lowercase hex characters whose fence
// is canonical.
func ParseCredential(s string) (Credential, error) {
	var c Credential
	if len(s) != 96 || !isLowerHex(s) {
		return c, ErrNonCanonicalFence
	}
	f, err := ParseFence(s[:64])
	if err != nil {
		return c, err
	}
	c.Fence = f
	if _, err := hex.Decode(c.Receipt[:], []byte(s[64:])); err != nil {
		return c, ErrNonCanonicalFence
	}
	return c, nil
}

func isLowerHex(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// A ReceiptDigest is the SHA-256 of an installed receipt: what GET /fence reveals, so a writer can confirm its
// fence is still installed without the receipt itself ever being returned after the raise.
type ReceiptDigest [32]byte

// MarshalText implements encoding.TextMarshaler (64 lowercase hex characters).
func (d ReceiptDigest) MarshalText() ([]byte, error) {
	return []byte(hex.EncodeToString(d[:])), nil
}

// UnmarshalText implements encoding.TextUnmarshaler (64 lowercase hex characters).
func (d *ReceiptDigest) UnmarshalText(b []byte) error {
	if len(b) != 64 || !isLowerHex(string(b)) {
		return ErrNonCanonicalFence
	}
	_, err := hex.Decode(d[:], b)
	return err
}

// MarshalText implements encoding.TextMarshaler (32 lowercase hex characters).
func (r Receipt) MarshalText() ([]byte, error) {
	return []byte(hex.EncodeToString(r[:])), nil
}

// UnmarshalText implements encoding.TextUnmarshaler (32 lowercase hex characters).
func (r *Receipt) UnmarshalText(b []byte) error {
	if len(b) != 32 || !isLowerHex(string(b)) {
		return ErrNonCanonicalFence
	}
	_, err := hex.Decode(r[:], b)
	return err
}

// FenceState is an account's installed fence (nil: none), the digest of its receipt and its event sequence head.
type FenceState struct {
	Fence         *Fence         `json:"fence"`
	ReceiptSHA256 *ReceiptDigest `json:"receiptSha256"`
	Seq           uint64         `json:"seq"`
}
