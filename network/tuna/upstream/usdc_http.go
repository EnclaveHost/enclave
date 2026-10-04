package tuna

// Authenticated local controller bridge. Unix sockets keep the host's signing
// keys outside guarded workers; loopback HTTP supports Windows runtimes.
import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type USDCLocalConfig struct {
	PricePerGiB6 string `json:"pricePerGiB6,omitempty"`
	Socket       string `json:"socket,omitempty"`
	Endpoint     string `json:"endpoint,omitempty"`
	TokenFile    string `json:"tokenFile"`
	DeploymentID string `json:"deploymentId,omitempty"`
	ProviderID   string `json:"providerId,omitempty"`
}
type httpUSDCController struct {
	client          *http.Client
	endpoint, token string
	config          USDCLocalConfig
}
type httpUSDCSession struct {
	controller *httpUSDCController
	id         string
}

func NewLocalUSDCController(config USDCLocalConfig) (USDCController, error) {
	if !filepath.IsAbs(config.TokenFile) {
		return nil, errors.New("absolute USDC controller token file required")
	}
	st, err := os.Stat(config.TokenFile)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private USDC token permissions required")
	}
	token, err := os.ReadFile(config.TokenFile)
	if err != nil {
		return nil, err
	}
	auth := strings.TrimSpace(string(token))
	if len(auth) != 64 || strings.Trim(auth, "0123456789abcdef") != "" {
		return nil, errors.New("invalid USDC controller token")
	}
	transport := &http.Transport{MaxIdleConns: 16, MaxIdleConnsPerHost: 16, IdleConnTimeout: 30 * time.Second}
	endpoint := config.Endpoint
	if config.Socket != "" {
		if !filepath.IsAbs(config.Socket) || endpoint != "" {
			return nil, errors.New("one absolute USDC controller socket required")
		}
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", config.Socket)
		}
		endpoint = "http://local.usdc/"
	} else {
		u, e := url.Parse(endpoint)
		if e != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
			return nil, errors.New("USDC controller must use a local socket or literal loopback HTTP")
		}
	}
	return &httpUSDCController{client: &http.Client{Transport: transport, Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("USDC controller redirect refused") }}, endpoint: endpoint, token: auth, config: config}, nil
}
func (c *httpUSDCController) call(ctx context.Context, action, session string, body any) (json.RawMessage, error) {
	raw, err := json.Marshal(struct {
		Action  string `json:"action"`
		Session string `json:"session,omitempty"`
		Body    any    `json:"body"`
	}{action, session, body})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	res, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxUSDCMessage+1))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 || len(b) > maxUSDCMessage || !json.Valid(b) {
		return nil, errors.New("USDC controller rejected operation")
	}
	return b, nil
}
func (c *httpUSDCController) Open(ctx context.Context, t USDCTranscript, peer json.RawMessage) (USDCSession, json.RawMessage, error) {
	b, err := c.call(ctx, "open", "", struct {
		Transcript   USDCTranscript  `json:"transcript"`
		Proof        json.RawMessage `json:"proof"`
		DeploymentID string          `json:"deploymentId,omitempty"`
		ProviderID   string          `json:"providerId,omitempty"`
	}{t, peer, c.config.DeploymentID, c.config.ProviderID})
	if err != nil {
		return nil, nil, err
	}
	var result struct {
		Session string          `json:"session"`
		Proof   json.RawMessage `json:"proof"`
	}
	if err = json.Unmarshal(b, &result); err != nil || result.Session == "" {
		return nil, nil, errors.New("invalid USDC session")
	}
	return &httpUSDCSession{controller: c, id: result.Session}, result.Proof, nil
}
func (s *httpUSDCSession) Confirm(ctx context.Context, proof json.RawMessage) error {
	_, e := s.controller.call(ctx, "confirm", s.id, proof)
	return e
}
func (s *httpUSDCSession) Reserve(ctx context.Context, d string, n int) (string, error) {
	b, e := s.controller.call(ctx, "reserve", s.id, struct {
		Direction string `json:"direction"`
		Bytes     int    `json:"bytes"`
	}{d, n})
	if e != nil {
		return "", e
	}
	var v struct {
		Ticket string `json:"ticket"`
	}
	e = json.Unmarshal(b, &v)
	if e == nil && v.Ticket == "" {
		e = errors.New("USDC credit reservation missing")
	}
	return v.Ticket, e
}
func (s *httpUSDCSession) Commit(ctx context.Context, t string, n int) error {
	_, e := s.controller.call(ctx, "commit", s.id, struct {
		Ticket string `json:"ticket"`
		Bytes  int    `json:"bytes"`
	}{t, n})
	return e
}
func (s *httpUSDCSession) Remote(ctx context.Context, b json.RawMessage) (json.RawMessage, error) {
	return s.controller.call(ctx, "remote", s.id, b)
}
func (s *httpUSDCSession) Next(ctx context.Context) (string, json.RawMessage, error) {
	b, e := s.controller.call(ctx, "next", s.id, nil)
	if e != nil {
		return "", nil, e
	}
	var v struct {
		ID      string          `json:"id"`
		Request json.RawMessage `json:"request"`
	}
	e = json.Unmarshal(b, &v)
	return v.ID, v.Request, e
}
func (s *httpUSDCSession) Reply(ctx context.Context, id string, b json.RawMessage) error {
	_, e := s.controller.call(ctx, "reply", s.id, struct {
		ID       string          `json:"id"`
		Response json.RawMessage `json:"response"`
	}{id, b})
	return e
}
func (s *httpUSDCSession) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, e := s.controller.call(ctx, "close", s.id, nil)
	return e
}
