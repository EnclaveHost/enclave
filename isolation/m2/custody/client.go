package custody

// The release, as the measured front runs it (custody/recipient.mjs is the reference):
//
//  1. a fresh challenge from every member of the bundle's committee epoch, each answered under the member's own key;
//  2. a fresh recipient key, generated here and never exported, and the binding over the deployment, its revisions, the
//     challenges, this runtime, this transport key and that recipient key;
//  3. hardware evidence whose report_data is binding ‖ AppID (the front writes the AppID; this package never does);
//  4. the lease holder's operator signs the release (the host's part: it proves the lease, never sees a secret);
//  5. each challenged custodian is asked for its share; each answer opens only under the recipient key and this binding;
//  6. a threshold of shares combine to the data key, which must open the bundle (AES-GCM): a share from a lying custodian
//     makes a combination fail to open, and another combination of the received shares is tried. No liar can make the
//     guest accept a value the owner did not encrypt. Surviving liars is bounded by the search: every combination of t of
//     the m shares received is tried up to MaxSubsets (65536), which covers any number of liars for C(m, t) <= 65536 (any
//     committee of up to 17 members); a larger committee with a liar among the lowest indices may exhaust it and fail
//     closed. (The guest cannot check a share against the Feldman commitments: Go's standard library has no secp256k1.)
//
// What the guest does NOT verify here: which committee is the deployment's. The State arrives inside the relay's signed
// release (release.Release.Custody), so a host cannot substitute one, but the relay could: that would make the app start
// with values the relay chose (as it can already choose the config), never reveal the owner's real ones.

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"sync"
)

// Member is one custodian of the bundle's epoch, in committee order (its index is its Shamir x - 1).
type Member struct {
	EncKey   [32]byte
	Endpoint string
}

// State is what a release needs to know about the deployment's custody.
type State struct {
	Ctx        Context
	ID         [32]byte
	PolicyRev  uint64
	SecretRev  uint64
	Epoch      uint32
	Threshold  int
	Members    []Member
	C0         []byte // the bundle's constant commitment (33 bytes)
	Ciphertext []byte
}

// Client runs one release. Post is the transport (TLS through the guest's egress), Evidence asks the hardware for a
// report over a binding, Authorize asks the host's operator to sign the release.
type Client struct {
	Post          func(ctx context.Context, url string, body, out any) error
	Evidence      func(binding [32]byte) (json.RawMessage, error)
	Authorize     func(ctx context.Context, id, binding [32]byte) (endpoint, sig string, expiry int64, err error)
	RuntimeID     [32]byte
	TransportSPKI []byte
	MaxSubsets    int // combinations tried before giving up; 0 = 65536 (each costs one Lagrange, one HKDF and one AES-GCM open)
	Logf          func(string, ...any)
}

type wireChallenge struct {
	EncKey string `json:"encKey"`
	Nonce  string `json:"nonce"`
}
type wireOperator struct {
	Sig    string `json:"sig"`
	Expiry int64  `json:"expiry"`
}
type wireRelease struct {
	V            int             `json:"v"`
	ID           string          `json:"id"`
	Endpoint     string          `json:"endpoint"`
	PolicyRev    string          `json:"policyRev"`
	SecretRev    string          `json:"secretRev"`
	Epoch        uint32          `json:"epoch"`
	Challenges   []wireChallenge `json:"challenges"`
	RecipientKey string          `json:"recipientKey"`
	Evidence     json.RawMessage `json:"evidence"`
	Operator     wireOperator    `json:"operator"`
}
type wireShare struct {
	V      int    `json:"v"`
	EncKey string `json:"encKey"`
	Index  int    `json:"index"`
	Sealed string `json:"sealed"`
}

// ErrQuorum is returned (wrapped) when fewer than the threshold of custodians answered.
var ErrQuorum = errors.New("insufficient custodian quorum")

func (s *State) check() error {
	if s.Threshold < 1 || len(s.Members) < s.Threshold || len(s.Members) > MaxMembers {
		return fmt.Errorf("committee of %d with threshold %d", len(s.Members), s.Threshold)
	}
	if len(s.C0) != PointBytes || len(s.Ciphertext) < 28 || s.PolicyRev == 0 || s.SecretRev == 0 || s.Epoch == 0 {
		return errors.New("the custody state is incomplete")
	}
	return nil
}

func (c *Client) logf(f string, a ...any) {
	if c.Logf != nil {
		c.Logf(f, a...)
	}
}

