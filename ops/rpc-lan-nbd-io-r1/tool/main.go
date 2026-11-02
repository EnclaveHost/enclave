// nbdbench measures read latency/throughput of one read-only NBD export over
// TLS 1.3 mTLS, the transport the RPC guest would use. It only issues
// NBD_CMD_READ (and DISC); the server export is also read-only.
//
// nbdbench -addr IP:PORT -export NAME -server-name NAME -ca F -cert F -key F
//
//	-offsets F -label L -seq-start N -seq-len N
//
// The offsets file holds big-endian uint64 4KiB-aligned offsets sampled from
// allocated extents, so reads hit real data rather than unallocated zeros.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"time"
)

const (
	optMagic   = 0x49484156454f5054
	replyMagic = 0x0003e889045565a9
	reqMagic   = 0x25609513
	simpleRep  = 0x67446698
)

func writeOpt(w io.Writer, opt uint32, data []byte) error {
	b := binary.BigEndian.AppendUint64(nil, optMagic)
	b = binary.BigEndian.AppendUint32(b, opt)
	b = binary.BigEndian.AppendUint32(b, uint32(len(data)))
	_, err := w.Write(append(b, data...))
	return err
}

func readRep(r io.Reader) (uint32, []byte, error) {
	var h [20]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	if binary.BigEndian.Uint64(h[0:]) != replyMagic {
		return 0, nil, errors.New("bad option reply magic")
	}
	n := binary.BigEndian.Uint32(h[16:])
	if n > 65536 {
		return 0, nil, errors.New("oversized option reply")
	}
	d := make([]byte, n)
	_, err := io.ReadFull(r, d)
	return binary.BigEndian.Uint32(h[12:]), d, err
}

func connect(addr, export, serverName string, cfg *tls.Config) (*tls.Conn, uint64, error) {
	raw, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return nil, 0, err
	}
	raw.SetDeadline(time.Now().Add(10 * time.Second))
	var hs [18]byte
	if _, err = io.ReadFull(raw, hs[:]); err != nil {
		return nil, 0, err
	}
	if string(hs[:8]) != "NBDMAGIC" || binary.BigEndian.Uint64(hs[8:]) != optMagic || binary.BigEndian.Uint16(hs[16:])&1 == 0 {
		return nil, 0, errors.New("not fixed-newstyle NBD")
	}
	raw.Write(binary.BigEndian.AppendUint32(nil, 3)) // FIXED_NEWSTYLE | NO_ZEROES
	if err = writeOpt(raw, 5, nil); err != nil {     // STARTTLS
		return nil, 0, err
	}
	if typ, _, err := readRep(raw); err != nil || typ != 1 {
		return nil, 0, fmt.Errorf("STARTTLS refused %x %v", typ, err)
	}
	c := tls.Client(raw, cfg)
	if err = c.Handshake(); err != nil {
		return nil, 0, err
	}
	data := binary.BigEndian.AppendUint32(nil, uint32(len(export)))
	data = append(data, export...)
	data = binary.BigEndian.AppendUint16(data, 0)
	if err = writeOpt(c, 7, data); err != nil { // GO
		return nil, 0, err
	}
	var size uint64
	for {
		typ, d, err := readRep(c)
		if err != nil {
			return nil, 0, err
		}
		if typ == 3 { // NBD_REP_INFO; only NBD_INFO_EXPORT carries the size
			if len(d) == 12 && binary.BigEndian.Uint16(d) == 0 {
				size = binary.BigEndian.Uint64(d[2:])
			}
			continue
		}
		if typ == 1 {
			break
		}
		return nil, 0, fmt.Errorf("NBD_OPT_GO refused %x", typ)
	}
	raw.SetDeadline(time.Time{})
	return c, size, nil
}

func sendRead(w io.Writer, handle, off uint64, n uint32) error {
	b := binary.BigEndian.AppendUint32(nil, reqMagic)
	b = binary.BigEndian.AppendUint16(b, 0)
	b = binary.BigEndian.AppendUint16(b, 0) // NBD_CMD_READ
	b = binary.BigEndian.AppendUint64(b, handle)
	b = binary.BigEndian.AppendUint64(b, off)
	b = binary.BigEndian.AppendUint32(b, n)
	_, err := w.Write(b)
	return err
}

func readReply(r io.Reader, buf []byte) (uint64, error) {
	var h [16]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, err
	}
	if binary.BigEndian.Uint32(h[0:]) != simpleRep || binary.BigEndian.Uint32(h[4:]) != 0 {
		return 0, fmt.Errorf("read error reply %x", h)
	}
	_, err := io.ReadFull(r, buf)
	return binary.BigEndian.Uint64(h[8:]), err
}

type stats struct {
	Phase       string  `json:"phase"`
	Ops         int     `json:"ops"`
	Seconds     float64 `json:"seconds"`
	IOPS        float64 `json:"iops"`
	MBps        float64 `json:"MBps"`
	MeanUs      float64 `json:"meanUs,omitempty"`
	P50Us       float64 `json:"p50Us,omitempty"`
	P90Us       float64 `json:"p90Us,omitempty"`
	P99Us       float64 `json:"p99Us,omitempty"`
	MaxUs       float64 `json:"maxUs,omitempty"`
	QueueDepth  int     `json:"queueDepth"`
	RequestSize int     `json:"requestBytes"`
}

