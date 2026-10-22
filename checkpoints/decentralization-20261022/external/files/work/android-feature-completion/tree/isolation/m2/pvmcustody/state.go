package pvmcustody

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"enclave.host/isolation/m2/custody"
	"enclave.host/isolation/m2/egress"
	"enclave.host/isolation/m2/release"
)

// stateV2 is the SNP front's custodyStateV2 (isolation/m2/front/custody.go, package main, so not importable), unchanged:
// the owner-committed v2 pointer, checked strictly by release.Custody.V2, as the custody client's state.
func stateV2(id [32]byte, c *release.Custody) (custody.StateV2, error) {
	var st custody.StateV2
	p, err := c.V2()
	if err != nil {
		return st, err
	}
	st.ID, st.Ctx = id, custody.Context{ChainID: p.ChainID, Vault: p.Vault}
	st.CommitteeID, st.PolicyRev, st.SecretRev, st.Epoch, st.Threshold, st.Bundle = p.CommitteeID, p.PolicyRev, p.SecretRev, p.Epoch, p.T, p.Bundle
	if st.Commitments, err = custody.SplitCommitmentsV2(p.Commitments, p.T); err != nil {
		return st, fmt.Errorf("the custody pointer's %w", err)
	}
	for i, m := range p.Machines {
		base, _, err := custodianEndpointV2(m.Endpoint)
		if err != nil {
			return st, fmt.Errorf("custodian machine %d's endpoint: %w", i, err)
		}
		st.Machines = append(st.Machines, custody.MachineV2{EncKey: m.EncKey, Endpoint: base, Enclave: m.Enclave, Indices: m.Indices})
	}
	return st, nil
}

// custodianEndpointV2 is the SNP front's (isolation/m2/front/custody.go), unchanged: an https URL whose authority is an
// origin egress.ParseOrigin accepts (a DNS name, port 443 only) and an optional path prefix of at most 4 segments.
func custodianEndpointV2(raw string) (base, host string, err error) {
	if !strings.HasPrefix(raw, "https://") {
		return "", "", errors.New("not an https:// URL")
	}
	rest := raw[len("https://"):]
	cut := strings.IndexAny(rest, "/?#\\")
	origin, path := raw, ""
	if cut >= 0 {
		origin, path = raw[:len("https://")+cut], rest[cut:]
	}
	o, err := egress.ParseOrigin(origin)
	if err != nil {
		return "", "", err
	}
	path = strings.TrimSuffix(path, "/")
	if !custodianPathRE.MatchString(path) {
		return "", "", errors.New("the path prefix is not at most 4 segments of [A-Za-z0-9._~-]")
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "." || seg == ".." || strings.Contains(seg, "..") {
			return "", "", errors.New("a dot segment in the path prefix")
		}
	}
	return "https://" + o.Host + path, o.Host, nil
}

var custodianPathRE = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+){0,4}$`)
