package release

// Custody: the relay-signed pointer to a deployment's custody state, and the guest <-> guestd line protocol that gets the
// lease holder's operator to authorize one custody release (docs/security/secret-custody.md).
//
// The pointer travels INSIDE the sealed, relay-signed release, so the host cannot substitute a committee or a bundle.
// The relay could (as it can choose the config): that would start the app with values the relay chose, never reveal the
// owner's real ones, which only custodians release and only to this guest's attested key.

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"enclave.host/isolation/m2/custody/seats"
)

// CustodyMember is one custodian of the bundle's committee epoch, in committee order.
type CustodyMember struct {
	EncKey   string `json:"encKey"`   // 64 hex
	Endpoint string `json:"endpoint"` // https://<host>
}

// Custody is the deployment's custody pointer as the relay read it from the vault. A pointer without "v" (or with v 1) is
// v1 (custody/chain.mjs readState: chainId ... ciphertext); "v": 2 is the v2 pointer (docs/security/secret-custody-v2-spec.md
// §4: chainId, vault, committeeId ... machines), checked by V2(). A pointer mixing the two shapes is refused (Version).
type Custody struct {
	V          int             `json:"v,omitempty"`
	ChainID    uint64          `json:"chainId"`
	Vault      string          `json:"vault"`
	PolicyRev  string          `json:"policyRev"`
	SecretRev  string          `json:"secretRev"`
	Epoch      uint32          `json:"epoch"`
	Threshold  int             `json:"threshold,omitempty"`
	Members    []CustodyMember `json:"members,omitempty"`
	C0         string          `json:"c0,omitempty"`         // 66 hex: the bundle's constant commitment
	Ciphertext string          `json:"ciphertext,omitempty"` // base64

	// v2 only
	CommitteeID string           `json:"committeeId,omitempty"` // 0x + 64 hex
	T           int              `json:"t,omitempty"`
	Bundle      string           `json:"bundle,omitempty"`      // hex (0x optional): R ‖ proof ‖ nonce ‖ ct
	Commitments string           `json:"commitments,omitempty"` // hex (0x optional): t x 33 bytes
	Machines    []CustodyMachine `json:"machines,omitempty"`
}

// CustodyMachine is one custodian machine of a v2 committee's epoch, in machine order.
type CustodyMachine struct {
	EncKey   string   `json:"encKey"`   // 64 hex (0x optional)
	Endpoint string   `json:"endpoint"` // https base URL, may carry a path prefix (the front checks it: custodianEndpointV2)
	Enclave  bool     `json:"enclave"`
	Indices  []uint32 `json:"indices"`
}

// Version is the pointer's version, 1 or 2; a pointer that mixes v1 and v2 fields, or names another version, is refused.
func (c *Custody) Version() (int, error) {
	v2Fields := c.CommitteeID != "" || c.T != 0 || c.Bundle != "" || c.Commitments != "" || c.Machines != nil
	v1Fields := c.Threshold != 0 || c.Members != nil || c.C0 != "" || c.Ciphertext != ""
	switch c.V {
	case 0, 1:
		if v2Fields {
			return 0, errors.New("a v1 custody pointer carries v2 fields")
		}
		return 1, nil
	case 2:
		if v1Fields {
			return 0, errors.New("a v2 custody pointer carries v1 fields")
		}
		return 2, nil
	}
	return 0, fmt.Errorf("custody pointer version %d is not known", c.V)
}

// CustodyV2 is a checked v2 pointer.
type CustodyV2 struct {
	ChainID     uint64
	Vault       [20]byte
	CommitteeID [32]byte
	Epoch       uint32
	T           int
	PolicyRev   uint64
	SecretRev   uint64
	Bundle      []byte
	Commitments []byte // t x 33 (the custody package checks each is a curve point)
	Machines    []CustodyMachineV2
}

// CustodyMachineV2 is one checked machine; Endpoint is still the pointer's string (the front parses it as a URL).
type CustodyMachineV2 struct {
	EncKey   [32]byte
	Endpoint string
	Enclave  bool
	Indices  []uint32
}

// MaxCustodyBundleBytes is EnclaveSecretVaultV2's bound on a bundle.
const MaxCustodyBundleBytes = 24 * 1024

var (
	vaultRE   = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	bytes32RE = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
	decRE     = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
)

// lowerHex decodes lowercase hex with an optional 0x prefix.
func lowerHex(s string) ([]byte, bool) {
	s = strings.TrimPrefix(s, "0x")
	if s != strings.ToLower(s) {
		return nil, false
	}
	b, err := hex.DecodeString(s)
	return b, err == nil
}

