//go:build linux && amd64 && rpc_owner_composition

package main

// This opt-in TEST BINARY runs the unchanged command main/run implementation
// with an in-memory chain transport. It is never a release artifact. The native
// composition fixture exercises real FD provisioning, signing, journal writes,
// systemd dispatch and exports; it does NOT qualify HTTPS quorum or attestation.
import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcstorage"
)

type compositionChain struct{ Row, Schema, SchemaSelector string }

func (c compositionChain) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || (r.URL.Host != "one.rpc.example" && r.URL.Host != "two.rpc.example" && r.URL.Host != "three.rpc.example") {
		return nil, fmt.Errorf("fixture refuses unexpected endpoint")
	}
	var call struct {
		Method string
		Params []json.RawMessage
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 65536)).Decode(&call); err != nil {
		return nil, err
	}
	var result any
	switch call.Method {
	case "eth_chainId":
		result = "0x2105"
	case "eth_blockNumber":
		result = "0x64"
	case "eth_getBlockByNumber":
		if len(call.Params) != 2 {
			return nil, fmt.Errorf("fixture block params")
		}
		var tag string
		if err := json.Unmarshal(call.Params[0], &tag); err != nil {
			return nil, err
		}
		result = map[string]string{"number": tag, "hash": "0x" + strings.Repeat("ab", 32), "timestamp": fmt.Sprintf("0x%x", time.Now().Unix())}
	case "eth_call":
		if len(call.Params) != 2 {
			return nil, fmt.Errorf("fixture call params")
		}
		var data map[string]string
		if err := json.Unmarshal(call.Params[0], &data); err != nil {
			return nil, err
		}
		if data["data"] == c.SchemaSelector {
			result = c.Schema
		} else {
			result = c.Row
		}
	default:
		return nil, fmt.Errorf("unexpected fixture method %s", call.Method)
	}
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(b))}, nil
}

func compositionWrite(path string, b []byte) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if _, e = f.Write(b); e != nil {
		return e
	}
	return f.Sync()
}

func compositionPrepare(root, vectors, originText string) error {
	origin, e := strconv.ParseUint(originText, 10, 64)
	if e != nil {
		return e
	}
	m := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), SecretDeployment: "0x" + strings.Repeat("c", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: strings.Repeat("1", 64), L1VolumeID: strings.Repeat("a", 64), BaseVolumeID: strings.Repeat("b", 64)}}
	bundle, e := contract.Build(m, []byte{0, 97, 115, 109, 13, 0, 1, 0})
	if e != nil {
		return e
	}
	request, e := rpcstorage.NewRequest(bundle, origin)
	if e != nil {
		return e
	}
	raw, e := os.ReadFile(vectors)
	if e != nil {
		return e
	}
	var v struct{ ID, Ledger, Manifest, Row, Schema, SchemaSelector string }
	if e = json.Unmarshal(raw, &v); e != nil {
		return e
	}
	var manifest bootstrap.Manifest
	if e = json.Unmarshal([]byte(v.Manifest), &manifest); e != nil {
		return e
	}
	manifest.AppID = request.AppID
	manifest.Deployment = request.Deployment
	manifest.RPCStorage = &bootstrap.RPCStorage{Schema: "enclave-rpc-storage-authorities/1"}
	for i, a := range []*bootstrap.RPCStorageAuthority{&manifest.RPCStorage.L1, &manifest.RPCStorage.Base} {
		pub, key, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			return e
		}
		a.PublicKey = hex.EncodeToString(pub)
		a.VolumeID = []string{request.L1Volume, request.BaseVolume}[i]
		if e = compositionWrite(filepath.Join(root, []string{"l1-seed", "base-seed"}[i]), key.Seed()); e != nil {
			return e
		}
	}
	packageBytes, e := json.Marshal(manifest)
	if e != nil {
		return e
	}
	old := sha256.Sum256([]byte(v.Manifest))
	next := sha256.Sum256(packageBytes)
	from, to := hex.EncodeToString([]byte(hex.EncodeToString(old[:]))), hex.EncodeToString([]byte(hex.EncodeToString(next[:])))
	if strings.Count(v.Row, from) != 1 {
		return fmt.Errorf("fixture commitment not unique")
	}
	row := strings.Replace(v.Row, from, to, 1)
	row = strings.Replace(row, strings.TrimPrefix(v.ID, "0x"), strings.TrimPrefix(request.Deployment, "0x"), 1)
	chain, _ := json.Marshal(compositionChain{row, v.Schema, v.SchemaSelector})
	if e = compositionWrite(filepath.Join(root, "journal", "fixture-chain.json"), chain); e != nil {
		return e
	}
	inputBytes, _ := json.Marshal(input{bundle, packageBytes, request})
	// Canonical map re-encoding matches the actual CLI's strict input contract.
	var value any
	d := json.NewDecoder(bytes.NewReader(inputBytes))
	d.UseNumber()
	if e = d.Decode(&value); e != nil {
		return e
	}
	inputBytes, _ = json.Marshal(value)
	if e = compositionWrite(filepath.Join(root, "request.json"), inputBytes); e != nil {
		return e
	}
	public, _ := json.Marshal(map[string]string{"runtime": manifest.RuntimeID, "ledger": v.Ledger})
	return compositionWrite(filepath.Join(root, "fixture-policy.json"), public)
}

func TestMain(m *testing.M) {
	if len(os.Args) == 5 && os.Args[1] == "--prepare-composition" {
		if e := compositionPrepare(os.Args[2], os.Args[3], os.Args[4]); e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if len(os.Args) == 1 && os.Args[0] == "rpc-storage-owner" {
		fd, e := syscall.Openat(4, "fixture-chain.json", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
		f := os.NewFile(uintptr(fd), "TEST ONLY chain replies")
		var chain compositionChain
		e = json.NewDecoder(io.LimitReader(f, 65536)).Decode(&chain)
		f.Close()
		if e != nil {
			fmt.Fprintln(os.Stderr, e)
			os.Exit(1)
		}
		http.DefaultTransport = chain
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}
