// flowsim: the app's front (the real tunnel.go / tunnel_flow.go) behind a lossy, delayed path, as the edge reaches it.
//
//	app (a video source on UDP 47998) -> front (TLS, port tunnels) -> tunnel stack A (the host's enclave-wg: gVisor,
//	tuned as network/wg/tune.go) -> link (delay, loss) -> stack B -> a TCP relay on 127.0.0.1 (the provider's router)
//
// The edge gateway under test connects to the relay. Run inside its own network namespace.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	mrand "math/rand"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func link(from, to tun.Device, delay time.Duration, loss float64, seed int64, burst int) {
	type pkt struct {
		at time.Time
		b  []byte
	}
	q := make(chan pkt, 1<<16)
	go func() {
		bufs, sizes := [][]byte{make([]byte, 2048)}, []int{0}
		r := mrand.New(mrand.NewSource(seed))
		left := 0
		for {
			n, err := from.Read(bufs, sizes, 0)
			if err != nil {
				return
			}
			for i := 0; i < n; i++ {
				// burst > 1: a loss takes that many packets in a row (the same average loss)
				if left > 0 {
					left--
					continue
				}
				if loss > 0 && r.Float64() < loss/float64(burst) {
					left = burst - 1
					continue
				}
				q <- pkt{time.Now().Add(delay), append([]byte(nil), bufs[i][:sizes[i]]...)}
			}
		}
	}()
	go func() {
		for p := range q {
			if d := time.Until(p.at); d > 0 {
				time.Sleep(d)
			}
			to.Write([][]byte{p.b}, 0)
		}
	}()
}

func selfSigned() tls.Certificate {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "desk.app.test"}, DNSNames: []string{"desk.app.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func main() {
	delay := flag.Duration("delay", 12500*time.Microsecond, "one-way delay of the path")
	loss := flag.Float64("loss", 0.01, "loss from the host to the edge")
	back := flag.Float64("back", 0.003, "loss from the edge to the host")
	burst := flag.Int("burst", 1, "packets a loss takes in a row")
	relay := flag.Int("relay", 18443, "TCP port of the relay on 127.0.0.1")
	fps := flag.Int("fps", 60, "frames per second")
	kbps := flag.Int("kbps", 5000, "video bitrate including parity")
	stall := flag.Duration("stall", 0, "every 10 s the path carries nothing for this long")
	spill := flag.Duration("spill", flowDefaults.spill, "flow tuning")
	hedge := flag.Duration("hedge", flowDefaults.hedge, "flow tuning")
	late := flag.Duration("late", flowDefaults.late, "flow tuning")
	parity := flag.Int("parity", flowDefaults.parity, "flow tuning: data frames per parity frame (0: none)")
	flag.Parse()

	a4, b4 := netip.MustParseAddr("10.9.0.2"), netip.MustParseAddr("10.9.0.1")
	da, na, err := netstack.CreateNetTUN([]netip.Addr{a4}, nil, 1340)
	must(err)
	db, nb, err := netstack.CreateNetTUN([]netip.Addr{b4}, nil, 1340)
	must(err)
	must(TuneTCP(na))
	must(TuneTCP(nb))
	var blocked atomic.Bool
	if *stall > 0 {
		go func() {
			for {
				time.Sleep(10 * time.Second)
				blocked.Store(true)
				time.Sleep(*stall)
				blocked.Store(false)
			}
		}()
	}
	link(gate{da, &blocked}, db, *delay, *loss, 1, *burst)
	link(gate{db, &blocked}, da, *delay, *back, 2, *burst)

	// the app: HTTP on 47989 (what names the app at the gateway) and the video source on 47998
	hl, err := net.Listen("tcp", "127.0.0.1:47989")
	must(err)
	go http.Serve(hl, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("serverinfo")) }))
	u, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 47998})
	must(err)
	var sentPackets, sentFrames atomic.Uint64
	go video(u, *fps, *kbps, &sentPackets, &sentFrames)

	// the front
	p := &portTunnels{allowed: map[string]bool{"tcp:47989": true, "udp:47998": true}, active: map[string]int{}}
	p.flowTune = flowTuning{spill: *spill, hedge: *hedge, late: *late, startup: flowDefaults.startup, dead: flowDefaults.dead, parity: *parity}
	fl, err := na.ListenTCPAddrPort(netip.AddrPortFrom(a4, 443))
	must(err)
	srv := &http.Server{Handler: p, TLSConfig: &tls.Config{Certificates: []tls.Certificate{selfSigned()}}}
	go srv.ServeTLS(fl, "", "")

	// the relay: each connection is carried to the front's 443 through the edge's stack
	rl, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *relay))
	must(err)
	go func() {
		for {
			c, err := rl.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				c.(*net.TCPConn).SetNoDelay(true)
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				up, err := nb.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(a4, 443))
				cancel()
				if err != nil {
					return
				}
				defer up.Close()
				var wg sync.WaitGroup
				wg.Add(2)
				go func() { defer wg.Done(); io.Copy(up, c); up.Close() }()
				go func() { defer wg.Done(); io.Copy(c, up); c.Close() }()
				wg.Wait()
			}()
		}
	}()
	fmt.Println("ready")
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	out := map[string]any{"packets": sentPackets.Load(), "frames": sentFrames.Load(), "tcp": TCPCounters(na)}
	p.mu.Lock()
	for _, f := range p.flows {
		out["flow"] = f.snapshot()
	}
	p.mu.Unlock()
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}