// V2 checks a v2 pointer strictly: every field present and well formed, the threshold and every machine's indices equal
// to the seat layout of the machines' Enclave flags (seats.Of), commitments exactly t x 33 bytes. Anything else fails.
func (c *Custody) V2() (*CustodyV2, error) {
	if v, err := c.Version(); err != nil || v != 2 {
		return nil, errors.New("not a v2 custody pointer")
	}
	var out CustodyV2
	if c.ChainID == 0 {
		return nil, errors.New("the custody pointer names no chain")
	}
	out.ChainID = c.ChainID
	if !vaultRE.MatchString(c.Vault) {
		return nil, errors.New("the custody pointer names no vault")
	}
	hex.Decode(out.Vault[:], []byte(strings.ToLower(c.Vault[2:])))
	if !bytes32RE.MatchString(c.CommitteeID) {
		return nil, errors.New("the custody pointer names no committee (0x + 64 lowercase hex)")
	}
	hex.Decode(out.CommitteeID[:], []byte(c.CommitteeID[2:]))
	if out.CommitteeID == ([32]byte{}) {
		return nil, errors.New("the custody pointer names the zero committee")
	}
	if c.Epoch == 0 {
		return nil, errors.New("the custody pointer names no epoch")
	}
	out.Epoch = c.Epoch
	var err error
	if !decRE.MatchString(c.PolicyRev) || !decRE.MatchString(c.SecretRev) {
		return nil, errors.New("the custody pointer's revisions are not positive decimal numbers")
	}
	if out.PolicyRev, err = strconv.ParseUint(c.PolicyRev, 10, 64); err != nil {
		return nil, errors.New("the custody pointer's policy revision is out of range")
	}
	if out.SecretRev, err = strconv.ParseUint(c.SecretRev, 10, 64); err != nil {
		return nil, errors.New("the custody pointer's secret revision is out of range")
	}
	b, ok := lowerHex(c.Bundle)
	if !ok || len(b) < 33+64+12+16 || len(b) > MaxCustodyBundleBytes {
		return nil, errors.New("the custody pointer's bundle is not hex of a v2 bundle's size")
	}
	out.Bundle = b
	if len(c.Machines) == 0 || len(c.Machines) > seats.MaxMachines {
		return nil, fmt.Errorf("the custody pointer names %d machines (1..%d)", len(c.Machines), seats.MaxMachines)
	}
	flags := make([]bool, len(c.Machines))
	keys := map[[32]byte]bool{}
	for i, m := range c.Machines {
		k, ok := lowerHex(m.EncKey)
		if !ok || len(k) != 32 {
			return nil, fmt.Errorf("custodian machine %d has no key", i)
		}
		var mk CustodyMachineV2
		copy(mk.EncKey[:], k)
		if keys[mk.EncKey] {
			return nil, fmt.Errorf("custodian machine %d repeats another machine's key", i)
		}
		keys[mk.EncKey] = true
		if !strings.HasPrefix(m.Endpoint, "https://") || len(m.Endpoint) > 190 {
			return nil, fmt.Errorf("custodian machine %d's endpoint is not an https URL of at most 190 bytes", i)
		}
		mk.Endpoint, mk.Enclave, mk.Indices = m.Endpoint, m.Enclave, append([]uint32(nil), m.Indices...)
		flags[i] = m.Enclave
		out.Machines = append(out.Machines, mk)
	}
	lay, err := seats.Of(flags)
	if err != nil {
		return nil, fmt.Errorf("the custody pointer's machines: %w", err)
	}
	if c.T != lay.T {
		return nil, fmt.Errorf("the custody pointer's threshold %d is not its seat layout's %d", c.T, lay.T)
	}
	out.T = c.T
	for i, m := range out.Machines {
		if len(m.Indices) != len(lay.Indices[i]) {
			return nil, fmt.Errorf("custodian machine %d's indices are not its seat's", i)
		}
		for j := range m.Indices {
			if m.Indices[j] != lay.Indices[i][j] {
				return nil, fmt.Errorf("custodian machine %d's indices are not its seat's", i)
			}
		}
	}
	cm, ok := lowerHex(c.Commitments)
	if !ok || len(cm) != c.T*33 {
		return nil, fmt.Errorf("the custody pointer's commitments are not %d x 33 bytes of hex", c.T)
	}
	out.Commitments = cm
	return &out, nil
}

const authProto = "custody-auth-v1"
const authProtoV2 = "custody-auth-v2"
const sigProto = "custody-sig-v1"

// CustodyAuth is the host's answer: the endpoint whose lease authorizes the release, the operator's personal_sign over
// custody.OperatorMessage, and the expiry it signed.
type CustodyAuth struct {
	Endpoint string
	Sig      string
	Expiry   int64
}

var (
	sigRE      = regexp.MustCompile(`^0x[0-9a-f]{130}$`)
	endpointRE = regexp.MustCompile(`^https?://[!-~]{1,190}$`)
)

