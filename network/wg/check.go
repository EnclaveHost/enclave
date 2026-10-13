package wg

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

// CheckInput is one qualification round for one provider, through the real WireGuard data path
// (docs/design/enclave-network.md, Qualification). The checker's own probe peers are granted by the provider.
type CheckInput struct {
	Exit struct {
		Peer      Peer   `json:"peer"`
		ProbeName string `json:"probeName"`
	} `json:"exit"`
	Guard *struct {
		Peer    Peer   `json:"peer"`
		Allowed string `json:"allowed"` // a provider port the guard must forward to (another exit's control port)
	} `json:"guard,omitempty"`
	PublicAddress string `json:"publicAddress"`
	ExitPort      int    `json:"exitPort"`
	OutboundURL   string `json:"outboundURL"`
	// SMTPTarget must ACCEPT on port 25 (a public mail exchanger), so a provider that does not block SMTP is caught:
	// the connection either succeeds or stalls, and both fail. A target that refuses by itself would prove nothing.
	SMTPTarget   string `json:"smtpTarget"`
	PayloadBytes int    `json:"payloadBytes"`
}

type CheckResult struct {
	Checks  map[string]bool   `json:"checks"`
	Details map[string]string `json:"details"`
}

func selfSigned(name string) (tls.Certificate, string, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	sum := sha256.Sum256(der)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}, hex.EncodeToString(sum[:]), nil
}

// refused: the dial must fail, and quickly (a reset or ICMP refusal, not a stall).
func refused(ctx context.Context, d *Device, to string, within time.Duration) (bool, string) {
	ap, err := netip.ParseAddrPort(to)
	if err != nil {
		return false, "bad target"
	}
	c, cancel := context.WithTimeout(ctx, within+2*time.Second)
	defer cancel()
	start := time.Now()
	conn, err := d.DialTCP(c, ap)
	if err == nil {
		conn.Close()
		return false, to + " connected"
	}
	if took := time.Since(start); took > within {
		return false, fmt.Sprintf("%s: no answer for %s (a refusal must be prompt)", to, took.Round(time.Millisecond))
	}
	return true, ""
}

