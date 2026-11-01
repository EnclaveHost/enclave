//go:build linux && amd64

package rpcbootstrap

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"syscall"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcstorage"
)

// OwnerInputs is public untrusted transport. The broker checks BOTH signatures
// against the real deployment commitment before dialing. Host cannot set the
// guest evidence or key, nor any executable/path/new-clock/retry selector.
type OwnerInputs struct {
	ExportServerDER []byte          `json:"exportServerDer"`
	HostEvidence    json.RawMessage `json:"hostEvidence"`
	Offer           json.RawMessage `json:"offer"`
	OwnerServerDER  []byte          `json:"ownerServerDer"`
	Policy          []byte          `json:"policy"`
}

func (i *Identity) InstallOwnerInputs(boot, digest string, raw, bundle []byte) (err error) {
	i.mu.Lock()
	if err = i.check(boot, digest); err != nil {
		i.mu.Unlock()
		return err
	}
	if !i.reported || i.ownerUsed || i.launchUsed || i.acquireUsed {
		i.mu.Unlock()
		return errors.New("unused reported owner-input gate required")
	}
	i.ownerUsed = true
	pub := i.public
	evidence := append([]byte(nil), i.evidence...)
	i.mu.Unlock()
	defer func() {
		if err != nil {
			i.Close()
		}
	}()
	if len(raw) == 0 || len(raw) > 12<<20 {
		return errors.New("owner input bound")
	}
	var in OwnerInputs
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err = d.Decode(&in); err != nil {
		return err
	}
	canonical, err := json.Marshal(in)
	if err != nil || !bytes.Equal(canonical, raw) {
		return errors.New("exact canonical owner inputs required")
	}
	if len(in.ExportServerDER) == 0 || len(in.ExportServerDER) > 16384 || len(in.OwnerServerDER) == 0 || len(in.OwnerServerDER) > 16384 || len(in.HostEvidence) == 0 || len(in.HostEvidence) > 11<<20 || len(in.Offer) == 0 || len(in.Offer) > 16384 || len(evidence) == 0 {
		return errors.New("bounded public owner inputs and retained report required")
	}
	if err = boundPolicy(in.Policy, pub, bundle); err != nil {
		return err
	}
	var proof bootstrap.RPCBootstrapOfferProof
	d = json.NewDecoder(bytes.NewReader(in.Offer))
	d.DisallowUnknownFields()
	if err = d.Decode(&proof); err != nil {
		return err
	}
	canonical, err = json.Marshal(proof)
	if err != nil || !bytes.Equal(canonical, in.Offer) {
		return errors.New("canonical owner offer required")
	}
	if _, err = proof.Offer.Bytes(); err != nil {
		return err
	}
	var report Evidence
	if err = json.Unmarshal(evidence, &report); err != nil {
		return err
	}
	rid, err := contract.RuntimeID(pub.Runtime)
	if err != nil {
		return err
	}
	serverSHA, clientSHA := sha256.Sum256(in.OwnerServerDER), sha256.Sum256(pub.Certificate)
	if proof.Offer.RequestSHA256 != digest || proof.Offer.Runtime != hex.EncodeToString(rid[:]) || proof.Offer.Challenge != report.Challenge || proof.Offer.ServerCertificateSHA256 != hex.EncodeToString(serverSHA[:]) || proof.Offer.ClientCertificateSHA256 != hex.EncodeToString(clientSHA[:]) {
		return errors.New("owner inputs differ from retained guest identity")
	}
	packed, err := json.Marshal(rpcstorage.OwnerBootstrapInput{Evidence: evidence, HostEvidence: in.HostEvidence, Offer: in.Offer, ServerDER: in.OwnerServerDER})
	if err != nil || len(packed) > 12<<20 {
		return errors.New("owner bootstrap wire bound")
	}
	run, err := protectedDir("/run")
	if err != nil {
		return err
	}
	defer run.Close()
	var fs syscall.Statfs_t
	if syscall.Fstatfs(int(run.Fd()), &fs) != nil || fs.Type != 0x01021994 || fs.Flags&1 != 0 {
		return errors.New("private writable guest tmpfs required")
	}
	if err = syscall.Mkdirat(int(run.Fd()), "native-rpc-owner", 0700); err != nil {
		return err
	}
	dir, err := protectedDir("/run/native-rpc-owner")
	if err != nil {
		return err
	}
	defer dir.Close()
	for _, file := range []struct {
		name string
		raw  []byte
	}{{"input.intent", []byte(digest)}, {"policy.json", in.Policy}, {"server.der", in.ExportServerDER}, {"owner-bootstrap.json", packed}} {
		f, e := privateFile(dir, file.name, file.raw)
		if e != nil {
			return e
		}
		f.Close()
		if err = dir.Sync(); err != nil {
			return err
		}
	}
	if err = run.Sync(); err != nil {
		return err
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if err = i.check(boot, digest); err != nil {
		return err
	}
	i.ownerPrepared = true
	return nil
}