// gate: a device whose packets are discarded while the path is blocked
type gate struct {
	tun.Device
	blocked *atomic.Bool
}

func (g gate) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	for {
		n, err := g.Device.Read(bufs, sizes, offset)
		if err != nil || !g.blocked.Load() {
			return n, err
		}
	}
}

// video waits for the client's first datagram, then sends frames: each packet is 1392 bytes and says its frame,
// its place in the frame, how many the frame has, how many of those are data (the rest parity, one in six), and
// when the frame was made.
func video(u *net.UDPConn, fps, kbps int, packets, frames *atomic.Uint64) {
	b := make([]byte, 2048)
	_, peer, err := u.ReadFromUDP(b)
	if err != nil {
		return
	}
	go func() {
		for {
			if _, _, err := u.ReadFromUDP(b); err != nil {
				return
			}
		}
	}()
	const size = 1392
	per := float64(kbps) * 1000 / 8 / float64(fps) / size
	start := time.Now()
	var carry float64
	for f := uint32(0); ; f++ {
		if d := time.Until(start.Add(time.Duration(f) * time.Second / time.Duration(fps))); d > 0 {
			time.Sleep(d)
		}
		carry += per
		n := int(carry)
		carry -= float64(n)
		if n < 2 {
			n = 2
		}
		// every tenth second a key frame, eight times the size
		if f%uint32(fps*10) == 0 {
			n *= 8
		}
		data := n - n/6
		now := time.Now().UnixNano()
		for i := 0; i < n; i++ {
			// an RTP header first (version 2, a running sequence number, the frame's time at 90 kHz), as Sunshine's
			// video has, so that the gateway's own lag meter can be held against what the receiver measures
			pk := make([]byte, size)
			pk[0] = 0x80
			binary.BigEndian.PutUint16(pk[2:], uint16(packets.Load()))
			binary.BigEndian.PutUint32(pk[4:], f*uint32(90000/fps))
			binary.BigEndian.PutUint32(pk[12:], f)
			binary.BigEndian.PutUint16(pk[16:], uint16(i))
			binary.BigEndian.PutUint16(pk[18:], uint16(n))
			binary.BigEndian.PutUint16(pk[20:], uint16(data))
			binary.BigEndian.PutUint64(pk[22:], uint64(now))
			u.WriteToUDP(pk, peer)
			packets.Add(1)
		}
		frames.Add(1)
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