// RunCheck performs every check; a check that cannot be performed is a failure, never a pass.
func RunCheck(in CheckInput) CheckResult {
	res := CheckResult{Checks: map[string]bool{}, Details: map[string]string{}}
	for _, c := range []string{"tcp80", "tcp443", "udpEcho", "outboundHttps", "payloadIntegrity", "blocksPrivateDestinations", "blocksOwnAddresses", "blocksSmtp", "rejectsUnauthorizedProxy"} {
		res.Checks[c] = false
	}
	note := func(k, v string) {
		if v != "" {
			res.Details[k] = strings.TrimSpace(res.Details[k] + " " + v)
		}
	}
	ctx := context.Background()
	if in.PayloadBytes <= 0 {
		in.PayloadBytes = 4 << 20
	}
	exit, err := Up(in.Exit.Peer, conn.NewDefaultBind(), nil)
	if err != nil {
		note("udpEcho", "exit tunnel: "+err.Error())
		return res
	}
	defer exit.Close()
	hctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err = exit.WaitHandshake(hctx)
	cancel()
	if err != nil {
		note("udpEcho", err.Error())
		return res
	}
	exitOK := true
	local, _ := exit.Local(false)

	// what visitors will reach through the provider's ingress: this checker's own listeners on its tunnel address
	cert, fp, err := selfSigned(in.Exit.ProbeName)
	if err != nil {
		note("tcp443", err.Error())
		return res
	}
	token := make([]byte, 16)
	rand.Read(token)
	tok := hex.EncodeToString(token)
	l443, err := exit.Net.ListenTCPAddrPort(netip.AddrPortFrom(local, 443))
	if err == nil {
		defer l443.Close()
		tl := tls.NewListener(l443, &tls.Config{Certificates: []tls.Certificate{cert}})
		go func() {
			for {
				c, err := tl.Accept()
				if err != nil {
					return
				}
				go func() { defer c.Close(); io.Copy(c, c) }()
			}
		}()
	}
	l80, err := exit.Net.ListenTCPAddrPort(netip.AddrPortFrom(local, 80))
	if err == nil {
		defer l80.Close()
		go http.Serve(l80, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, tok) }))
	}
	pub := in.PublicAddress
	// tcp80: plain HTTP from the public internet, routed by Host
	if c, err := net.DialTimeout("tcp", net.JoinHostPort(pub, "80"), 10*time.Second); err == nil {
		c.SetDeadline(time.Now().Add(15 * time.Second))
		fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", in.Exit.ProbeName)
		b, _ := io.ReadAll(io.LimitReader(c, 65536))
		c.Close()
		res.Checks["tcp80"] = bytes.Contains(b, []byte(tok))
		if !res.Checks["tcp80"] {
			note("tcp80", "the probe name's HTTP answer did not come back")
		}
	} else {
		note("tcp80", err.Error())
	}
	// tcp443 + payloadIntegrity: TLS from the public internet, routed by SNI, terminating at this checker
	if c, err := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", net.JoinHostPort(pub, "443"), &tls.Config{ServerName: in.Exit.ProbeName, InsecureSkipVerify: true}); err == nil {
		c.SetDeadline(time.Now().Add(60 * time.Second))
		got := c.ConnectionState().PeerCertificates
		sum := sha256.Sum256(got[0].Raw)
		if hex.EncodeToString(sum[:]) != fp {
			note("tcp443", "a different certificate answered: TLS did not reach the peer")
		} else {
			res.Checks["tcp443"] = true
			payload := make([]byte, in.PayloadBytes)
			rand.Read(payload)
			want := sha256.Sum256(payload)
			go c.Write(payload)
			back := make([]byte, len(payload))
			if _, err := io.ReadFull(c, back); err != nil {
				note("payloadIntegrity", err.Error())
			} else if sha256.Sum256(back) != want {
				note("payloadIntegrity", "payload changed in transit")
			} else {
				res.Checks["payloadIntegrity"] = true
			}
		}
		c.Close()
	} else {
		note("tcp443", err.Error())
	}
	// outboundHttps, through the egress; names through the tunnel's resolver
	client := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{DialContext: exit.Net.DialContext, TLSHandshakeTimeout: 10 * time.Second}}
	if r, err := client.Get(in.OutboundURL); err == nil {
		io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))
		r.Body.Close()
		res.Checks["outboundHttps"] = r.StatusCode < 400
		if r.StatusCode >= 400 {
			note("outboundHttps", fmt.Sprintf("HTTP %d", r.StatusCode))
		}
	} else {
		note("outboundHttps", err.Error())
	}
	// refusals through the tunnel: must be prompt (RST / ICMP), never a stall
	ok := true
	for _, t := range []string{"10.0.0.1:443", "172.16.0.1:443", "192.168.0.1:443", "169.254.169.254:80", "100.64.0.1:443", "10.77.0.1:51822"} {
		if r, why := refused(ctx, exit, t, 3*time.Second); !r {
			ok = false
			note("blocksPrivateDestinations", why)
		}
	}
	res.Checks["blocksPrivateDestinations"] = ok
	ok = true
	for _, port := range []string{"80", "443", "22", fmt.Sprint(in.ExitPort + 2)} {
		if r, why := refused(ctx, exit, net.JoinHostPort(pub, port), 3*time.Second); !r {
			ok = false
			note("blocksOwnAddresses", why)
		}
	}
	res.Checks["blocksOwnAddresses"] = ok
	if in.SMTPTarget == "" {
		note("blocksSmtp", "no SMTP target to test against")
	} else if r, why := refused(ctx, exit, in.SMTPTarget, 3*time.Second); r {
		res.Checks["blocksSmtp"] = true
	} else {
		note("blocksSmtp", why)
	}
	// rejectsUnauthorizedProxy: an unregistered key gets no handshake; an unknown name gets no service; the guard
	// forwards only to providers
	unauth := true
	k1 := randomKey()
	stranger, err := Up(Peer{PrivateKey: k1, PublicKey: in.Exit.Peer.PublicKey, Endpoint: in.Exit.Peer.Endpoint, Addresses: []netip.Addr{netip.MustParseAddr("10.77.255.254")}, Keepalive: 1}, conn.NewDefaultBind(), nil)
	if err == nil {
		sctx, cancel := context.WithTimeout(ctx, 6*time.Second)
		if stranger.WaitHandshake(sctx) == nil {
			unauth = false
			note("rejectsUnauthorizedProxy", "an unregistered key completed a handshake")
		}
		cancel()
		stranger.Close()
	} else {
		unauth = false
		note("rejectsUnauthorizedProxy", err.Error())
	}
	if c, err := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", net.JoinHostPort(pub, "443"), &tls.Config{ServerName: "unknown-" + tok[:8] + ".example.org", InsecureSkipVerify: true}); err == nil {
		c.Close()
		unauth = false
		note("rejectsUnauthorizedProxy", "an unknown name was served")
	}
	if in.Guard != nil {
		g, err := Up(in.Guard.Peer, conn.NewDefaultBind(), nil)
		if err != nil {
			unauth = false
			note("udpEcho", "guard tunnel: "+err.Error())
			exitOK = false
		} else {
			gctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			if err := g.WaitHandshake(gctx); err != nil {
				exitOK = false
				note("udpEcho", "guard: "+err.Error())
			} else {
				if r, why := refused(ctx, g, "1.1.1.1:443", 3*time.Second); !r {
					unauth = false
					note("rejectsUnauthorizedProxy", "guard: "+why)
				}
				if in.Guard.Allowed != "" {
					ap, err := netip.ParseAddrPort(in.Guard.Allowed)
					if err == nil {
						actx, cancel2 := context.WithTimeout(ctx, 10*time.Second)
						c, err := g.DialTCP(actx, ap)
						cancel2()
						if err != nil {
							exitOK = false
							note("udpEcho", "guard does not reach provider "+in.Guard.Allowed+": "+err.Error())
						} else {
							c.Close()
						}
					}
				}
			}
			cancel()
			g.Close()
		}
	}
	res.Checks["rejectsUnauthorizedProxy"] = unauth
	res.Checks["udpEcho"] = exitOK
	return res
}

func randomKey() Key {
	var k Key
	rand.Read(k[:])
	k[0] &= 248
	k[31] = (k[31] & 127) | 64
	return k
}
