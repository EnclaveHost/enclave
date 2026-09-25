package release

// The guest's two network steps of the release: reading its ticket from the host, and presenting it to the relay.
//
// Neither step trusts the host. The ticket is useless outside this guest, because the relay checks it against a
// report only this guest can produce. The relay's REPLY is a different matter: the seal is keyed by X25519 against
// the guest's public sealKey, salted with a ticket the host carries, so anyone who can answer as the relay can seal a
// config of their choosing to this guest. What makes the reply the relay's is the TLS connection alone, which is
// why the relay's name is a constant of this (measured) package and its roots are pinned below rather than read
// from anything the host or the image's filesystem supplies.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// RelayHost is the only origin a guest releases from. It is a constant compiled into the measured front, not a flag,
// a config value or anything guestd sends (enclave-99): a guest image that released from another relay would be a
// different binary, and so a different launch measurement.
const RelayHost = "api.enclave.host"

// The roots the relay's certificate must chain to: Let's Encrypt's ISRG Root X1 and X2 (api.enclave.host served
// YE1 -> Root YE -> ISRG Root X2 -> ISRG Root X1 on 2026-09-25). A system bundle would make every CA in it able to
// forge a guest's config; this set makes a certificate from any other CA a refused release instead. If the relay's
// ACME client ever issues from another CA (Caddy's default fallback is ZeroSSL), releases FAIL CLOSED until this set
// and the measurement are updated: an outage, never a forgery.
var (
	//go:embed roots/isrg-root-x1.pem
	isrgRootX1 []byte
	//go:embed roots/isrg-root-x2.pem
	isrgRootX2 []byte
)

// RootFingerprints pins the embedded roots by the SHA-256 of their DER, so a changed PEM file fails a test rather
// than quietly widening what the guest trusts.
var RootFingerprints = []string{
	"96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6", // ISRG Root X1
	"69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470", // ISRG Root X2
}

// RelayRoots is the pinned pool.
func RelayRoots() (*x509.CertPool, error) {
	p := x509.NewCertPool()
	for _, pem := range [][]byte{isrgRootX1, isrgRootX2} {
		if !p.AppendCertsFromPEM(pem) {
			return nil, errors.New("an embedded relay root does not parse")
		}
	}
	return p, nil
}

// ---- the ticket, from the host ----

// TicketPort is the host (vsock CID 2) port guestd hands each guest its ticket on.
const TicketPort = 9444

const ticketProto = "ticket-v1"

// Ticket is what the host hands the guest: the deployment the ticket was issued for, and the ticket.
type Ticket struct {
	ID     [32]byte
	Ticket [32]byte
}

// WriteTicket is guestd's side: one line, "ticket-v1 0x<id> <base64 ticket>\n".
func WriteTicket(w io.Writer, t Ticket) error {
	_, err := fmt.Fprintf(w, "%s 0x%x %s\n", ticketProto, t.ID, base64.StdEncoding.EncodeToString(t.Ticket[:]))
	return err
}

// ReadTicket is the guest's side, bounded. It checks the SHAPE only; the caller checks the id against HOST_DATA.
func ReadTicket(r io.Reader) (Ticket, error) {
	var t Ticket
	line, err := bufio.NewReaderSize(io.LimitReader(r, 160), 160).ReadString('\n')
	if err != nil {
		return t, fmt.Errorf("the host sent no ticket line: %w", err)
	}
	f := strings.Fields(line)
	if len(f) != 3 || f[0] != ticketProto {
		return t, errors.New("the host's ticket line is not ticket-v1")
	}
	if t.ID, err = ID(f[1]); err != nil || !strings.HasPrefix(f[1], "0x") {
		return t, errors.New("the host's ticket names no deployment id")
	}
	raw, err := base64.StdEncoding.DecodeString(f[2])
	if err != nil || len(raw) != 32 {
		return t, errors.New("the host's ticket is not 32 bytes of base64")
	}
	copy(t.Ticket[:], raw)
	return t, nil
}

// ---- the release, from the relay ----

// Evidence is the guest-domain document a release presents. It has NO nonce field at all: the ticket is bound in
// report_data, and the relay refuses a release document that states a nonce (a release report must never pass for
// an ordinary attestation).
type Evidence struct {
	Format       string          `json:"format"`  // sev-snp-guest-domain-v1
	Abi          string          `json:"abi"`     // enclave-domain-abi/2
	Runtime      json.RawMessage `json:"runtime"` // the runtime identity the binding's runtimeId is taken over
	TransportKey string          `json:"transportKey"`
	Report       string          `json:"report"`
	Certs        string          `json:"certs,omitempty"`
}

