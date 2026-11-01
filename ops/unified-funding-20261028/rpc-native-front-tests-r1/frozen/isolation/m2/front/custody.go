package main

// custody: the secrets of a deployment whose owner moved them to custodians (docs/security/secret-custody.md). The relay's
// signed release then carries the deployment's config and a POINTER to its custody state, never secret values; this file
// fetches the values from a threshold of custodians (isolation/m2/custody) under a fresh attestation, and the lease
// holder's operator authorizes the release over guestd's custody-auth port.
//
// Two pointer versions (release.Custody.Version): v1 (a per-deployment committee of shares, custody.Client.Obtain) and v2
// (one committee key held by host custodian machines, partial decryptions verified one by one, and the Enclave rule:
// custody.Client.ObtainV2; docs/security/secret-custody-v2-spec.md §4). A v2 custodian endpoint may carry a path prefix
// (custodianEndpointV2); only its host is dialled through the egress path.
//
// Fail closed, everywhere: a custody deployment whose release ALSO carries relay-held secrets, an image whose AppID is not
// derived from its loaded code, a pointer that does not parse, a quorum that does not answer: each ends the domain, and
// init never starts the app without its secrets.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/custody"
	"enclave.host/isolation/m2/egress"
	"enclave.host/isolation/m2/release"
)

// custodyWindow bounds the whole custody release (challenges, report, authorization, shares).
var custodyWindow = 3 * time.Minute

func custodyState(id [32]byte, c *release.Custody) (custody.State, error) {
	var st custody.State
	st.ID = id
	st.Ctx.ChainID = c.ChainID
	v, err := hex.DecodeString(strings.TrimPrefix(c.Vault, "0x"))
	if err != nil || len(v) != 20 || c.ChainID == 0 {
		return st, errors.New("the custody pointer names no vault")
	}
	copy(st.Ctx.Vault[:], v)
	if st.PolicyRev, err = strconv.ParseUint(c.PolicyRev, 10, 64); err != nil {
		return st, errors.New("the custody pointer's policy revision is not a number")
	}
	if st.SecretRev, err = strconv.ParseUint(c.SecretRev, 10, 64); err != nil {
		return st, errors.New("the custody pointer's secret revision is not a number")
	}
	st.Epoch, st.Threshold = c.Epoch, c.Threshold
	if st.C0, err = hex.DecodeString(strings.TrimPrefix(c.C0, "0x")); err != nil {
		return st, errors.New("the custody pointer's commitment is not hex")
	}
	if st.Ciphertext, err = base64.StdEncoding.DecodeString(c.Ciphertext); err != nil {
		return st, errors.New("the custody pointer's ciphertext is not base64")
	}
	for i, m := range c.Members {
		k, err := hex.DecodeString(m.EncKey)
		if err != nil || len(k) != 32 {
			return st, fmt.Errorf("custodian %d has no key", i)
		}
		// a custodian is an https origin on port 443, reached through the egress path like the relay
		if _, err := egress.ParseOrigin(m.Endpoint); err != nil {
			return st, fmt.Errorf("custodian %d's endpoint: %w", i, err)
		}
		var mk [32]byte
		copy(mk[:], k)
		st.Members = append(st.Members, custody.Member{EncKey: mk, Endpoint: strings.TrimRight(m.Endpoint, "/")})
	}
	return st, nil
}

// custodianEndpointV2 checks a v2 custodian's endpoint: an https URL whose authority is an origin v1 accepts (a DNS name,
// port 443 only, no userinfo or percent-escapes: egress.ParseOrigin) and an optional path prefix of at most 4 segments of
// [A-Za-z0-9._~-] (no "." or ".." segment, no query, fragment, backslash or escapes). The custodian VM may sit behind the
// relay's fleet tunnel (https://api.enclave.host/t/custody-metal0); the API paths are appended. A single trailing "/" is
// dropped. Returns the base URL to append to, and the host to dial through the egress path.
func custodianEndpointV2(raw string) (base, host string, err error) {
	if !strings.HasPrefix(raw, "https://") {
		return "", "", errors.New("not an https:// URL")
	}
	rest := raw[len("https://"):]
	cut := strings.IndexAny(rest, "/?#\\")
	origin, path := raw, ""
	if cut >= 0 {
		origin, path = raw[:len("https://")+cut], rest[cut:]
	}
	o, err := egress.ParseOrigin(origin)
	if err != nil {
		return "", "", err
	}
	path = strings.TrimSuffix(path, "/")
	if !custodianPathRE.MatchString(path) {
		return "", "", errors.New("the path prefix is not at most 4 segments of [A-Za-z0-9._~-]")
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "." || seg == ".." || strings.Contains(seg, "..") {
			return "", "", errors.New("a dot segment in the path prefix")
		}
	}
	return "https://" + o.Host + path, o.Host, nil
}

