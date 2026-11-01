package main

// In-guest ACME for THIS deployment's app-zone name (<first 4 bytes of HOST_DATA, hex>.<the measured cert zone>, the
// name certs.go already derives from this domain's own hardware report), when the owner's package selects a CA and
// challenge replicas (bootstrap.AppZoneACME). It needs no Enclave certificate service and no relay: the account key and
// the TLS key are minted in this guest's memory and never leave it, and the dns-01 value is delivered to every selected
// replica, each of which re-verifies the push against the chain before answering for the name
// (network/app-zone-challenge.mjs; relay/dns-relay.js APP_CHALLENGE_AUTH=attested-lease).
//
//   - The name is never taken from the package, a request or a file: it is certs.name, and it must be this
//     deployment's own label (checked against the startup authorization), so no package can make a guest ask for an
//     apex, a wildcard, a deeper name or another deployment's name.
//   - Each push (v2) carries the lease identity the guest's own agreeing chain read saw (runner, runner operator, app
//     reference, config envelope), the ACME order URL and authorization expiry, and an SNP report binding the attested
//     key and a nonce over all of it. A replica that sees a different current lease, an inactive registry host, or a
//     catalog verdict that refuses the app answers 403, and the guest then does not ask the CA to validate.
//   - Replicas are alternatives for availability: issuance proceeds when at least one accepted and none refused; one
//     that cannot be reached is skipped (its name server does not answer the CA either). The CA's validation through
//     the zone's real NS delegation decides.
//
// The zone's delegation and the public CA remain external dependencies of ordinary WebPKI; the attested native path
// (SPKI pinned through attestation) does not depend on either.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme"

	"enclave.host/isolation/m2/bootstrap"
)

const (
	appZonePath        = "/.well-known/enclave-app-zone"
	appPushNoncePrefix = "enclave-app-acme-push-v2\n"
	appPushSigPrefix   = "enclave-app-acme-push-sig-v2\n"
	appChallengePath   = "/v1/app-challenge"
)

type appLease struct {
	Runner   string `json:"runner"`
	Operator string `json:"operator"`
	AppRef   string `json:"appRef"`
	Envelope string `json:"envelope"`
}

type appOrder struct {
	URL     string `json:"url"`
	Expires int64  `json:"expires"`
}

// appPush is the body a replica authorizes. Field order is fixed by this struct; the signature covers the exact bytes.
type appPush struct {
	V           int             `json:"v"`
	Op          string          `json:"op"`
	Name        string          `json:"name"`
	Value       string          `json:"value"`
	Deployment  string          `json:"deploymentId"`
	Owner       string          `json:"owner"`
	Lease       appLease        `json:"lease"`
	Order       appOrder        `json:"order"`
	TS          int64           `json:"ts"`
	SPKI        string          `json:"spki"`
	Attestation json.RawMessage `json:"attestation"`
}

// appPushNonce binds an attestation to exactly this push (network/app-zone-challenge.mjs appPushNonce computes the same).
func appPushNonce(p appPush) []byte {
	s := strings.Join([]string{strconv.Itoa(p.V), p.Op, p.Name, p.Value, p.Deployment, p.Owner, p.Lease.Runner, p.Lease.Operator,
		p.Lease.AppRef, p.Lease.Envelope, p.Order.URL, strconv.FormatInt(p.Order.Expires, 10), strconv.FormatInt(p.TS, 10), p.SPKI}, "\n")
	h := sha256.Sum256([]byte(appPushNoncePrefix + s))
	return h[:]
}

type replicaOutcome struct {
	Replica string `json:"replica"`
	Status  int    `json:"status"` // 0 = unreachable
	Detail  string `json:"detail,omitempty"`
}

type appZoneIssuer struct {
	auth       nameAuthority
	certs      *certState // the root state: its name is the HOST_DATA-derived app-zone name
	name       string
	httpc      *http.Client
	attest     func(nonce []byte) ([]byte, error)
	signer     crypto.Signer
	spki       []byte
	now        func() time.Time
	account    *acme.Client
	eab        *acme.ExternalAccountBinding
	registered bool
	mu         sync.Mutex
	st         issueState
	last       []replicaOutcome
	revoked    string
	cfg        bootstrap.AppZoneACME
}

