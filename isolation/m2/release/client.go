package release

// The guest's two network steps of the release: reading its ticket from the host, and presenting it to the relay.
//
// Neither step trusts the host. The ticket is useless outside this guest, because the relay checks it against a
// report only this guest can produce. The relay's REPLY is a different matter: the seal is keyed by X25519 against
// the guest's public sealKey, salted with a ticket the host carries, so anyone who can answer as the relay could seal
// a config of their choosing to this guest. What makes the reply the relay's is its SIGNATURE under a release key
// pinned in this image (contract v1.2, verify.go). TLS to the pinned name and roots below still keeps the exchange
// to the relay, but it is no longer what the config's integrity rests on.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
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

// RelayRoots is the pinned pool.
func RelayRoots() (*x509.CertPool, error) {
	p := x509.NewCertPool()
	for _, pem := range embeddedRoots {
		if !p.AppendCertsFromPEM(pem) {
			return nil, errors.New("an embedded relay root does not parse")
		}
	}
	return p, nil
}

// ---- the ticket, from the host ----

// TicketHold is how long guestd holds a booting guest's ticket connection waiting for the supervisor's ticket
// (m4/guestd/release.go). The front's own wait for the ticket line is derived from it and outlasts it.
const TicketHold = 5 * time.Minute

// ReleaseWindow is how long after its ticket arrives a guest keeps presenting it to a relay that answers with a
// ticket-keeping 503 (the ticket's TTL is 120 s from issue, and the supervisor fetches it only once the guest waits).
const ReleaseWindow = 100 * time.Second

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
	Keys    []ed25519.PublicKey // the relay's pinned release keys (PinnedRelayKeys); the reply must be signed by one
	Timeout time.Duration       // one attempt; 0 = 25 s
	// Retry: the wait between attempts after a ticket-keeping 503 or a 429; 0 = 5 s. RetryFor bounds all attempts when
	// the caller's context has no deadline; 0 = 100 s.
	Retry, RetryFor time.Duration
}

// MaxSealed bounds the relay's reply: a config of up to 1 MiB plus secrets, sealed and base64'd, with room.
const MaxSealed = 4 << 20

var errCodeRE = regexp.MustCompile(`^[a-z_]{1,40}$`)

// Release POSTs {id, ticket, sealKey, evidence} and returns the reply, VERIFIED (contract v1.2), for sk to open. A
// refusal returns the relay's status and error CODE only (a bounded token), never its message: the guest's log is the
// host's to read. With no pinned key it refuses before sending, so the one-use ticket is not burned.
func (c *Client) Release(ctx context.Context, id [32]byte, ticket [32]byte, sk *SealKey, ev Evidence) (*Response, error) {
	if c.Dial == nil || c.Host == "" || c.Roots == nil {
		return nil, errors.New("release client: no dialer, relay host or pinned roots")
	}
	if len(c.Keys) == 0 {
		return nil, errors.New("release client: no relay release key is pinned in this image, so no release is trusted")
	}
	if sk == nil {
		return nil, errors.New("release client: no seal key")
	}
	sealKey := sk.Public()
	body, err := json.Marshal(request{ID: fmt.Sprintf("0x%x", id), Ticket: base64.StdEncoding.EncodeToString(ticket[:]),
		SealKey: base64.StdEncoding.EncodeToString(sealKey), Evidence: ev})
	if err != nil {
		return nil, err
	}
	// The relay KEEPS the ticket on its own 503-class answers (warming, busy, prediction_unavailable, ...: it may be
	// predicting this image's measurement, 12-26 s for a cold catalog version) and on a 429, so those are retried with
	// the SAME ticket and evidence - the report binds the ticket and the seal key, not a time - every Retry, until the
	// caller's deadline (the provisioner sets ~100 s after the ticket arrived; its TTL is 120 s from issue). Any other
	// answer is final: a 403 has burned the ticket, and a 200 is verified at once.
	retry := c.Retry
	if retry <= 0 {
		retry = 5 * time.Second
	}
	if _, has := ctx.Deadline(); !has {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.retryFor())
		defer cancel()
	}
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
	// no redirect is followed: the reply must come from the pinned origin's own answer
	hc := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var last error // the relay's last ticket-keeping answer
	for {
		sealed, status, err := c.attempt(ctx, hc, body, id)
		if err == nil {
			// rule 1: the digest is this guest's own id, ticket and seal key over the sealed bytes, not the reply's fields
			return sk.Verify(c.Keys, id, ticket, sealed.sealed, sealed.sig, sealed.keyID)
		}
		final := status != http.StatusServiceUnavailable && status != http.StatusTooManyRequests && status != statusTransport
		if final && status > 0 {
			return nil, err // a real answer (a 403 that burned the ticket, a 422) is reported as itself, deadline or not
		}
		if ctx.Err() != nil && last != nil {
			// the deadline cut an attempt short: what the relay was actually answering is the useful error, not the cut
			return nil, fmt.Errorf("%w (the relay kept answering it; stopped at the deadline)", last)
		}
		if status != http.StatusServiceUnavailable && status != http.StatusTooManyRequests && status != statusTransport {
			return nil, err
		}
		last = err
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("%w (the relay kept answering it; stopped at the deadline)", last)
		case <-time.After(retry):
		}
	}
}

