package pvmcustody

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m2/custody"
	"enclave.host/isolation/m2/release"
)

// Window bounds the whole custody release (challenges, attestation, authorization, partials), as the SNP front's.
var Window = 3 * time.Minute

// Host is what the VM asks of the phone. Every answer is untrusted: a stream is TLS made here to the measured roots, an
// attestation is checked here and again by every custodian, an authorization is checked by every custodian against the
// registry. The host carries ciphertext and public bytes only.
type Host interface {
	// Dial opens one outbound stream to host:443 (pvm-rt egress: "CONNECT <host> 443" on a host-opened vsock stream).
	Dial(ctx context.Context, host string) (net.Conn, error)
	// Attest asks AVmPayload_requestAttestation for a certificate over the challenge, and the instance key's signature.
	Attest(challenge [64]byte) (*Attested, error)
	// Authorize asks the lease holder's operator to sign this v2 release (custody-auth-v2 over the egress channel).
	Authorize(ctx context.Context, vault [20]byte, id, binding [32]byte) (endpoint, sig string, expiry int64, err error)
	Logf(format string, args ...any)
}

// Result is what the app starts with: the OWNER-committed config text, in custody-v2 mode the values opened here, and the
// config the component receives (Resolved: ConfigText with $NAME resolved by the platform runner's own rule, appconfig.Resolve,
// which the standard runtime and pvm-rt's sealed-release path share). The payload puts Resolved in ENCLAVE_CONFIG and the
// values beside it in the app's environment block, so pvm-rt itself is unchanged.
type Result struct {
	SecretsMode string
	ConfigText  string
	Resolved    string
	Values      map[string]string
}

// startupAuth is what this package reads from an owner startup authorization (bootstrap.Authorization); an interface only so
// the composition can be tested without a chain.
type startupAuth interface {
	ConfigText() (string, error)
	SecretsMode() (string, error)
	Custody() (*release.Custody, error)
	Revalidate(ctx context.Context) error
}

type authorizeFn func(ctx context.Context, id [32]byte, raw []byte, loaded bootstrap.Identity) (startupAuth, error)

// dialer is the measured client's dial allowlist: the measured RPC origins, the verified pointer's custodians, and the
// history sources a verified owner package names (bootstrap AllowOrigin).
type dialer struct {
	mu      sync.Mutex
	allowed map[string]bool
	host    Host
}

func (d *dialer) allow(hostport string) { d.mu.Lock(); d.allowed[hostport] = true; d.mu.Unlock() }
func (d *dialer) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	d.mu.Lock()
	ok := d.allowed[addr]
	d.mu.Unlock()
	if !ok || ctx.Err() != nil {
		return nil, fmt.Errorf("%s is not a measured or owner-committed origin", addr)
	}
	h, port, err := net.SplitHostPort(addr)
	if err != nil || port != "443" {
		return nil, errors.New("only https origins on 443")
	}
	return d.host.Dial(ctx, h)
}

