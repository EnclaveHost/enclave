//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

func ownerFixture(t *testing.T) (*OwnerIssuer, *bootstrap.Authorization, []byte, Request, [2][]byte) {
	t.Helper()
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		t.Fatal(e)
	}
	bundle := rpcBundle(t)
	r, e := NewRequest(bundle, now)
	if e != nil {
		t.Fatal(e)
	}
	// A remote monotonic clock is opaque to this storage owner. Only the local
	// pre-existing owner deadline governs its work, with no cross-boot compare.
	r.Origin = 1
	r.Deadline = 900000000001
	r.Boot = "12345678-1234-1234-1234-123456789abc"
	binding := bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: 12345, ServerName: "storage.example", ServerCertificateSHA256: strings.Repeat("1", 64), ClientCertificateSHA256: strings.Repeat("2", 64), ContractSHA256: strings.Repeat("3", 64)}
	a, _, keys := exportAuthorizationKeys(t, r, &binding)
	seeds := [2][]byte{keys[0].Seed(), keys[1].Seed()}
	o, e := NewOwnerIssuer(persistentFixture(t), seeds, [2]string{r.L1Volume, r.BaseVolume}, binding, time.Now().Add(5*time.Second))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if o.intent != nil {
			for _, f := range o.intent.records {
				f.Close()
			}
		}
		if o.proof != nil {
			o.proof.Close()
		}
		for _, s := range seeds {
			clear(s)
		}
	})
	return o, a, bundle, r, seeds
}

func TestOwnerIssuePersistsBeforeResponseAndRestartRefuses(t *testing.T) {
	o, a, b, r, seeds := ownerFixture(t)
	raw, e := o.Issue(context.Background(), a, b, r)
	if e != nil {
		t.Fatal(e)
	}
	consent, e := a.VerifyRPCStorage(b, r, raw)
	if e != nil || !consent.Matches(r) {
		t.Fatal(e)
	}
	var proof bootstrap.RPCStorageSignatures
	if e = json.Unmarshal(raw, &proof); e != nil {
		t.Fatal(e)
	}
	for _, v := range []string{r.L1Volume, r.BaseVolume} {
		data, e := os.ReadFile(filepath.Join(o.journal.Name(), v))
		if e != nil {
			t.Fatal(e)
		}
		var record struct {
			Schema        string
			Request       Request
			Epochs        [2]string
			Export        bootstrap.RPCExportBinding
			PayloadSHA256 [2]string
		}
		if e = json.Unmarshal(data, &record); e != nil {
			t.Fatal(e)
		}
		payloads, e := a.RPCExportSigningPayloads(b, r, proof.L1.WriterEpoch, proof.Base.WriterEpoch, *proof.Export)
		if e != nil {
			t.Fatal(e)
		}
		if record.Schema != "enclave-rpc-owner-consumed/1" || record.Request != r || record.Epochs != [2]string{proof.L1.WriterEpoch, proof.Base.WriterEpoch} || record.Export != o.binding {
			t.Fatal("owner journal scope differs")
		}
		for i, payload := range payloads {
			h := sha256.Sum256(payload)
			if record.PayloadSHA256[i] != hex.EncodeToString(h[:]) {
				t.Fatal("journal omitted signed owner/runtime scope")
			}
		}
	}
	requestBytes, _ := json.Marshal(r)
	h := sha256.Sum256(requestBytes)
	disk, e := os.ReadFile(filepath.Join(o.journal.Name(), "proof-"+hex.EncodeToString(h[:])))
	if e != nil || !bytes.Equal(disk, raw) {
		t.Fatal("response was not durably recorded", e)
	}
	for _, key := range o.keys {
		if len(key) != 0 {
			t.Fatal("issuer retained signing material")
		}
	}
	if again, e := o.Issue(context.Background(), a, b, r); e == nil || again != nil {
		t.Fatal("same actor repeated")
	}
	// A new actor/process has no in-memory consumed flag. The original owner
	// volume records still refuse a repeat even when request bytes match.
	next, e := NewOwnerIssuer(o.journal, seeds, o.volumes, o.binding, time.Now().Add(time.Second))
	if e != nil {
		t.Fatal(e)
	}
	if again, e := next.Issue(context.Background(), a, b, r); e == nil || again != nil {
		t.Fatal("restart reissued consent")
	}
}

func TestOwnerPartialReservationAndLostResponseStayHeld(t *testing.T) {
	for _, mode := range []string{"second-volume-conflict", "response-conflict"} {
		t.Run(mode, func(t *testing.T) {
			o, a, b, r, _ := ownerFixture(t)
			name := r.L1Volume
			if r.BaseVolume > name {
				name = r.BaseVolume
			}
			if mode == "response-conflict" {
				raw, _ := json.Marshal(r)
				h := sha256.Sum256(raw)
				name = "proof-" + hex.EncodeToString(h[:])
			}
			path := filepath.Join(o.journal.Name(), name)
			if e := os.WriteFile(path, []byte("prior ambiguous intent"), 0400); e != nil {
				t.Fatal(e)
			}
			if raw, e := o.Issue(context.Background(), a, b, r); e == nil || raw != nil {
				t.Fatal("conflict returned consent")
			}
			data, _ := os.ReadFile(path)
			if string(data) != "prior ambiguous intent" {
				t.Fatal("prior intent overwritten")
			}
			first := r.L1Volume
			if r.BaseVolume < first {
				first = r.BaseVolume
			}
			if _, e := os.Stat(filepath.Join(o.journal.Name(), first)); e != nil {
				t.Fatal("partial reservation removed")
			}
			if raw, e := o.Issue(context.Background(), a, b, r); e == nil || raw != nil {
				t.Fatal("failed actor reused")
			}
		})
	}
}

func TestOwnerRefusalsDoNotConsumeVolumes(t *testing.T) {
	for _, mode := range []string{"key", "role", "unsigned", "cancel", "deadline", "request", "binding"} {
		t.Run(mode, func(t *testing.T) {
			o, a, b, r, _ := ownerFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "key":
				o.keys[0], o.keys[1] = o.keys[1], o.keys[0]
			case "role":
				o.volumes[0], o.volumes[1] = o.volumes[1], o.volumes[0]
			case "unsigned":
				a = &bootstrap.Authorization{}
			case "cancel":
				cancel()
			case "deadline":
				o.deadline = time.Now().Add(-time.Second)
			case "request":
				r.Profile = strings.Repeat("f", 64)
			case "binding":
				o.binding.Host = "0.0.0.0"
			}
			if raw, e := o.Issue(ctx, a, b, r); e == nil || raw != nil {
				t.Fatal("invalid authority issued")
			}
			files, e := os.ReadDir(o.journal.Name())
			if e != nil || len(files) != 0 {
				t.Fatal("refusal consumed unrelated volume", e)
			}
			if raw, e := o.Issue(context.Background(), a, b, r); e == nil || raw != nil {
				t.Fatal("refusal did not consume actor")
			}
		})
	}
}