// newAppZoneIssuer -> nil, nil when the package selects no app-zone issuance.
func newAppZoneIssuer(auth nameAuthority, certs *certState, eabKID string, eabKey []byte, httpc *http.Client,
	attest func([]byte) ([]byte, error), signer crypto.Signer, spki []byte) (*appZoneIssuer, error) {
	if auth == nil || certs == nil {
		return nil, errors.New("app-zone issuance needs the startup authorization and the certificate state")
	}
	g, err := auth.NameGrant()
	if err != nil {
		return nil, err
	}
	if g.AppZone == nil {
		return nil, nil
	}
	label, _, ok := strings.Cut(certs.name, ".")
	if certs.name == "" || !ok || label != hex.EncodeToString(g.Deployment[:4]) {
		// the name is the SNP report's HOST_DATA, or on a Shield partition the launcher's /cert.name: either way it
		// must be the deployment the owner-committed startup authorized
		return nil, errors.New("this domain's name (HOST_DATA or the launcher's) is not this deployment's app-zone name")
	}
	if g.AppZone.EAB != nil && (eabKID == "" || len(eabKey) == 0) {
		return nil, errors.New("the selected CA needs an EAB this guest could not resolve")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	i := &appZoneIssuer{auth: auth, certs: certs, name: certs.name, httpc: httpc, attest: attest, signer: signer, spki: spki, now: time.Now,
		cfg: *g.AppZone, account: &acme.Client{Key: key, DirectoryURL: g.AppZone.Directory, HTTPClient: httpc, UserAgent: "enclave-front"}}
	if g.AppZone.EAB != nil {
		i.eab = &acme.ExternalAccountBinding{KID: eabKID, Key: append([]byte(nil), eabKey...)}
	}
	return i, nil
}

func (i *appZoneIssuer) due(now time.Time) bool {
	if leaf := i.certs.current(); leaf != nil && now.Before(renewAt(leaf)) {
		return false
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.revoked == "" && !now.Before(i.st.nextAttempt)
}

// pass: when issuance is due, one fresh chain refresh and then one attempt. Returns true when a certificate was installed.
// (A guest with no due certificate makes no chain read here; owner names keep their own refresh.)
func (i *appZoneIssuer) pass(ctx context.Context) bool {
	now := i.now()
	if !i.due(now) {
		return false
	}
	if err := i.auth.Refresh(ctx); errors.Is(err, bootstrap.ErrRevoked) {
		i.mu.Lock()
		i.revoked = "the deployment's owner, runner, operator, app reference or startup commitment changed"
		i.mu.Unlock()
		return false
	}
	err := i.issue(ctx)
	i.mu.Lock()
	defer i.mu.Unlock()
	i.st.lastAttempt = now
	if err != nil {
		i.st.failures++
		back := acmeBackoffMin << min(i.st.failures-1, 7)
		if back > acmeBackoffMax {
			back = acmeBackoffMax
		}
		i.st.lastError, i.st.nextAttempt = bounded(err.Error(), 240), now.Add(back)
		fmt.Printf("DOM app-zone: certificate for %s not issued (%s); next attempt in %s\n", i.name, i.st.lastError, back)
		return false
	}
	i.st.failures, i.st.lastError, i.st.nextAttempt = 0, "", time.Time{}
	i.st.issued++
	return true
}

func (i *appZoneIssuer) run(ctx context.Context, every time.Duration) {
	for {
		i.pass(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

func (i *appZoneIssuer) issue(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	g, err := i.auth.NameGrant()
	if err != nil || g.AppZone == nil || !i.now().Before(g.Until) {
		return errors.New("the startup authorization lapsed; no certificate is requested")
	}
	if !i.registered {
		if _, err := i.account.Register(ctx, &acme.Account{ExternalAccountBinding: i.eab}, acme.AcceptTOS); err != nil && !errors.Is(err, acme.ErrAccountAlreadyExists) {
			return fmt.Errorf("ACME account: %w", err)
		}
		i.registered = true
	}
	order, err := i.account.AuthorizeOrder(ctx, acme.DomainIDs(i.name))
	if err != nil {
		return fmt.Errorf("ACME order: %w", err)
	}
	lease := appLease{Runner: "0x" + hex.EncodeToString(g.Lease.Runner[:]), Operator: g.Lease.Operator, AppRef: g.Lease.AppRef, Envelope: g.Lease.Envelope}
	for _, u := range order.AuthzURLs {
		z, err := i.account.GetAuthorization(ctx, u)
		if err != nil {
			return fmt.Errorf("ACME authorization: %w", err)
		}
		if z.Status == acme.StatusValid {
			continue
		}
		if z.Identifier.Value != i.name {
			return errors.New("the CA asked to authorize another name")
		}
		var ch *acme.Challenge
		for _, c := range z.Challenges {
			if c.Type == "dns-01" {
				ch = c
			}
		}
		if ch == nil {
			return errors.New("the CA offered no dns-01 challenge")
		}
		value, err := i.account.DNS01ChallengeRecord(ch.Token)
		if err != nil {
			return err
		}
		expires := z.Expires
		if expires.IsZero() {
			expires = order.Expires
		}
		if expires.IsZero() || expires.After(i.now().Add(30*24*time.Hour)) {
			expires = i.now().Add(time.Hour)
		}
		ord := appOrder{URL: order.URI, Expires: expires.Unix()}
		outcomes, err := i.pushAll(ctx, "set", value, g, lease, ord)
		i.mu.Lock()
		i.last = outcomes
		i.mu.Unlock()
		defer i.pushAll(context.Background(), "delete", value, g, lease, ord)
		if err != nil {
			return err
		}
		if _, err := i.account.Accept(ctx, ch); err != nil {
			return fmt.Errorf("ACME challenge: %w", err)
		}
		if _, err := i.account.WaitAuthorization(ctx, z.URI); err != nil {
			return fmt.Errorf("ACME validation of _acme-challenge.%s through the zone's name servers: %w", i.name, err)
		}
	}
	if order, err = i.account.WaitOrder(ctx, order.URI); err != nil {
		return fmt.Errorf("ACME order: %w", err)
	}
	csr, err := i.certs.csrDER()
	if err != nil {
		return err
	}
	ders, _, err := i.account.CreateOrderCert(ctx, order.FinalizeURL, csr, true)
	if err != nil {
		return fmt.Errorf("ACME finalize: %w", err)
	}
	var chain bytes.Buffer
	for _, d := range ders {
		pem.Encode(&chain, &pem.Block{Type: "CERTIFICATE", Bytes: d})
	}
	// the authorization can lapse or be revoked while the CA works: install only while it is still current
	if g2, err := i.auth.NameGrant(); err != nil || g2.AppZone == nil || !i.now().Before(g2.Until) || g2.Lease != g.Lease {
		return errors.New("the startup authorization changed during issuance; the certificate is not installed")
	}
	leaf, err := i.certs.install(chain.Bytes(), i.now())
	if err != nil {
		return err
	}
	fmt.Printf("DOM app-zone: certificate installed for %s: issuer %q, valid until %s\n", i.name, leaf.Issuer.CommonName,
		leaf.NotAfter.UTC().Format(time.RFC3339))
	return nil
}

// pushAll sends one signed, attested push to every selected replica at once. -> outcomes, and an error unless at least
// one replica accepted and none refused (a refusal is a policy answer: the guest must not ask the CA to validate).
func (i *appZoneIssuer) pushAll(ctx context.Context, op, value string, g bootstrap.NameGrant, lease appLease, ord appOrder) ([]replicaOutcome, error) {
	p := appPush{V: 2, Op: op, Name: "_acme-challenge." + i.name, Value: value, Deployment: "0x" + hex.EncodeToString(g.Deployment[:]),
		Owner: g.Owner, Lease: lease, Order: ord, TS: i.now().Unix(), SPKI: base64.StdEncoding.EncodeToString(i.spki)}
	doc, err := i.attest(appPushNonce(p))
	if err != nil {
		return nil, fmt.Errorf("attestation for the push: %w", err)
	}
	p.Attestation = doc
	body, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(append([]byte(appPushSigPrefix), body...))
	sig, err := i.signer.Sign(rand.Reader, digest[:], crypto.SHA256)
	if err != nil {
		return nil, err
	}
	method := http.MethodPost
	if op == "delete" {
		method = http.MethodDelete
	}
	out := make([]replicaOutcome, len(i.cfg.Challenges))
	var wg sync.WaitGroup
	for k, replica := range i.cfg.Challenges {
		wg.Add(1)
		go func(k int, replica string) {
			defer wg.Done()
			out[k] = replicaOutcome{Replica: replica}
			rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(rctx, method, strings.TrimRight(replica, "/")+appChallengePath, bytes.NewReader(body))
			if err != nil {
				out[k].Detail = bounded(err.Error(), 120)
				return
			}
			req.Header.Set("content-type", "application/json")
			req.Header.Set("x-attested-sig", base64.StdEncoding.EncodeToString(sig))
			res, err := i.httpc.Do(req)
			if err != nil {
				out[k].Detail = bounded(err.Error(), 120)
				return
			}
			defer res.Body.Close()
			b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
			out[k].Status = res.StatusCode
			if res.StatusCode != http.StatusOK {
				out[k].Detail = bounded(strings.TrimSpace(string(b)), 160)
			}
		}(k, replica)
	}
	wg.Wait()
	accepted, refused := 0, []string{}
	for _, o := range out {
		switch {
		case o.Status == http.StatusOK:
			accepted++
		case o.Status == http.StatusForbidden || o.Status == http.StatusUnauthorized || o.Status == http.StatusConflict || o.Status == http.StatusBadRequest:
			refused = append(refused, o.Replica+": "+o.Detail)
		}
	}
	if op == "delete" {
		return out, nil
	}
	if len(refused) > 0 {
		return out, fmt.Errorf("challenge replica refused (%s)", bounded(strings.Join(refused, "; "), 200))
	}
	if accepted == 0 {
		return out, errors.New("no challenge replica accepted the push")
	}
	return out, nil
}

func (i *appZoneIssuer) status() map[string]any {
	i.mu.Lock()
	st, last, revoked := i.st, append([]replicaOutcome(nil), i.last...), i.revoked
	i.mu.Unlock()
	out := map[string]any{"version": 1, "name": i.name, "mode": "in-guest ACME dns-01 through owner-selected challenge replicas",
		"directory": i.cfg.Directory, "challenges": i.cfg.Challenges, "eab": i.cfg.EAB != nil, "issuedThisBoot": st.issued,
		"proof": "each replica answers only after its own chain read shows this deployment's current lease, an active registry host and a catalog verdict that allows it; the CA validates through the zone's name servers",
		"limits": []string{"the zone's registrar/NS delegation and the public CA remain external dependencies of WebPKI; the attested native path needs neither",
			"the TLS key lives only in this guest's memory, so every relaunch needs a new certificate"}}
	if revoked != "" {
		out["revoked"] = revoked
	}
	if !st.lastAttempt.IsZero() {
		out["lastAttempt"] = st.lastAttempt.UTC().Format(time.RFC3339)
	}
	if st.lastError != "" {
		out["lastError"] = st.lastError
	}
	if !st.nextAttempt.IsZero() {
		out["nextAttempt"] = st.nextAttempt.UTC().Format(time.RFC3339)
	}
	if len(last) > 0 {
		out["lastPush"] = last
	}
	if leaf := i.certs.current(); leaf != nil {
		out["certificate"] = &nameCert{Issuer: leaf.Issuer.CommonName, Serial: leaf.SerialNumber.Text(16),
			NotBefore: leaf.NotBefore.UTC().Format(time.RFC3339), NotAfter: leaf.NotAfter.UTC().Format(time.RFC3339), RenewAt: renewAt(leaf).UTC().Format(time.RFC3339)}
	}
	return out
}

func (i *appZoneIssuer) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	if i == nil {
		http.Error(w, "this guest runs no in-guest app-zone issuance", http.StatusNotFound)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	_ = json.NewEncoder(w).Encode(i.status())
}

// startAppZone prepares the issuer for a direct guest (SEV-SNP, or an Enclave Shield partition: shield_direct.go) whose
// package selects app-zone issuance (started once the
// app serves, like owner names). Problems are printed and stated on the endpoint; they never stop the app, and a guest
// without the member keeps every existing certificate path (relay CSR install, owner names) unchanged.
func (f *front) startAppZone(o *ownerStartup, dial func() (net.Conn, error), roots *x509.CertPool) *appZoneIssuer {
	if o == nil || o.auth == nil || roots == nil {
		return nil
	}
	defer func() { o.appEabKey = nil }()
	if o.appEabErr != "" {
		fmt.Printf("DOM app-zone: in-guest issuance disabled (%s)\n", o.appEabErr)
		return nil
	}
	iss, err := newAppZoneIssuer(o.auth, f.certs, o.appEabKID, o.appEabKey, ownerHTTP(dial, roots), f.attestDocJSON, f.certs.key, f.spki)
	if err != nil {
		fmt.Printf("DOM app-zone: in-guest issuance not started (%v)\n", err)
		return nil
	}
	if iss != nil {
		fmt.Printf("DOM app-zone: in-guest issuance for %s through %d challenge replica(s)\n", iss.name, len(iss.cfg.Challenges))
	}
	return iss
}