func measuredClient(d *dialer, roots *x509.CertPool) *http.Client {
	return &http.Client{Transport: &http.Transport{Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 10 * time.Second,
		DialContext: d.dial}, Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// Start runs the owner startup and, for a custody-v2 package, the release. `pkg` is the owner's startup package (public
// bytes the host carried: Authorize refuses them unless their sha256 is the guestBootstrap commitment the ledger quorum
// reads for `id`). Nothing is returned unless every check passed and the authorization still holds right now.
func Start(ctx context.Context, h Host, vm VM, id [32]byte, pkg []byte) (*Result, error) {
	roots, err := bootstrap.MeasuredRoots()
	if err != nil {
		return nil, err
	}
	d := &dialer{allowed: map[string]bool{}, host: h}
	conf := bootstrap.MeasuredConfig(nil)
	for _, raw := range conf.RPCs {
		u, e := url.Parse(raw)
		if e != nil {
			return nil, e
		}
		d.allow(net.JoinHostPort(u.Hostname(), "443"))
	}
	client := measuredClient(d, roots)
	conf.Client, conf.AllowOrigin = client, d.allow
	r, err := bootstrap.NewReader(conf)
	if err != nil {
		return nil, err
	}
	authorize := func(ctx context.Context, id [32]byte, raw []byte, loaded bootstrap.Identity) (startupAuth, error) {
		return r.AuthorizeWhenConfirmed(ctx, id, raw, loaded)
	}
	return start(ctx, h, vm, id, pkg, authorize, d, client)
}

func start(ctx context.Context, h Host, vm VM, id [32]byte, pkg []byte, authorize authorizeFn, d *dialer, client *http.Client) (*Result, error) {
	rid, iid, err := vm.check()
	if err != nil {
		return nil, err
	}
	auth, err := authorize(ctx, id, pkg, bootstrap.Identity{AppID: vm.AppID, RuntimeID: rid})
	if err != nil {
		return nil, fmt.Errorf("owner startup: %w", err)
	}
	mode, err := auth.SecretsMode()
	if err != nil {
		return nil, err
	}
	text, err := auth.ConfigText()
	if err != nil {
		return nil, err
	}
	res := &Result{SecretsMode: mode, ConfigText: text, Resolved: text}
	switch mode {
	case "public":
	case "custody-v2":
		ptr, err := auth.Custody()
		if err != nil || ptr == nil {
			return nil, errors.New("owner startup: the custody pointer is unavailable")
		}
		st, err := stateV2(id, ptr)
		if err != nil {
			return nil, err
		}
		for _, m := range st.Machines {
			u, e := url.Parse(m.Endpoint)
			if e != nil {
				return nil, e
			}
			d.allow(net.JoinHostPort(u.Hostname(), "443"))
		}
		cl := &custody.Client{Post: postVia(client), AuthorizeV2: h.Authorize, RuntimeID: rid, TransportSPKI: append([]byte(nil), vm.SPKI...), Logf: h.Logf,
			Evidence: func(binding [32]byte) (json.RawMessage, error) { return vm.evidence(binding, iid, h.Attest) }}
		cctx, cancel := context.WithTimeout(ctx, Window)
		b, err := cl.ObtainV2(cctx, st)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("custody: %w", err)
		}
		// the owner committed the config INSIDE the bundle: values are substituted only into exactly that text
		if got := sha256.Sum256([]byte(text)); hex.EncodeToString(got[:]) != b.ConfigSha256 {
			return nil, errors.New("custody: the owner-committed config is not the one the bundle names; no value is used")
		}
		if err = custody.CheckEnv(b.Env); err != nil {
			return nil, fmt.Errorf("custody: %w", err)
		}
		if res.Resolved, err = appconfig.Resolve(text, b.Env); err != nil {
			return nil, fmt.Errorf("custody: the owner's config: %w", err)
		}
		res.Values = b.Env
		h.Logf("pvm custody: deployment 0x%x... secrets revision %d from a v2 threshold of %d over %d machines, %d name(s)", id[:4], st.SecretRev, st.Threshold, len(st.Machines), len(b.Env))
	default:
		return nil, fmt.Errorf("unsupported secrets mode %q", mode)
	}
	// custody and the network may be slow: ownership, the lease and the package are re-read right before the app starts
	if err = auth.Revalidate(ctx); err != nil {
		res.Values, res.Resolved = nil, ""
		return nil, fmt.Errorf("owner startup changed: %w", err)
	}
	return res, nil
}

// postVia is the SNP front's custodyPost over the measured client: one JSON POST, bounded answer, a refusal as its code.
// TLS here guards availability only: every partial is sealed end to end to the recipient key made in this VM.
func postVia(c *http.Client) func(ctx context.Context, raw string, body, out any) error {
	return func(ctx context.Context, raw string, body, out any) error {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, raw, bytes.NewReader(b))
		if err != nil {
			return err
		}
		req.Header.Set("content-type", "application/json")
		res, err := c.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		rb, err := io.ReadAll(io.LimitReader(res.Body, 65536))
		if err != nil {
			return err
		}
		if res.StatusCode != http.StatusOK {
			var e struct{ Error, Message string }
			json.Unmarshal(rb, &e)
			return fmt.Errorf("%d %s: %.160s", res.StatusCode, e.Error, e.Message)
		}
		return json.Unmarshal(rb, out)
	}
}
