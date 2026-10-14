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
)

// CustodyMember is one custodian of the bundle's committee epoch, in committee order.
type CustodyMember struct {
	EncKey   string `json:"encKey"`   // 64 hex
	Endpoint string `json:"endpoint"` // https://<host>
}

// Custody is the deployment's custody state as the relay read it from the vault (custody/chain.mjs readState).
type Custody struct {
	ChainID    uint64          `json:"chainId"`
	Vault      string          `json:"vault"`
	PolicyRev  string          `json:"policyRev"`
	SecretRev  string          `json:"secretRev"`
	Epoch      uint32          `json:"epoch"`
	Threshold  int             `json:"threshold"`
	Members    []CustodyMember `json:"members"`
	C0         string          `json:"c0"`         // 66 hex: the bundle's constant commitment
	Ciphertext string          `json:"ciphertext"` // base64
}

const authProto = "custody-auth-v1"
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

// ReadAuthRequest is guestd's side, bounded; the caller checks the id against the instance's HOST_DATA.
func ReadAuthRequest(r io.Reader) (id, binding [32]byte, err error) {
	line, err := bufio.NewReaderSize(io.LimitReader(r, 200), 200).ReadString('\n')
	if err != nil {
		return id, binding, fmt.Errorf("no custody authorization request line: %w", err)
	}
	f := strings.Fields(line)
	if len(f) != 3 || f[0] != authProto || !strings.HasPrefix(f[1], "0x") {
		return id, binding, errors.New("not a custody-auth-v1 line")
	}
	if id, err = ID(f[1]); err != nil {
		return id, binding, errors.New("the request names no deployment id")
	}
	b, err := hex.DecodeString(f[2])
	if err != nil || len(b) != 32 || strings.ToLower(f[2]) != f[2] {
		return id, binding, errors.New("the binding is not 32 bytes of lowercase hex")
	}
	copy(binding[:], b)
	return id, binding, nil
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