type request struct {
	ID       string   `json:"id"`
	Ticket   string   `json:"ticket"`
	SealKey  string   `json:"sealKey"`
	Evidence Evidence `json:"evidence"`
}

// Client presents one release. Dial opens a raw stream to the relay (in a guest: the egress path to RelayHost:443);
// the client runs TLS over it itself, against Roots and ServerName Host. Host and Roots exist for tests; the front
// passes RelayHost and RelayRoots().
type Client struct {
	Dial    func(ctx context.Context) (net.Conn, error)
	Host    string
	Roots   *x509.CertPool
	Timeout time.Duration
}

// MaxSealed bounds the relay's reply: a config of up to 1 MiB plus secrets, sealed and base64'd, with room.
const MaxSealed = 4 << 20

var errCodeRE = regexp.MustCompile(`^[a-z_]{1,40}$`)

// Release POSTs {id, ticket, sealKey, evidence} and returns the sealed blob. A refusal returns the relay's status and
// error CODE only (a bounded token), never its message: the guest's log is the host's to read.
func (c *Client) Release(ctx context.Context, id [32]byte, ticket [32]byte, sealKey []byte, ev Evidence) ([]byte, error) {
	if c.Dial == nil || c.Host == "" || c.Roots == nil {
		return nil, errors.New("release client: no dialer, relay host or pinned roots")
	}
	if len(sealKey) != 32 {
		return nil, errors.New("release client: the seal key is not 32 bytes")
	}
	body, err := json.Marshal(request{ID: fmt.Sprintf("0x%x", id), Ticket: base64.StdEncoding.EncodeToString(ticket[:]),
		SealKey: base64.StdEncoding.EncodeToString(sealKey), Evidence: ev})
	if err != nil {
		return nil, err
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tr := &http.Transport{
		Proxy: nil, // never an environment proxy
		// the transport dials the egress path and runs TLS itself, with THIS config: the pinned roots and name
		DialContext:        func(ctx context.Context, _, _ string) (net.Conn, error) { return c.Dial(ctx) },
		TLSClientConfig:    &tls.Config{ServerName: c.Host, RootCAs: c.Roots, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:  false,
		DisableKeepAlives:  true,
		DisableCompression: true,
	}
	defer tr.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+c.Host+"/v1/secrets/release", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	// no redirect is followed: the reply must come from the pinned origin's own answer
	hc := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("release: %w", tlsReason(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxSealed+1))
	if err != nil {
		return nil, fmt.Errorf("release: reading the reply: %w", err)
	}
	if len(raw) > MaxSealed {
		return nil, errors.New("release: the reply is larger than any release")
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		code := "unknown"
		if json.Unmarshal(raw, &e) == nil && errCodeRE.MatchString(e.Error) {
			code = e.Error
		}
		return nil, fmt.Errorf("release refused: HTTP %d %s", resp.StatusCode, code)
	}
	var out struct {
		ID     string `json:"id"`
		Sealed string `json:"sealed"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, errors.New("release: the reply is not {id, sealed}")
	}
	if got, err := ID(out.ID); err != nil || got != id {
		return nil, errors.New("release: the reply names another deployment")
	}
	sealed, err := base64.StdEncoding.DecodeString(out.Sealed)
	if err != nil {
		return nil, errors.New("release: the sealed blob is not base64")
	}
	return sealed, nil
}

// tlsReason keeps a certificate failure recognisable without echoing the certificate's names or the peer.
func tlsReason(err error) error {
	var ua x509.UnknownAuthorityError
	var hn x509.HostnameError
	var ci x509.CertificateInvalidError
	switch {
	case errors.As(err, &ua):
		return errors.New("the relay's certificate does not chain to a pinned root")
	case errors.As(err, &hn):
		return errors.New("the relay's certificate is not valid for the pinned relay name")
	case errors.As(err, &ci):
		return errors.New("the relay's certificate is invalid")
	}
	return errors.New("the connection to the relay failed")
}

// EnvelopeTag is what the guest may state about the release it runs with: the ledger envelope's hash (public, it is
// on chain) and when the relay issued it. Never config or secret content.
func (r *Release) EnvelopeTag() string {
	if r == nil {
		return ""
	}
	h := strings.TrimPrefix(strings.ToLower(r.EnvelopeSha256), "0x")
	if _, err := hex.DecodeString(h); err != nil || len(h) != 64 {
		return ""
	}
	return h
}
