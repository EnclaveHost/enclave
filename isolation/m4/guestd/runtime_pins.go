package main

import (
	"enclave.host/isolation/contract"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func runtimeFileID(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var r contract.RuntimeIdentity
	if err = json.Unmarshal(b, &r); err != nil {
		return "", err
	}
	id, err := contract.RuntimeID(r)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(id[:]), nil
}
func parseRuntimePins(value string) (map[string]string, error) {
	out := map[string]string{}
	if value == "" {
		return out, nil
	}
	for _, entry := range strings.Split(value, ",") {
		release, path, ok := strings.Cut(entry, "=")
		if !ok || !isHex(release, 32) || out[release] != "" {
			return nil, fmt.Errorf("invalid or duplicate historical runtime pin")
		}
		if _, err := runtimeFileID(path); err != nil {
			return nil, err
		}
		out[release] = path
	}
	return out, nil
}
func (l *realLauncher) runtimePath(releases []string) string {
	for _, r := range releases {
		if p := l.runtimePins[r]; p != "" {
			return p
		}
	}
	return l.runtimeIdentity
}
func (l *realLauncher) RuntimeForReleases(releases []string) (string, error) {
	id, err := runtimeFileID(l.runtimePath(releases))
	if err != nil {
		return "", err
	}
	for _, r := range releases {
		p := l.runtimePins[r]
		if p == "" {
			p = l.runtimeIdentity
		}
		other, e := runtimeFileID(p)
		if e != nil {
			return "", e
		}
		if other != id {
			return "", fmt.Errorf("ambiguous runtime pins across releases")
		}
	}
	return id, nil
}
func (s *server) vmRuntime(v *vm) string {
	if v.RuntimeID != "" {
		return v.RuntimeID
	}
	return s.RuntimeID
}
