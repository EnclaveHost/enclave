package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"enclave.host/isolation/m3/vtpmclient"
)

// A source is where this guest's attestation reports come from. The front's endpoints, its key and its documents'
// shape are the same on every platform; the source supplies the report bytes, their format name and the deployment
// the host launched this guest for.
type source interface {
	// Platform names the isolation the report attests: "sev-snp" or "shield".
	Platform() string
	// Format is the name of the fresh document a verifier dispatches on.
	Format() string
	// Report returns a report the platform made now over these 64 bytes, or an error. A report that does not carry
	// exactly these bytes is an error here, never the caller's to notice.
	Report(reportData []byte) ([]byte, error)
	// Measurement is the launch identity inside a report, hex, or "" where only a verifier can read it.
	Measurement(report []byte) string
	// Deployment is the 32-byte deployment id this guest was launched for, hex, or "" for none (a smoke boot).
	Deployment(report []byte) string
}

const snpReportMin = 0x2a0

// snpSource is AMD SEV-SNP through the kernel's configfs-tsm interface; the provider must be the SEV guest driver.
// The deployment is HOST_DATA, which the AMD-SP signs with the report.
type snpSource struct {
	root string
	mu   sync.Mutex
	seq  uint64
}

func (s *snpSource) Platform() string { return "sev-snp" }
func (s *snpSource) Format() string   { return "sev-snp-vm-v1" }
func (s *snpSource) Report(reportData []byte) ([]byte, error) {
	s.mu.Lock()
	s.seq++
	entry := filepath.Join(s.root, fmt.Sprintf("vmfront-%d-%d", os.Getpid(), s.seq))
	s.mu.Unlock()
	if err := os.Mkdir(entry, 0o700); err != nil {
		return nil, err
	}
	defer os.Remove(entry)
	if err := os.WriteFile(filepath.Join(entry, "inblob"), reportData, 0); err != nil {
		return nil, err
	}
	provider, err := os.ReadFile(filepath.Join(entry, "provider"))
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(provider)) != "sev_guest" {
		return nil, errors.New("SEV-SNP report provider required")
	}
	rep, err := os.ReadFile(filepath.Join(entry, "outblob"))
	if err != nil {
		return nil, err
	}
	return rep, checkSNP(rep, reportData)
}
func checkSNP(rep, reportData []byte) error {
	if len(rep) < snpReportMin || !bytes.Equal(rep[0x50:0x90], reportData) {
		return errors.New("the SNP report does not carry the requested report data")
	}
	return nil
}
func (s *snpSource) Measurement(rep []byte) string { return hex.EncodeToString(rep[0x90:0xc0]) }
func (s *snpSource) Deployment(rep []byte) string {
	if hd := hex.EncodeToString(rep[0xc0:0xe0]); strings.Trim(hd, "0") != "" {
		return hd
	}
	return ""
}

var deploymentHex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// shieldSource is an Enclave Shield host (a Hyper-V partition under the OpenHCL paravisor): the report is the
// paravisor's HCLA envelope around a VBS VM report, read through the guest TPM (isolation/m3/vtpmclient, which
// checks that the envelope carries the requested bytes). That report has no field the host sets per launch, so the
// deployment comes from a file the platform's boot wrapper writes: it names what the LAUNCHER launched this guest
// for, it is not attested, and it is used only to choose the name a certificate is asked for. Who may hold that
// name is the certificate service's decision, from the lease.
type shieldSource struct {
	tpm        *vtpmclient.Client
	deployment string
}

func newShieldSource(tpmPath, deploymentFile string) (*shieldSource, error) {
	tpm, err := vtpmclient.Open(tpmPath)
	if err != nil {
		return nil, fmt.Errorf("guest TPM: %w", err)
	}
	s := &shieldSource{tpm: tpm}
	if b, err := os.ReadFile(deploymentFile); err == nil {
		if id := strings.TrimSpace(string(b)); deploymentHex.MatchString(id) && strings.Trim(id, "0") != "" {
			s.deployment = id
		} else {
			return nil, errors.New("the deployment file does not hold a deployment id")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return s, nil
}
func (s *shieldSource) Platform() string                 { return "shield" }
func (s *shieldSource) Format() string                   { return "shield-vm-v1" }
func (s *shieldSource) Report(rd []byte) ([]byte, error) { return s.tpm.Report(rd) }
func (s *shieldSource) Measurement([]byte) string        { return "" }
func (s *shieldSource) Deployment([]byte) string         { return s.deployment }

// pickSource chooses by name, or for "auto" by what this boot offers: the SEV guest's report interface if the
// platform's boot wrapper loaded it, else the paravisor's TPM. Neither is a refusal, never a front without reports.
func pickSource(name, tsm, tpm, deploymentFile string) (source, error) {
	switch name {
	case "sev-snp":
		return &snpSource{root: tsm}, nil
	case "shield":
		return newShieldSource(tpm, deploymentFile)
	case "auto":
		if st, err := os.Stat(tsm); err == nil && st.IsDir() {
			return &snpSource{root: tsm}, nil
		}
		if _, err := os.Stat(tpm); err == nil {
			return newShieldSource(tpm, deploymentFile)
		}
		return nil, errors.New("this boot offers neither an SEV-SNP report interface nor a paravisor TPM")
	}
	return nil, errors.New("-report must be auto, sev-snp or shield")
}