func (c *Client) retryFor() time.Duration {
	if c.RetryFor > 0 {
		return c.RetryFor
	}
	return ReleaseWindow
}

type reply struct {
	sealed, sig []byte
	keyID       string
}

// statusTransport: the attempt got no answer for a reason that is not the relay's certificate (a reset, a relay
// restarting). Retried with the same body inside the window like a 503 (enclave-d1): at worst the relay had consumed the
// ticket and answers the retry 403, which is final. A certificate failure (status 0) is final at once: retrying a pin
// that failed cannot help.
const statusTransport = -1

// attempt is ONE POST of the same body. It returns the reply's parts, or the HTTP status (0 = no answer that may be
// retried, statusTransport = a transport failure that may) and why.
func (c *Client) attempt(ctx context.Context, hc *http.Client, body []byte, id [32]byte) (reply, int, error) {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 25 * time.Second // the relay waits at most 10 s for a cold prediction before its 503 warming
	}
	actx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(actx, http.MethodPost, "https://"+c.Host+"/v1/secrets/release", bytes.NewReader(body))
	if err != nil {
		return reply{}, 0, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		var ua x509.UnknownAuthorityError
		var hn x509.HostnameError
		var ci x509.CertificateInvalidError
		if errors.As(err, &ua) || errors.As(err, &hn) || errors.As(err, &ci) || ctx.Err() != nil {
			return reply{}, 0, fmt.Errorf("release: %w", tlsReason(err))
		}
		return reply{}, statusTransport, fmt.Errorf("release: %w", tlsReason(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxSealed+1))
	if err != nil {
		return reply{}, 0, fmt.Errorf("release: reading the reply: %w", err)
	}
	if len(raw) > MaxSealed {
		return reply{}, 0, errors.New("release: the reply is larger than any release")
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		code := "unknown"
		if json.Unmarshal(raw, &e) == nil && errCodeRE.MatchString(e.Error) {
			code = e.Error
		}
		return reply{}, resp.StatusCode, fmt.Errorf("release refused: HTTP %d %s", resp.StatusCode, code)
	}
	var out struct {
		ID     string `json:"id"`
		Sealed string `json:"sealed"`
		Sig    string `json:"sig"`
		KeyID  string `json:"keyId"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return reply{}, 200, errors.New("release: the reply is not {id, sealed, sig, keyId}")
	}
	if got, err := ID(out.ID); err != nil || got != id {
		return reply{}, 200, errors.New("release: the reply names another deployment")
	}
	sealed, err := base64.StdEncoding.DecodeString(out.Sealed)
	if err != nil {
		return reply{}, 200, errors.New("release: the sealed blob is not base64")
	}
	sig, err := base64.StdEncoding.DecodeString(out.Sig)
	if err != nil {
		sig = nil // a signature that is not base64 is a missing one, and Verify refuses it
	}
	return reply{sealed: sealed, sig: sig, keyID: out.KeyID}, 200, nil
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
