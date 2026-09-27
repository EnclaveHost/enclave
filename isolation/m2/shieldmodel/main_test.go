package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestAuthenticatedPrivateCopy(t *testing.T) {
	data := []byte("public model fixture")
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	for _, tc := range []struct {
		name  string
		bytes []byte
		hash  string
		ok    bool
	}{
		{"valid", data, digest, true},
		{"short", data[:3], digest, false},
		{"corrupt", []byte("corrupted model data"), digest, false},
		{"wrong-pin", data, "bad", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := t.TempDir()
			src := filepath.Join(d, "block")
			dst := filepath.Join(d, "private")
			if err := os.WriteFile(src, tc.bytes, 0600); err != nil {
				t.Fatal(err)
			}
			err := copyVerified(src, dst, int64(len(data)), tc.hash)
			if (err == nil) != tc.ok {
				t.Fatalf("unexpected result: %v", err)
			}
			if !tc.ok {
				return
			}
			if err := os.WriteFile(src, []byte("host mutation"), 0600); err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(dst)
			st, _ := os.Stat(dst)
			if string(got) != string(data) || st.Mode().Perm() != 0444 {
				t.Fatal("private copy changed or remained writable")
			}
			if copyVerified(src, dst, int64(len(data)), tc.hash) == nil {
				t.Fatal("overwrote an existing model")
			}
		})
	}
}