// WriteAuthRequest is the guest's side: "custody-auth-v1 0x<id> <binding hex>\n".
func WriteAuthRequest(w io.Writer, id, binding [32]byte) error {
	_, err := fmt.Fprintf(w, "%s 0x%x %x\n", authProto, id, binding)
	return err
}

// WriteAuthRequestV2 is the guest's v2 side: "custody-auth-v2 0x<vault> 0x<id> <binding hex>\n" (lowercase).
func WriteAuthRequestV2(w io.Writer, vault [20]byte, id, binding [32]byte) error {
	_, err := fmt.Fprintf(w, "%s 0x%x 0x%x %x\n", authProtoV2, vault, id, binding)
	return err
}

// AuthRequest is one parsed custody-auth line. Vault is "" for v1, else "0x" + 40 lowercase hex.
type AuthRequest struct {
	V       int
	Vault   string
	ID      [32]byte
	Binding [32]byte
}

var lowerVaultRE = regexp.MustCompile(`^0x[0-9a-f]{40}$`)

// ReadAuthRequest is guestd's side for v1 lines only (ReadAnyAuthRequest takes both).
func ReadAuthRequest(r io.Reader) (id, binding [32]byte, err error) {
	a, err := ReadAnyAuthRequest(r)
	if err != nil {
		return id, binding, err
	}
	if a.V != 1 {
		return id, binding, errors.New("not a custody-auth-v1 line")
	}
	return a.ID, a.Binding, nil
}

// ReadAnyAuthRequest is guestd's side, bounded: a v1 line "custody-auth-v1 0x<id> <binding>" or a v2 line
// "custody-auth-v2 0x<vault> 0x<id> <binding>", every hex lowercase. The caller checks the id against the instance's
// HOST_DATA; the supervisor checks the vault against the one it measured.
func ReadAnyAuthRequest(r io.Reader) (AuthRequest, error) {
	var a AuthRequest
	line, err := bufio.NewReaderSize(io.LimitReader(r, 256), 256).ReadString('\n')
	if err != nil {
		return a, fmt.Errorf("no custody authorization request line: %w", err)
	}
	f := strings.Fields(line)
	switch {
	case len(f) == 3 && f[0] == authProto:
		a.V = 1
	case len(f) == 4 && f[0] == authProtoV2:
		a.V = 2
		if !lowerVaultRE.MatchString(f[1]) {
			return a, errors.New("the request names no vault (0x + 40 lowercase hex)")
		}
		a.Vault = f[1]
		f = f[1:]
	default:
		return a, errors.New("not a custody-auth-v1 or custody-auth-v2 line")
	}
	if !strings.HasPrefix(f[1], "0x") {
		return a, errors.New("the request names no deployment id")
	}
	if a.ID, err = ID(f[1]); err != nil {
		return a, errors.New("the request names no deployment id")
	}
	b, err := hex.DecodeString(f[2])
	if err != nil || len(b) != 32 || strings.ToLower(f[2]) != f[2] {
		return a, errors.New("the binding is not 32 bytes of lowercase hex")
	}
	copy(a.Binding[:], b)
	return a, nil
}

// WriteAuth is guestd's answer: "custody-sig-v1 <base64 endpoint> <expiry> 0x<sig>\n".
func WriteAuth(w io.Writer, a CustodyAuth) error {
	if !endpointRE.MatchString(a.Endpoint) || !sigRE.MatchString(a.Sig) || a.Expiry <= 0 {
		return errors.New("a custody authorization needs an endpoint, a 65-byte signature and an expiry")
	}
	_, err := fmt.Fprintf(w, "%s %s %d %s\n", sigProto, base64.StdEncoding.EncodeToString([]byte(a.Endpoint)), a.Expiry, a.Sig)
	return err
}

// ReadAuth is the guest's side, bounded and shape-checked; the custodians judge the signature.
func ReadAuth(r io.Reader) (CustodyAuth, error) {
	var a CustodyAuth
	line, err := bufio.NewReaderSize(io.LimitReader(r, 512), 512).ReadString('\n')
	if err != nil {
		return a, fmt.Errorf("the host sent no custody authorization: %w", err)
	}
	f := strings.Fields(line)
	if len(f) != 4 || f[0] != sigProto {
		return a, errors.New("not a custody-sig-v1 line")
	}
	ep, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil || !endpointRE.MatchString(string(ep)) {
		return a, errors.New("the authorization names no endpoint")
	}
	exp, err := strconv.ParseInt(f[2], 10, 64)
	if err != nil || exp <= 0 {
		return a, errors.New("the authorization has no expiry")
	}
	if !sigRE.MatchString(f[3]) {
		return a, errors.New("the authorization is not a 65-byte signature")
	}
	return CustodyAuth{Endpoint: string(ep), Sig: f[3], Expiry: exp}, nil
}
