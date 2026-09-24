package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// fakeMonitor answers every report request on a unix socket with rep in the given format, as the m3 monitor does.
func fakeMonitor(t *testing.T, rep []byte, format string) string {
	p := filepath.Join(t.TempDir(), "monitor.sock")
	l, err := net.Listen("unix", p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			var req map[string]string
			_ = json.NewDecoder(c).Decode(&req)
			_ = json.NewEncoder(c).Encode(map[string]string{"report": base64.StdEncoding.EncodeToString(rep), "format": format, "tier": "x"})
			c.Close()
		}
	}()
	return p
}

// On a Hyper-V partition the monitor's "report" is the launcher's signed JSON. Read at 0xC0 it named a deployment
// "686f7374" (ASCII "host"); a domain must derive no name at all from a report that is not SNP.
func TestHostDataComesOnlyFromAnSNPReport(t *testing.T) {
	hvDoc := []byte(`{"doc":{"boundary":"tier=T0-hv host_excluded=no","domain":{"appSha256":"` + strings.Repeat("ab", 32) +
		`"},"format":"hyperv-partition-domain/v1","launcher":{"key":"x"},"partition":{},"platform":{"hostExcluded":false,` +
		`"hypervisor":"hyper-v"},"reportData":"` + strings.Repeat("cd", 64) + `"},"sig":"` + strings.Repeat("A", 88) + `"}`)
	if len(hvDoc) < 0xe0 {
		t.Fatalf("fixture too short (%d) to exercise the old read", len(hvDoc))
	}
	f := &front{monitor: fakeMonitor(t, hvDoc, contract.FormatHyperV)}
	if hd, err := f.hostData(); err == nil {
		t.Fatalf("a Hyper-V launcher document gave HOST_DATA %q -> name %q", hd, nameFromHostData(hd, "app.enclave.host"))
	}
	snp := make([]byte, 0x4a0)
	want := bytes.Repeat([]byte{0x4e}, 32)
	copy(snp[0xc0:], want)
	f = &front{monitor: fakeMonitor(t, snp, contract.FormatSNP)}
	hd, err := f.hostData()
	if err != nil || !bytes.Equal(hd, want) {
		t.Fatalf("an SNP report: %x %v", hd, err)
	}
}
