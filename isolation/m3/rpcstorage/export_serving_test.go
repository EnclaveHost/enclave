//go:build linux && amd64

package rpcstorage

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

func TestExportServingOriginalOwnerPythonGuardian(t *testing.T) {
	for _, mode := range []string{"normal-renew", "missing-record", "worker-blocked", "peer-loss"} {
		t.Run(mode, func(t *testing.T) {
			actor := os.Getenv("RPC_EXPORT_SERVING_ACTOR")
			if actor == "" {
				t.Skip("explicit inert Python actor required")
			}
			f, e := brokerFixtureStart(t, "export-serving-fixture", 0)
			if e != nil {
				t.Fatal(e)
			}
			s := f.session
			root, der, client := testCredentials(t)
			listener, e := net.Listen("tcp", "127.0.0.1:0")
			if e != nil {
				t.Fatal(e)
			}
			port := listener.Addr().(*net.TCPAddr).Port
			listener.Close()
			binding := bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: uint16(port), ServerName: "export.control.test", ServerCertificateSHA256: sumHex(der), ClientCertificateSHA256: sumHex(client.Certificate[0]), ContractSHA256: strings.Repeat("3", 64)}
			a, _, keys := exportAuthorizationKeys(t, s.request, &binding)
			seeds := [2][]byte{keys[0].Seed(), keys[1].Seed()}
			defer func() {
				for _, v := range seeds {
					clear(v)
				}
				for _, v := range keys {
					clear(v)
				}
			}()
			journal := persistentFixture(t)
			owner, e := NewOwnerIssuer(journal, seeds, [2]string{s.request.L1Volume, s.request.BaseVolume}, binding, time.Now().Add(time.Second))
			if e != nil {
				t.Fatal(e)
			}
			initial, e := owner.Issue(context.Background(), a, rpcBundle(t), s.request)
			if e != nil {
				t.Fatal(e)
			}
			defer owner.proof.Close()
			for _, r := range owner.intent.records {
				defer r.Close()
			}
			receipts := guestReceipts(t)
			if e = s.AuthenticateRemoteReservation(a, rpcBundle(t), initial, receipts); e != nil {
				t.Fatal(e)
			}
			c, e := owner.BeginStartupContinuations(context.Background(), seeds)
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			now := time.Now().Unix()
			permit := bootstrap.RPCContinuation{Schema: bootstrap.RPCContinuationSchema, Phase: "startup", Sequence: 1, PreviousSHA256: sumHex(initial), IssuedAt: now, NotAfter: now + 30}
			startup, e := c.IssueStartup(permit)
			if e != nil {
				t.Fatal(e)
			}
			if e = s.ApplyStartupContinuation(rpcBundle(t), startup, receipts); e != nil {
				t.Fatal(e)
			}
			prep := ownerPreparationRequest(t, c)
			raw, _ := json.Marshal(prep)
			prepared, e := c.PrepareServing(raw)
			if e != nil {
				t.Fatal(e)
			}
			observed := sha256.Sum256(prep.Observation)
			permit.Phase = "serving"
			permit.Sequence = 2
			permit.PreviousSHA256 = c.previous
			permit.ReadinessSHA256 = hex.EncodeToString(observed[:])
			permit.NotAfter = now + 3
			commit := servingCommitRequest{Schema: servingCommitSchema, PreparedSHA256: sumHex(prepared), Permit: permit}
			proof, e := c.IssueServing(ownerCommitBytes(commit))
			if e != nil {
				t.Fatal(e)
			}
			if mode == "missing-record" {
				name := filepath.Join(journal.Name(), fmt.Sprintf("serving-commit-%s-%016x-submit", c.requestHash, permit.Sequence))
				if e = os.Rename(name, name+"-held-fixture"); e != nil {
					t.Fatal(e)
				}
			}
			st, e := journal.Stat()
			if e != nil {
				t.Fatal(e)
			}
			native := st.Sys().(*syscall.Stat_t)
			request, _ := json.Marshal(s.request)
			cfg := map[string]any{"mode": mode, "contract": binding.ContractSHA256, "control": map[string]any{"schema": "enclave-rpc-export-control/2", "host": "127.0.0.1", "port": port, "tls": root, "clientCertificateSha256": binding.ClientCertificateSHA256, "requestSha256": sumHex(request), "ownerJournal": map[string]any{"path": journal.Name(), "device": native.Dev, "inode": native.Ino}}}
			config, _ := json.Marshal(cfg)
			path := filepath.Join(root, "serving-config.json")
			if e = os.WriteFile(path, config, 0600); e != nil {
				t.Fatal(e)
			}
			cmd := exec.Command("/usr/bin/python3", "-B", actor, path)
			stdout, e := cmd.StdoutPipe()
			if e != nil {
				t.Fatal(e)
			}
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			if e = cmd.Start(); e != nil {
				t.Fatal(e)
			}
			done := make(chan error, 1)
			waited := false
			go func() { done <- cmd.Wait() }()
			defer func() {
				if !waited {
					cmd.Process.Kill()
					<-done
				}
			}()
			scanner := bufio.NewScanner(stdout)
			lines := make(chan string, 4)
			go func() {
				defer close(lines)
				for scanner.Scan() {
					lines <- scanner.Text()
				}
			}()
			next := func() string {
				select {
				case line := <-lines:
					return line
				case <-time.After(4 * time.Second):
					t.Fatal("inert exporter stalled", stderr.String())
					return ""
				}
			}
			if line := next(); line != "LISTEN" {
				t.Fatal("exporter startup", line, stderr.String())
			}
			// Explicit /2 selection: owner TLS/attestation fixture is separate; this test
			// validates actual original ConnectExportControl and the Python native guard.
			s.mu.Lock()
			s.ownerStream = &ownerContinuationConnection{}
			s.mu.Unlock()
			if _, e = s.ConnectExportControl(der, client); e != nil {
				t.Fatal(e, stderr.String())
			}
			line := next()
			if !strings.HasPrefix(line, "READY ") {
				t.Fatal("worker readiness", line, stderr.String())
			}
			type identity struct {
				PID   int    `json:"pid"`
				Start string `json:"start"`
			}
			var rows map[string]struct {
				Worker identity `json:"worker"`
				Child  identity `json:"child"`
			}
			if e = json.Unmarshal([]byte(strings.TrimPrefix(line, "READY ")), &rows); e != nil {
				t.Fatal(e)
			}
			held := map[int]*os.File{}
			for _, row := range rows {
				for _, id := range []identity{row.Worker, row.Child} {
					if held[id.PID] != nil {
						continue
					}
					raw, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", id.PID))
					if e != nil {
						t.Fatal(e)
					}
					fields := strings.Fields(string(raw)[strings.LastIndex(string(raw), ")")+2:])
					if fields[19] != id.Start {
						t.Fatal("worker identity replaced")
					}
					fd, _, eno := syscall.Syscall(434, uintptr(id.PID), 0, 0)
					if eno != 0 {
						t.Fatal(eno)
					}
					file := os.NewFile(fd, "held-export-worker")
					held[id.PID] = file
					defer file.Close()
					if pid, e := pidfdPID(file); e != nil || pid != id.PID {
						t.Fatal("held pidfd differs", e)
					}
				}
			}
			ctx, cancel := context.WithTimeout(s.ctx, 3*time.Second)
			defer cancel()
			e = s.commitExportPermit(ctx, proof, c.bound.Load().permitUntil)
			if mode == "missing-record" || mode == "worker-blocked" {
				if e == nil {
					t.Fatal("invalid/blocked exporter acknowledged")
				}
			} else {
				if e != nil {
					t.Fatal("actual exporter commit", e, stderr.String())
				}
				if mode == "normal-renew" {
					time.Sleep(1100 * time.Millisecond)
					if s.ctx.Err() != nil {
						t.Fatal("exporter did not survive original startup")
					}
					commit.Permit.Sequence++
					commit.Permit.PreviousSHA256 = c.previous
					commit.Permit.IssuedAt = time.Now().Unix()
					commit.Permit.NotAfter = permit.NotAfter + 1
					proof, e = c.IssueServing(ownerCommitBytes(commit))
					if e != nil {
						t.Fatal("same owner renewal", e)
					}
					if e = s.commitExportPermit(ctx, proof, c.bound.Load().permitUntil); e != nil {
						t.Fatal("same export renewal", e)
					}
				} else {
					s.Stop()
				}
			}
			resultLine := next()
			if !strings.HasPrefix(resultLine, "RESULT ") {
				t.Fatal("exporter result", resultLine, stderr.String())
			}
			var result struct {
				Reason  string `json:"reason"`
				Fenced  bool   `json:"writersFenced"`
				Release bool   `json:"reservationMayRelease"`
			}
			if e = json.Unmarshal([]byte(strings.TrimPrefix(resultLine, "RESULT ")), &result); e != nil {
				t.Fatal(e)
			}
			if result.Fenced || result.Release {
				t.Fatal("fixture claimed writer settlement")
			}
			if mode == "normal-renew" {
				// Worker, TLS peer deadline and independent guardian share the
				// accepted expiry. Any may report loss first; require actual time.
				until := c.bound.Load().permitUntil
				if time.Now().Before(until) || time.Since(until) > time.Second {
					t.Fatal("permit expiry lost", result.Reason)
				}
			}
			select {
			case e = <-done:
				waited = true
				if e != nil {
					t.Fatal(e, stderr.String())
				}
			case <-time.After(time.Second):
				t.Fatal("exporter did not terminate")
			}
			for _, file := range held {
				ready, e := pollBroker([]brokerPoll{{int32(file.Fd()), 1, 0}}, 0)
				if e != nil || !ready {
					t.Fatal("exact original export process still alive", e)
				}
			}
		})
	}
}
