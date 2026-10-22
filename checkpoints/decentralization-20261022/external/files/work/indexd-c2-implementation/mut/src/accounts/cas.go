package accounts

// G-C2 (work/indexd-c2-implementation-interface.txt): per-account conditional head (CAS) with an operation digest
// that binds the exact mutation, and a durable, sticky enrolment ("cas" mode).

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
)

const (
	// RequestHashDomainV4 is the domain of the v4 signed request hash.
	RequestHashDomainV4 = "indexd/fence/v4"
	// OpDigestDomain is the domain of the server-computed operation digest.
	OpDigestDomain = "indexd/fence/v4/op"
	// ModeCAS is the enrolment mode that makes v4 mandatory for an account.
	ModeCAS = "cas"
	// CASFlagSeq is flags bit 0: the request carries an expected head sq.
	CASFlagSeq = 1
)

// ErrCASSeqRequired is returned for a head-advancing mutation sent in v4 form without an expected head.
var ErrCASSeqRequired = errors.New("this mutation advances the account head: the v4 form requires sq")

// An OpID is the writer-chosen operation id of a v4 request (16 bytes).
type OpID [16]byte

// An OpDigest binds the exact operation: method, host, path, body, credential, flags, sq and op (not the expiry).
type OpDigest [32]byte

// A CASRequest is the v4 part of an authenticated fenced request. Result is filled in by the store when the request
// succeeds (the new head, and whether this was an identical replay that was not applied again).
type CASRequest struct {
	HasSq  bool
	Sq     uint64
	Op     OpID
	Digest OpDigest
	Result struct {
		Seq      uint64
		Replayed bool
	}
}

// Flags returns the request's flags word.
func (c *CASRequest) Flags() uint64 {
	if c.HasSq {
		return CASFlagSeq
	}
	return 0
}

// String forms (lowercase hex).
func (o OpID) String() string     { return hex.EncodeToString(o[:]) }
func (d OpDigest) String() string { return hex.EncodeToString(d[:]) }

// MarshalText implements encoding.TextMarshaler.
func (o OpID) MarshalText() ([]byte, error) { return []byte(o.String()), nil }

// MarshalText implements encoding.TextMarshaler.
func (d OpDigest) MarshalText() ([]byte, error) { return []byte(d.String()), nil }

// UnmarshalText implements encoding.TextUnmarshaler (exactly 32 lowercase hex characters).
func (o *OpID) UnmarshalText(b []byte) error {
	p, err := ParseOpID(string(b))
	*o = p
	return err
}

// UnmarshalText implements encoding.TextUnmarshaler (exactly 64 lowercase hex characters).
func (d *OpDigest) UnmarshalText(b []byte) error {
	if len(b) != 64 || !isLowerHex(string(b)) {
		return ErrNonCanonicalFence
	}
	_, err := hex.Decode(d[:], b)
	return err
}

// ParseOpID parses exactly 32 lowercase hex characters.
func ParseOpID(s string) (OpID, error) {
	var o OpID
	if len(s) != 32 || !isLowerHex(s) {
		return o, errors.New("op must be exactly 32 lowercase hex characters")
	}
	_, err := hex.Decode(o[:], []byte(s))
	return o, err
}

// ParseSeq parses a canonical decimal u64 below 2^63: no sign, no leading zeros ("0" is allowed).
func ParseSeq(s string) (uint64, error) {
	if s == "" || len(s) > 19 || (len(s) > 1 && s[0] == '0') {
		return 0, errors.New("sq must be a canonical decimal integer")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, errors.New("sq must be a canonical decimal integer")
		}
	}
	n, err := strconv.ParseUint(s, 10, 63)
	if err != nil {
		return 0, errors.New("sq must be below 2^63")
	}
	return n, nil
}

// A CASConflictError is a G-C2 refusal (HTTP 412). Nothing was applied.
//
//	Kind "seq":  the account head is not the expected one (Seq: the actual head; nil when the sequence is not enabled)
//	Kind "op":   the head is sq+1 and the last operation has this op id, but a DIFFERENT digest (altered replay)
//	Kind "mode": the account is enrolled in "cas" mode and the request (or raise) is not v4/cas
type CASConflictError struct {
	Kind    string
	Seq     *uint64
	Mode    string
	Current *Fence
}

func (e *CASConflictError) Error() string {
	switch e.Kind {
	case "seq":
		if e.Seq == nil {
			return "conditional head: the account sequence is not enabled"
		}
		return fmt.Sprintf("conditional head: the account head is %d", *e.Seq)
	case "op":
		return "conditional head: this operation id was already used for a different operation"
	default:
		return fmt.Sprintf("the account is enrolled in %q mode: this request form is refused", e.Mode)
	}
}