var custodianPathRE = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+){0,4}$`)

func custodyStateV2(id [32]byte, c *release.Custody) (custody.StateV2, error) {
	var st custody.StateV2
	p, err := c.V2()
	if err != nil {
		return st, err
	}
	st.ID, st.Ctx = id, custody.Context{ChainID: p.ChainID, Vault: p.Vault}
	st.CommitteeID, st.PolicyRev, st.SecretRev, st.Epoch, st.Threshold, st.Bundle = p.CommitteeID, p.PolicyRev, p.SecretRev, p.Epoch, p.T, p.Bundle
	if st.Commitments, err = custody.SplitCommitmentsV2(p.Commitments, p.T); err != nil {
		return st, fmt.Errorf("the custody pointer's %w", err)
	}
	for i, m := range p.Machines {
		base, _, err := custodianEndpointV2(m.Endpoint)
		if err != nil {
			return st, fmt.Errorf("custodian machine %d's endpoint: %w", i, err)
		}
		st.Machines = append(st.Machines, custody.MachineV2{EncKey: m.EncKey, Endpoint: base, Enclave: m.Enclave, Indices: m.Indices})
	}
	return st, nil
}

// post runs one JSON POST to a custodian through the egress path, TLS with the image's pinned roots and the custodian's
// own name. TLS here guards availability only: every share is sealed end to end to this guest's recipient key. The URL's
// path (a v2 custodian's prefix plus the API path) is sent as is; only its host is dialled.
func (p *provisioner) custodyPost(ctx context.Context, raw string, body, out any) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	host := u.Hostname()
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			return egress.DialOrigin(p.egress, egress.Origin{Host: host})
		},
		TLSClientConfig:    &tls.Config{ServerName: host, RootCAs: p.roots, MinVersion: tls.VersionTLS12},
		DisableKeepAlives:  true,
		DisableCompression: true,
	}
	defer tr.CloseIdleConnections()
	hc := &http.Client{Transport: tr, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, raw, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	res, err := hc.Do(req)
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

// authorize asks the host (guestd -> the supervisor -> the lease holder's operator key) to sign this release.
func (p *provisioner) authorize(ctx context.Context, id, binding [32]byte) (string, string, int64, error) {
	c, err := p.custodyAuth()
	if err != nil {
		return "", "", 0, fmt.Errorf("the host's custody authorization service: %w", err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := release.WriteAuthRequest(c, id, binding); err != nil {
		return "", "", 0, err
	}
	a, err := release.ReadAuth(c)
	if err != nil {
		return "", "", 0, err
	}
	return a.Endpoint, a.Sig, a.Expiry, nil
}

// authorizeV2 is authorize for a v2 release: the request names the vault, which the supervisor signs for only if it is
// the v2 vault it was measured with.
func (p *provisioner) authorizeV2(ctx context.Context, vault [20]byte, id, binding [32]byte) (string, string, int64, error) {
	c, err := p.custodyAuth()
	if err != nil {
		return "", "", 0, fmt.Errorf("the host's custody authorization service: %w", err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := release.WriteAuthRequestV2(c, vault, id, binding); err != nil {
		return "", "", 0, err
	}
	a, err := release.ReadAuth(c)
	if err != nil {
		return "", "", 0, err
	}
	return a.Endpoint, a.Sig, a.Expiry, nil
}

// custodySecrets obtains the values and refuses them unless `configText` (the config they are about to be substituted into,
// as the relay delivered it) is the one the OWNER committed inside the bundle: the relay chooses neither where a value goes
// nor, since the allowlist is derived from the resolved config, where the app may send it (review H2).
func (p *provisioner) custodySecrets(ctx context.Context, ptr *release.Custody, id [32]byte, spki []byte, rt *runtimeState, appSha []byte, configText string) (map[string]string, error) {
	if !p.appFromCode {
		return nil, errors.New("custody releases need an AppID derived from the loaded code, and this image does not carry /app.wasm")
	}
	if p.custodyAuth == nil {
		return nil, errors.New("this front has no custody authorization channel")
	}
	ver, err := ptr.Version()
	if err != nil {
		return nil, err
	}
	rtJSON, err := json.Marshal(rt.ID)
	if err != nil {
		return nil, err
	}
	cl := &custody.Client{
		Post:          p.custodyPost,
		Authorize:     p.authorize,
		AuthorizeV2:   p.authorizeV2,
		RuntimeID:     rt.RID,
		TransportSPKI: spki,
		Logf:          p.logf,
		Evidence: func(binding [32]byte) (json.RawMessage, error) {
			rd := make([]byte, 64)
			copy(rd, binding[:])
			copy(rd[32:], appSha) // this front's half, from the loaded code; the custody package never writes it
			rep, certs, err := p.report(rd)
			if err != nil {
				return nil, err
			}
			ev := release.Evidence{Format: contract.FormatSNP, Abi: contract.ABI2, Runtime: rtJSON,
				TransportKey: base64.StdEncoding.EncodeToString(spki), Report: base64.StdEncoding.EncodeToString(rep)}
			if len(certs) > 0 {
				ev.Certs = base64.StdEncoding.EncodeToString(certs)
			}
			return json.Marshal(ev)
		},
	}
	cctx, cancel := context.WithTimeout(ctx, custodyWindow)
	defer cancel()
	var b *custody.Bundle
	var rev uint64
	var what string
	switch ver {
	case 2:
		st, err := custodyStateV2(id, ptr)
		if err != nil {
			return nil, err
		}
		if b, err = cl.ObtainV2(cctx, st); err != nil {
			return nil, fmt.Errorf("custody: %w", err)
		}
		rev, what = st.SecretRev, fmt.Sprintf("a v2 threshold of %d over %d custodian machines", st.Threshold, len(st.Machines))
	default:
		st, err := custodyState(id, ptr)
		if err != nil {
			return nil, err
		}
		if b, err = cl.Obtain(cctx, st); err != nil {
			return nil, fmt.Errorf("custody: %w", err)
		}
		rev, what = st.SecretRev, fmt.Sprintf("a threshold of %d of %d custodians", st.Threshold, len(st.Members))
	}
	if got := sha256.Sum256([]byte(configText)); hex.EncodeToString(got[:]) != b.ConfigSha256 {
		return nil, fmt.Errorf("custody: the delivered config (sha256 %x...) is not the one the owner committed (%.16s...): its values are not substituted into it", got[:8], b.ConfigSha256)
	}
	env := b.Env
	p.logf("DOM custody: deployment 0x%x... secrets revision %d from %s, %d name(s)", id[:4], rev, what, len(env))
	return env, nil
}
