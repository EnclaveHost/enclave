package appconfig

// Release FACTS (storage writer fencing; work/storage-front-binding-interface.txt): values the measured front itself
// establishes for the app, under two reserved names, and never an owner's secret. The owner's config refers to them
// ("writerAuthority": "$ENCLAVE_WRITER_AUTHORITY", "instanceIsolation": "$ENCLAVE_INSTANCE_ISOLATION"). An owner can
// never supply them: ValidateSecrets refuses the whole ENCLAVE_ prefix, and facts travel on their own channel, validated
// here. An absent fact leaves its name unresolved, and an app that needs it fails closed on its own.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const (
	FactWriterAuthority   = "ENCLAVE_WRITER_AUTHORITY"
	FactInstanceIsolation = "ENCLAVE_INSTANCE_ISOLATION"
)

var (
	lowerAddress = regexp.MustCompile(`^0x[0-9a-f]{40}$`)
	lowerBytes32 = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
)

// WriterAuthority is the lease16 fact (sia-s3 fencing.rs Authority::Lease16): the finalized Claimed log of the
// deployment's CURRENT lease on the live rev-16d ledger.
type WriterAuthority struct {
	Source        string `json:"source"`
	ChainID       uint64 `json:"chainId"`
	Ledger        string `json:"ledger"`
	Deployment    string `json:"deployment"`
	ClaimBlock    uint64 `json:"claimBlock"`
	ClaimLogIndex uint64 `json:"claimLogIndex"`
}

func allZeroHex(s string) bool { return strings.Trim(s[2:], "0") == "" }

// Validate checks the fact's own form: exactly lease16, lowercase hex, non-zero, in range.
func (w WriterAuthority) Validate() error {
	switch {
	case w.Source != "lease16":
		return errors.New("writer authority: only the lease16 source is delivered")
	case w.ChainID == 0:
		return errors.New("writer authority: chainId is required")
	case !lowerAddress.MatchString(w.Ledger) || allZeroHex(w.Ledger):
		return errors.New("writer authority: ledger is not a lowercase, non-zero address")
	case !lowerBytes32.MatchString(w.Deployment) || allZeroHex(w.Deployment):
		return errors.New("writer authority: deployment is not a lowercase, non-zero bytes32")
	case w.ClaimBlock < 1 || w.ClaimBlock >= 1<<32:
		return errors.New("writer authority: claimBlock must be in 1..2^32-1")
	case w.ClaimLogIndex >= 1<<16:
		return errors.New("writer authority: claimLogIndex must be below 2^16")
	}
	return nil
}

// JSON is the canonical text (field order as above, nothing else): the exact value substituted for the name.
func (w WriterAuthority) JSON() (string, error) {
	if err := w.Validate(); err != nil {
		return "", err
	}
	b, err := json.Marshal(w)
	return string(b), err
}

// ParseWriterAuthority reads a delivered fact strictly (exactly the six fields, no duplicates, nothing trailing) and checks
// it names THIS deployment on THIS chain. -> the canonical text.
func ParseWriterAuthority(raw []byte, deployment [32]byte, chainID uint64) (string, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || len(probe) != 6 {
		return "", errors.New("writer authority: not a JSON object of exactly six fields")
	}
	if err := uniqueKeys(raw); err != nil {
		return "", err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	var w WriterAuthority
	if err := dec.Decode(&w); err != nil {
		return "", fmt.Errorf("writer authority: %v", err)
	}
	if dec.More() {
		return "", errors.New("writer authority: trailing data")
	}
	if w.Deployment != "0x"+hex.EncodeToString(deployment[:]) {
		return "", errors.New("writer authority: the fact names another deployment")
	}
	if w.ChainID != chainID {
		return "", errors.New("writer authority: the fact names another chain")
	}
	return w.JSON()
}

// uniqueKeys refuses an object with a repeated key (json.Unmarshal would silently keep the last one).
func uniqueKeys(raw []byte) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return errors.New("writer authority: not a JSON object")
	}
	seen := map[string]bool{}
	for dec.More() {
		t, err := dec.Token()
		k, ok := t.(string)
		if err != nil || !ok || seen[k] {
			return errors.New("writer authority: a repeated or invalid key")
		}
		seen[k] = true
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return errors.New("writer authority: invalid value")
		}
	}
	return nil
}

// ValidateFacts: only the reserved names; the writer authority in its canonical lease16 form, the isolation a known
// runtime of a measured front ("snp" or "vbs").
func ValidateFacts(facts map[string]string) error {
	for k, v := range facts {
		switch k {
		case FactWriterAuthority:
			var w WriterAuthority
			dec := json.NewDecoder(strings.NewReader(v))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&w); err != nil {
				return errors.New("fact ENCLAVE_WRITER_AUTHORITY is not a writer authority")
			}
			if canon, err := w.JSON(); err != nil || canon != v {
				return errors.New("fact ENCLAVE_WRITER_AUTHORITY is not canonical")
			}
		case FactInstanceIsolation:
			if v != "snp" && v != "vbs" {
				return errors.New("fact ENCLAVE_INSTANCE_ISOLATION must be snp or vbs")
			}
		default:
			return fmt.Errorf("%q is not a release fact", k)
		}
	}
	return nil
}

// ResolveWithFacts is Resolve with the front's facts beside the owner's secrets: the secrets are validated exactly as
// Resolve does (the ENCLAVE_ prefix stays reserved), the facts by ValidateFacts, and both resolve the same placeholders.
func ResolveWithFacts(config string, secrets, facts map[string]string) (string, error) {
	if err := ValidateSecrets(secrets); err != nil {
		return "", err
	}
	if err := ValidateFacts(facts); err != nil {
		return "", err
	}
	if len(facts) == 0 {
		return Resolve(config, secrets)
	}
	values := make(map[string]string, len(secrets)+len(facts))
	for k, v := range secrets {
		values[k] = v
	}
	for k, v := range facts {
		values[k] = v
	}
	if !strings.Contains(config, "$") {
		return config, nil
	}
	doc, err := parse(config)
	if err != nil {
		return "", fmt.Errorf("the config is not a JSON document: %w", err)
	}
	var out bytes.Buffer
	doc.write(&out, func(s string) string { return substitute(s, values) })
	return out.String(), nil
}

// SplitFacts separates the reserved fact names from a map that carries both (the Shield front's pipe to secretrun):
// -> (secrets, facts). The secrets are then validated as secrets, the facts as facts.
func SplitFacts(env map[string]string) (map[string]string, map[string]string) {
	secrets, facts := map[string]string{}, map[string]string{}
	for k, v := range env {
		if k == FactWriterAuthority || k == FactInstanceIsolation {
			facts[k] = v
		} else {
			secrets[k] = v
		}
	}
	return secrets, facts
}
