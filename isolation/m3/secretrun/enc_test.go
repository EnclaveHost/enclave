package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTakeEncBelievesOnlyTheMonitorsStaging(t *testing.T) {
	markerOwner = uint32(os.Getuid())
	dir := t.TempDir()
	root := filepath.Join(dir, "enc")
	marker := filepath.Join(dir, "enc.volumes")
	os.MkdirAll(filepath.Join(root, "docs"), 0o770)
	os.MkdirAll(filepath.Join(root, "pub"), 0o770)
	write := func(s string, mode os.FileMode) {
		os.Remove(marker)
		os.WriteFile(marker, []byte(s), 0o600)
		os.Chmod(marker, mode)
	}
	api := "http://127.0.0.1:50080/encvol/0x" + strings.Repeat("ab", 32)
	tok := strings.Repeat("0f", 24)
	good := func() map[string]string {
		return map[string]string{"ENCLAVE_ENC": "docs,pub", "ENCLAVE_ENC_API": api, "ENCLAVE_ENC_TOKEN": tok, "OWNER_SECRET": "x"}
	}
	write("docs\npub\n", 0o444)
	m := good()
	l, err := takeEnc(m, marker, root)
	if err != nil || strings.Join(l.names, ",") != "docs,pub" || l.api != api || l.token != tok {
		t.Fatalf("a staged launch: %+v %v", l, err)
	}
	if _, left := m["ENCLAVE_ENC_TOKEN"]; left || m["OWNER_SECRET"] != "x" {
		t.Fatalf("the reserved names must be taken out, the rest left: %v", m)
	}
	for name, c := range map[string]struct {
		m      func(map[string]string)
		marker string
		mode   os.FileMode
	}{
		"a name the monitor did not stage": {func(m map[string]string) { m["ENCLAVE_ENC"] = "docs,pub,etc" }, "docs\npub\n", 0o444},
		"a staged volume left out":         {func(m map[string]string) { m["ENCLAVE_ENC"] = "docs" }, "docs\npub\n", 0o444},
		"another order":                    {func(m map[string]string) { m["ENCLAVE_ENC"] = "pub,docs" }, "docs\npub\n", 0o444},
		"a path in a name":                 {func(m map[string]string) { m["ENCLAVE_ENC"] = "../x" }, "../x\n", 0o444},
		"a remote plane": {func(m map[string]string) {
			m["ENCLAVE_ENC_API"] = "http://10.0.0.1:80/encvol/0x" + strings.Repeat("ab", 32)
		}, "docs\npub\n", 0o444},
		"a short token":     {func(m map[string]string) { m["ENCLAVE_ENC_TOKEN"] = "abc" }, "docs\npub\n", 0o444},
		"one of three":      {func(m map[string]string) { delete(m, "ENCLAVE_ENC_API") }, "docs\npub\n", 0o444},
		"a writable marker": {func(map[string]string) {}, "docs\npub\n", 0o644},
		"staged, the plane absent": {func(m map[string]string) {
			delete(m, "ENCLAVE_ENC")
			delete(m, "ENCLAVE_ENC_API")
			delete(m, "ENCLAVE_ENC_TOKEN")
		}, "docs\npub\n", 0o444},
		"a staged name with no directory": {func(m map[string]string) { m["ENCLAVE_ENC"] = "docs,pub,gone" }, "docs\npub\ngone\n", 0o444},
	} {
		write(c.marker, c.mode)
		m := good()
		c.m(m)
		if _, err := takeEnc(m, marker, root); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// no staging and no plane: no volumes, nothing refused
	os.Remove(marker)
	m = map[string]string{"OWNER_SECRET": "x"}
	if l, err := takeEnc(m, marker, root); err != nil || len(l.names) != 0 {
		t.Fatalf("no volumes: %+v %v", l, err)
	}
	// a plane with no staging is refused
	if _, err := takeEnc(good(), marker, root); err == nil {
		t.Fatal("volumes the monitor never staged were accepted")
	}
}
