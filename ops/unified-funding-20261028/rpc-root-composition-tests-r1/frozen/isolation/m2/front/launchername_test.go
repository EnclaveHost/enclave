package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestALauncherNameIsTakenOnlyInTheHostDataShapeAndZone(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) string {
		p := filepath.Join(dir, "cert.name")
		if err := os.WriteFile(p, []byte(s), 0o444); err != nil {
			_ = os.Chmod(p, 0o644)
			if err := os.WriteFile(p, []byte(s), 0o444); err != nil {
				t.Fatal(err)
			}
		}
		return p
	}
	if n := launcherName(write("4e62e60d.app.enclave.host\n"), "app.enclave.host"); n != "4e62e60d.app.enclave.host" {
		t.Fatalf("a well-formed name was refused: %q", n)
	}
	for what, content := range map[string]string{
		"another zone":     "4e62e60d.app.evil.example",
		"uppercase label":  "4E62E60D.app.enclave.host",
		"short label":      "4e62e60.app.enclave.host",
		"not hex":          "zzzzzzzz.app.enclave.host",
		"a subdomain":      "x.4e62e60d.app.enclave.host",
		"the zone itself":  "app.enclave.host",
		"trailing garbage": "4e62e60d.app.enclave.host.",
		"empty":            "",
	} {
		if n := launcherName(write(content), "app.enclave.host"); n != "" {
			t.Errorf("%s was accepted as %q", what, n)
		}
	}
	if n := launcherName(filepath.Join(dir, "absent"), "app.enclave.host"); n != "" {
		t.Errorf("no file gave %q", n)
	}
	if n := launcherName(write("4e62e60d.app.enclave.host"), ""); n != "" {
		t.Errorf("no zone gave %q", n)
	}
}