func summarize(phase string, lat []time.Duration, elapsed time.Duration, qd, size int) stats {
	s := stats{Phase: phase, Ops: len(lat), Seconds: elapsed.Seconds(), QueueDepth: qd, RequestSize: size}
	s.IOPS = float64(len(lat)) / elapsed.Seconds()
	s.MBps = s.IOPS * float64(size) / 1e6
	if len(lat) == 0 {
		return s
	}
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	var sum time.Duration
	for _, d := range lat {
		sum += d
	}
	us := func(d time.Duration) float64 { return float64(d) / 1e3 }
	q := func(p float64) float64 { return us(lat[int(p*float64(len(lat)-1))]) }
	s.MeanUs, s.P50Us, s.P90Us, s.P99Us, s.MaxUs = us(sum/time.Duration(len(lat))), q(.5), q(.9), q(.99), us(lat[len(lat)-1])
	return s
}

// run keeps qd requests in flight on one connection for the duration,
// cycling through offs from start, and records per-request latency.
func run(c *tls.Conn, offs []uint64, start int, qd, size int, dur time.Duration, phase string) (stats, int, error) {
	sent := make(map[uint64]time.Time, qd)
	buf := make([]byte, size)
	var lat []time.Duration
	next, handle := start, uint64(1)
	t0 := time.Now()
	stop := t0.Add(dur)
	issue := func() error {
		off := offs[next%len(offs)]
		next++
		sent[handle] = time.Now()
		err := sendRead(c, handle, off, uint32(size))
		handle++
		return err
	}
	for i := 0; i < qd; i++ {
		if err := issue(); err != nil {
			return stats{}, next, err
		}
	}
	for len(sent) > 0 {
		h, err := readReply(c, buf)
		if err != nil {
			return stats{}, next, err
		}
		at, ok := sent[h]
		if !ok {
			return stats{}, next, errors.New("unknown reply handle")
		}
		delete(sent, h)
		lat = append(lat, time.Since(at))
		if time.Now().Before(stop) {
			if err = issue(); err != nil {
				return stats{}, next, err
			}
		}
	}
	return summarize(phase, lat, time.Since(t0), qd, size), next, nil
}

func main() {
	addr := flag.String("addr", "", "")
	export := flag.String("export", "", "")
	serverName := flag.String("server-name", "", "")
	caFile := flag.String("ca", "", "")
	certFile := flag.String("cert", "", "")
	keyFile := flag.String("key", "", "")
	offFile := flag.String("offsets", "", "")
	label := flag.String("label", "", "")
	seqStart := flag.Uint64("seq-start", 0, "1MiB-aligned start of the largest allocated extent")
	seqLen := flag.Uint64("seq-len", 0, "bytes of that extent")
	flag.Parse()
	fail := func(err error) {
		fmt.Fprintln(os.Stderr, "nbdbench:", err)
		os.Exit(1)
	}
	caPEM, err := os.ReadFile(*caFile)
	if err != nil {
		fail(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		fail(errors.New("bad CA"))
	}
	cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		fail(err)
	}
	raw, err := os.ReadFile(*offFile)
	if err != nil || len(raw) == 0 || len(raw)%8 != 0 {
		fail(errors.New("bad offsets file"))
	}
	offs := make([]uint64, len(raw)/8)
	for i := range offs {
		offs[i] = binary.BigEndian.Uint64(raw[i*8:])
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: *serverName, Certificates: []tls.Certificate{cert}}
	t := time.Now()
	c, size, err := connect(*addr, *export, *serverName, cfg)
	if err != nil {
		fail(err)
	}
	connectMs := float64(time.Since(t)) / 1e6
	var out []stats
	pos := 0
	// Half the offsets for random phases; the first offset anchors sequential.
	for _, p := range []struct {
		name     string
		qd, size int
		dur      time.Duration
	}{{"rand4k-qd1", 1, 4096, 30 * time.Second}, {"rand4k-qd32", 32, 4096, 20 * time.Second}, {"rand16k-qd1", 1, 16384, 10 * time.Second}} {
		s, n, err := run(c, offs, pos, p.qd, p.size, p.dur, p.name)
		if err != nil {
			fail(fmt.Errorf("%s: %w", p.name, err))
		}
		out, pos = append(out, s), n
	}
	// Sequential 1MiB reads, QD4, wrapping inside one allocated extent.
	if *seqLen < 1<<20 || *seqStart%(1<<20) != 0 {
		fail(errors.New("allocated sequential extent required"))
	}
	seq := make([]uint64, *seqLen>>20)
	for i := range seq {
		seq[i] = *seqStart + uint64(i)<<20
	}
	s, _, err := run(c, seq, 0, 4, 1<<20, 15*time.Second, "seq1m-qd4")
	if err != nil {
		fail(fmt.Errorf("seq: %w", err))
	}
	out = append(out, s)
	b := binary.BigEndian.AppendUint32(nil, reqMagic)
	b = binary.BigEndian.AppendUint16(b, 0)
	b = binary.BigEndian.AppendUint16(b, 2) // DISC
	c.Write(append(b, make([]byte, 20)...))
	c.Close()
	json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": "rpc-lan-nbd-io/1", "label": *label, "addr": *addr, "export": *export, "exportBytes": size, "connectMs": connectMs, "offsets": len(offs), "phases": out})
}
