package receiptwitness

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// parseHeaderRecompute is what a forger does: recompute the hash of an edited header.
func parseHeaderRecompute(raw []byte) (string, error) {
	var h types.Header
	if err := json.Unmarshal(raw, &h); err != nil {
		return "", err
	}
	return h.Hash().Hex(), nil
}

// The fixture is a real Base mainnet capture (probe/capture.mjs, base-rpc.polkachu.com), untrusted input. The test's
// anchor stands in for the head source (sequencer-signed gossip head or L1-finalized output root).
func load(t *testing.T) (map[string]any, common.Hash) {
	t.Helper()
	path := os.Getenv("FIXTURE")
	if path == "" {
		path = "../probe/fixture-1.json.gz"
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var rd io.Reader = f
	if strings.HasSuffix(path, ".gz") {
		if rd, err = gzip.NewReader(f); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := io.ReadAll(rd)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	hs := m["headers"].([]any)
	return m, common.HexToHash(hs[len(hs)-1].(map[string]any)["hash"].(string))
}

func verify(t *testing.T, m map[string]any, anchor common.Hash) (*View, error) {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var fx Fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	return Verify(fx, anchor)
}

func refused(t *testing.T, m map[string]any, anchor common.Hash, want string) {
	t.Helper()
	v, err := verify(t, m, anchor)
	if err == nil {
		t.Fatalf("accepted (want refusal containing %q): %+v", want, v)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("refused for the wrong reason: %v (want %q)", err, want)
	}
}

func receipts(m map[string]any, n int) []any {
	return m["receipts"].(map[string]any)[strconv.Itoa(n)].([]any)
}

func eventBlock(m map[string]any) int { return int(m["eventBlock"].(float64)) }

// the index of the receipt carrying the deployment's lease log in the event block
func leaseReceipt(t *testing.T, m map[string]any) (map[string]any, map[string]any) {
	id := strings.ToLower(m["deploymentId"].(string))
	ledger := strings.ToLower(m["ledger"].(string))
	for _, r := range receipts(m, eventBlock(m)) {
		for _, l := range r.(map[string]any)["logs"].([]any) {
			lg := l.(map[string]any)
			tp := lg["topics"].([]any)
			if strings.ToLower(lg["address"].(string)) == ledger && len(tp) > 1 && strings.ToLower(tp[1].(string)) == id {
				return r.(map[string]any), lg
			}
		}
	}
	t.Fatal("no lease log in the fixture")
	return nil, nil
}

func TestRealCaptureVerifies(t *testing.T) {
	m, anchor := load(t)
	v, err := verify(t, m, anchor)
	if err != nil {
		t.Fatal(err)
	}
	if v.LeaseUntil == nil || v.Runner == (common.Hash{}) || v.ReceiptVerified < 1 || v.BlocksChecked != v.BloomNegative+v.ReceiptVerified {
		t.Fatalf("incomplete view: %+v", v)
	}
	out, _ := json.MarshalIndent(v, "", " ")
	t.Logf("verified view:\n%s", out)
	// sizing: consensus encoding of every verified receipt list (what eth/66-68 GetReceipts carries; eth/69 drops the
	// 256-byte bloom per receipt)
	for k, raw := range m["receipts"].(map[string]any) {
		js, _ := json.Marshal(raw)
		var rs types.Receipts
		if err := json.Unmarshal(js, &rs); err != nil {
			t.Fatal(err)
		}
		total := 0
		for i := range rs {
			rs[i].Bloom = types.CreateBloom(rs[i])
			var b bytes.Buffer
			rs.EncodeIndex(i, &b)
			total += b.Len()
		}
		t.Logf("block %s: %d receipts, consensus %d bytes (eth/69 without blooms ~%d)", k, len(rs), total, total-256*len(rs))
	}
}

func TestAlteredLogIsRefused(t *testing.T) {
	m, anchor := load(t)
	_, lg := leaseReceipt(t, m)
	d := lg["data"].(string)
	lg["data"] = d[:len(d)-1] + map[bool]string{true: "1", false: "0"}[d[len(d)-1] == '0'] // a later leaseUntil/burn
	refused(t, m, anchor, "receipts root")
}

func TestOmittedReceiptIsRefused(t *testing.T) {
	m, anchor := load(t)
	rs := receipts(m, eventBlock(m))
	m["receipts"].(map[string]any)[strconv.Itoa(eventBlock(m))] = rs[:len(rs)-1]
	refused(t, m, anchor, "receipts root")
}

func TestOmittedLogIsRefused(t *testing.T) {
	m, anchor := load(t)
	r, _ := leaseReceipt(t, m)
	logs := r["logs"].([]any)
	r["logs"] = logs[:len(logs)-1]
	refused(t, m, anchor, "receipts root")
}

func TestInjectedLaterEventIsRefused(t *testing.T) {
	m, anchor := load(t)
	_, lg := leaseReceipt(t, m)
	// copy the lease log into a later bloom-positive block's first receipt (or the anchor's receipts if none)
	for n := eventBlock(m) + 1; n <= int(m["anchorBlock"].(float64)); n++ {
		if rs, ok := m["receipts"].(map[string]any)[strconv.Itoa(n)]; ok {
			r := rs.([]any)[0].(map[string]any)
			r["logs"] = append(r["logs"].([]any), lg)
			refused(t, m, anchor, "receipts root")
			return
		}
	}
	t.Skip("no later bloom-positive block in this fixture")
}

func TestWithheldReceiptsOfABloomPositiveBlockAreRefused(t *testing.T) {
	m, anchor := load(t)
	for n := eventBlock(m) + 1; n <= int(m["anchorBlock"].(float64)); n++ {
		if _, ok := m["receipts"].(map[string]any)[strconv.Itoa(n)]; ok {
			delete(m["receipts"].(map[string]any), strconv.Itoa(n))
			refused(t, m, anchor, "receipts were not supplied")
			return
		}
	}
	t.Skip("no later bloom-positive block in this fixture")
}

func TestMissingHeaderIsRefused(t *testing.T) {
	m, anchor := load(t)
	hs := m["headers"].([]any)
	m["headers"] = append(append([]any{}, hs[:5]...), hs[6:]...)
	refused(t, m, anchor, "need exactly")
}

func TestAlteredHeaderIsRefused(t *testing.T) {
	m, anchor := load(t)
	h := m["headers"].([]any)[3].(map[string]any)
	h["gasUsed"] = "0x1"
	refused(t, m, anchor, "recomputed hash")
}

func TestHiddenBloomIsRefused(t *testing.T) {
	// zero a bloom-positive header's bloom (to skip its receipts) and re-claim the matching hash: its child no longer links
	m, anchor := load(t)
	hs := m["headers"].([]any)
	for i := 1; i < len(hs)-1; i++ {
		h := hs[i].(map[string]any)
		if _, ok := m["receipts"].(map[string]any)[strconv.Itoa(eventBlock(m)+i)]; !ok {
			continue
		}
		h["logsBloom"] = "0x" + strings.Repeat("0", 512)
		raw, _ := json.Marshal(h)
		hd, err := parseHeaderRecompute(raw)
		if err != nil {
			t.Fatal(err)
		}
		h["hash"] = hd
		refused(t, m, anchor, "does not link")
		return
	}
	t.Skip("no inner bloom-positive block")
}

func TestForkedChainIsRefusedByTheAnchor(t *testing.T) {
	// rebuild a self-consistent alternative chain from block 3 up (every header re-hashed and re-linked): only the
	// anchor tells it apart
	m, anchor := load(t)
	hs := m["headers"].([]any)
	prev := hs[2].(map[string]any)["hash"].(string)
	for i := 3; i < len(hs); i++ {
		h := hs[i].(map[string]any)
		h["parentHash"] = prev
		if i == 3 {
			h["extraData"] = h["extraData"].(string) + "00"
		}
		raw, _ := json.Marshal(h)
		hash, err := parseHeaderRecompute(raw)
		if err != nil {
			t.Fatal(err)
		}
		h["hash"] = hash
		prev = hash
	}
	refused(t, m, anchor, "is not the anchor")
}

func TestWrongAnchorIsRefused(t *testing.T) {
	m, _ := load(t)
	refused(t, m, common.HexToHash("0x01"), "is not the anchor")
}

// ---- input hardening (root review ROOT-RECEIPT-REVIEW.txt): refusals, never panics; proofs unchanged ----

func fixtureOf(t *testing.T, m map[string]any) Fixture {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var fx Fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	return fx
}

func refusedLim(t *testing.T, m map[string]any, anchor common.Hash, lim Limits, want string) {
	t.Helper()
	v, err := VerifyWithLimits(fixtureOf(t, m), anchor, lim)
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("want refusal containing %q, got %v (%+v)", want, err, v)
	}
}

func TestNullReceiptIsRefusedNotAPanic(t *testing.T) {
	m, anchor := load(t)
	receipts(m, eventBlock(m))[0] = nil
	refused(t, m, anchor, "receipt 0 is null")
}

func TestNullLogIsRefusedNotAPanic(t *testing.T) {
	m, anchor := load(t)
	r, _ := leaseReceipt(t, m)
	r["logs"].([]any)[0] = nil
	refused(t, m, anchor, "is null")
}

func TestNullHeaderIsRefusedNotAPanic(t *testing.T) {
	m, anchor := load(t)
	m["headers"].([]any)[3] = nil
	if _, err := verify(t, m, anchor); err == nil {
		t.Fatal("a null header was accepted")
	}
}

func TestHeaderCountIsCheckedBeforeParsing(t *testing.T) {
	m, anchor := load(t)
	m["headers"] = append(m["headers"].([]any), "not even a header")
	refused(t, m, anchor, "need exactly")
}

func TestSurplusReceiptListsAreRefused(t *testing.T) {
	m, anchor := load(t)
	rm := m["receipts"].(map[string]any)
	for i := 0; i < 40; i++ {
		rm[strconv.Itoa(1000000+i)] = []any{}
	}
	refused(t, m, anchor, "receipt lists for")
}

func TestEveryLimitRefusesBeforeAllocation(t *testing.T) {
	m, anchor := load(t)
	for name, c := range map[string]struct {
		mut  func(*Limits)
		want string
	}{
		"window":   {func(l *Limits) { l.MaxWindow = 5 }, "window out of range"},
		"header":   {func(l *Limits) { l.MaxHeaderBytes = 100 }, "a header of"},
		"total":    {func(l *Limits) { l.MaxTotalBytes = 10000 }, "inputs of"},
		"list":     {func(l *Limits) { l.MaxReceiptListBytes = 1000 }, "receipt list of"},
		"receipts": {func(l *Limits) { l.MaxReceiptsPerBlock = 10 }, "receipts exceed"},
		"logs":     {func(l *Limits) { l.MaxLogsPerReceipt = 0 }, "logs, above"},
	} {
		lim := DefaultLimits
		c.mut(&lim)
		t.Run(name, func(t *testing.T) { refusedLim(t, m, anchor, lim, c.want) })
	}
	// the default limits leave the real proof exactly as before
	v, err := VerifyWithLimits(fixtureOf(t, m), anchor, DefaultLimits)
	if err != nil || v.LeaseUntil == nil || *v.LeaseUntil != 1792721679 || v.ReceiptsVerified != 1824 {
		t.Fatalf("default limits changed the proof: %v %+v", err, v)
	}
}

func TestReadFixtureFileIsBounded(t *testing.T) {
	dir := t.TempDir()
	plain := dir + "/f.json"
	if err := os.WriteFile(plain, bytes.Repeat([]byte("a"), 1000), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFixtureFile(plain, 999); err == nil {
		t.Fatal("an oversized file was read")
	}
	if raw, err := ReadFixtureFile(plain, 1000); err != nil || len(raw) != 1000 {
		t.Fatalf("exact-size file refused: %v", err)
	}
	// a gzip bomb: 64 MiB of zeros in a ~64 KiB file must be refused at the decompressed bound, not expanded
	bomb := dir + "/bomb.json.gz"
	var b bytes.Buffer
	z := gzip.NewWriter(&b)
	z.Write(make([]byte, 64<<20))
	z.Close()
	if err := os.WriteFile(bomb, b.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFixtureFile(bomb, 1<<20); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("gzip bomb not refused: %v", err)
	}
	if raw, err := ReadFixtureFile("../probe/fixture-1.json.gz", 64<<20); err != nil || len(raw) != 6957541 {
		t.Fatalf("real fixture: %v %d", err, len(raw))
	}
}