// Obtain returns the deployment's opened bundle (its env map and the config it is committed to), or an error naming why
// not. The recipient key lives only in this call. The CALLER must refuse to substitute the values into any config whose
// sha256 is not Bundle.ConfigSha256.
func (c *Client) Obtain(ctx context.Context, st State) (*Bundle, error) {
	if err := st.check(); err != nil {
		return nil, err
	}
	type got struct {
		idx int
		ch  Challenge
	}
	// 1. challenges
	var mu sync.Mutex
	var chs []got
	var wg sync.WaitGroup
	for i, m := range st.Members {
		wg.Add(1)
		go func(i int, m Member) {
			defer wg.Done()
			var r wireChallenge
			if err := c.Post(ctx, m.Endpoint+"/v1/custody/challenge", struct{}{}, &r); err != nil {
				c.logf("DOM custody: member %d gave no challenge: %v", i, err)
				return
			}
			if r.EncKey != hex.EncodeToString(m.EncKey[:]) {
				c.logf("DOM custody: member %d answered under another key", i)
				return
			}
			n, err := hex.DecodeString(r.Nonce)
			if err != nil || len(n) != 32 {
				return
			}
			var ch Challenge
			ch.EncKey = m.EncKey
			copy(ch.Nonce[:], n)
			mu.Lock()
			chs = append(chs, got{i, ch})
			mu.Unlock()
		}(i, m)
	}
	wg.Wait()
	if len(chs) < st.Threshold {
		return nil, fmt.Errorf("%w: %d of %d custodians issued a challenge (need %d)", ErrQuorum, len(chs), len(st.Members), st.Threshold)
	}
	challenges := make([]Challenge, len(chs))
	for i, g := range chs {
		challenges[i] = g.ch
	}
	// 2. recipient key and binding
	sk, err := NewRecipientKey()
	if err != nil {
		return nil, err
	}
	var rk [32]byte
	copy(rk[:], sk.PublicKey().Bytes())
	binding, err := Binding(BindingInput{Ctx: st.Ctx, ID: st.ID, PolicyRev: st.PolicyRev, SecretRev: st.SecretRev, Epoch: st.Epoch,
		Challenges: challenges, RuntimeID: c.RuntimeID, TransportSPKI: c.TransportSPKI, RecipientKey: rk})
	if err != nil {
		return nil, err
	}
	// 3. evidence, 4. the operator's authorization
	ev, err := c.Evidence(binding)
	if err != nil {
		return nil, fmt.Errorf("the custody report: %w", err)
	}
	endpoint, sig, expiry, err := c.Authorize(ctx, st.ID, binding)
	if err != nil {
		return nil, fmt.Errorf("the operator's authorization: %w", err)
	}
	req := wireRelease{V: 1, ID: "0x" + hex.EncodeToString(st.ID[:]), Endpoint: endpoint, PolicyRev: strconv.FormatUint(st.PolicyRev, 10),
		SecretRev: strconv.FormatUint(st.SecretRev, 10), Epoch: st.Epoch, RecipientKey: hex.EncodeToString(rk[:]), Evidence: ev,
		Operator: wireOperator{Sig: sig, Expiry: expiry}}
	for _, ch := range challenges {
		req.Challenges = append(req.Challenges, wireChallenge{EncKey: hex.EncodeToString(ch.EncKey[:]), Nonce: hex.EncodeToString(ch.Nonce[:])})
	}
	// 5. shares
	var shares []share
	for _, g := range chs {
		wg.Add(1)
		go func(g got) {
			defer wg.Done()
			var r wireShare
			if err := c.Post(ctx, st.Members[g.idx].Endpoint+"/v1/custody/release", req, &r); err != nil {
				c.logf("DOM custody: member %d released nothing: %v", g.idx, err)
				return
			}
			if r.EncKey != hex.EncodeToString(g.ch.EncKey[:]) || r.Index != g.idx {
				c.logf("DOM custody: member %d answered for another key or index", g.idx)
				return
			}
			blob, err := base64.StdEncoding.DecodeString(r.Sealed)
			if err != nil || len(blob) != SealedShareBytes {
				return
			}
			y, err := openShare(sk, binding, g.ch.EncKey, g.idx, blob)
			if err != nil {
				c.logf("DOM custody: member %d's share does not open under this release", g.idx)
				return
			}
			mu.Lock()
			shares = append(shares, share{x: int64(g.idx + 1), y: y})
			mu.Unlock()
		}(g)
	}
	wg.Wait()
	if len(shares) < st.Threshold {
		return nil, fmt.Errorf("%w: %d custodians released a share (need %d)", ErrQuorum, len(shares), st.Threshold)
	}
	// 6. combine and open
	aad, err := BundleAAD(st.Ctx, st.ID, st.SecretRev, st.C0)
	if err != nil {
		return nil, err
	}
	max := c.MaxSubsets
	if max <= 0 {
		max = 65536
	}
	env, tried, err := recoverEnv(shares, st.Threshold, max, func(s *big.Int) (*Bundle, error) {
		dek, err := DeriveDEK(s, st.Ctx, st.ID, st.SecretRev)
		if err != nil {
			return nil, err
		}
		defer clear(dek)
		return DecryptBundle(dek, aad, st.Ciphertext)
	})
	if err != nil {
		return nil, fmt.Errorf("no combination of %d shares opened the bundle (%d tried): %w", len(shares), tried, err)
	}
	if tried > 1 {
		c.logf("DOM custody: %d share combination(s) failed before one opened the bundle: a custodian returned a bad share", tried-1)
	}
	return env, nil
}

func openShare(sk *ecdh.PrivateKey, binding, encKey [32]byte, index int, sealed []byte) (*big.Int, error) {
	pt, err := Open(sk, []byte(infoRelease), responseAAD(binding, encKey, index), sealed)
	if err != nil {
		return nil, err
	}
	return scalar(pt)
}
