package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStageEncVolumes(t *testing.T) {
	type call struct {
		dir       string
		size, uid int
	}
	run := func(cfg, secret string, mem int) (*domain, []call, error) {
		d := &domain{AppConfig: []byte(cfg), SecretDeployment: secret, MemMiB: mem, UID: 1234, dir: t.TempDir()}
		var calls []call
		err := stageEncVolumes(d, func(dir string, size, uid int) error { calls = append(calls, call{dir, size, uid}); return nil })
		return d, calls, err
	}
	sec := "0x" + strings.Repeat("ab", 32)
	vols := `{"encVolumes":[{"name":"docs","endpoint":"$R2_ENDPOINT","bucket":"$BUCKET","maxMb":64},{"name":"pub","endpoint":"https://s3.example.com","bucket":"b","encrypted":false,"maxMb":"8"}]}`

	// no volumes: nothing staged, nothing refused, any domain
	for _, cfg := range []string{"", `{"a":1}`, `{"encVolumes":[]}`, `{"encVolumes":false}`} {
		if d, calls, err := run(cfg, "", 256); err != nil || len(calls) != 0 || len(d.encMounts) != 0 {
			t.Errorf("%q: %v %v", cfg, calls, err)
		}
	}
	// a secret domain with room: one tmpfs per volume, owned by the runtime's uid, the marker naming them in order;
	// endpoint and bucket may be secret references (resolved by the front)
	d, calls, err := run(vols, sec, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[0].size != 66 || calls[1].size != 9 || calls[0].uid != 1234 || filepath.Base(calls[1].dir) != "pub" {
		t.Fatalf("mounts: %+v", calls)
	}
	if b, _ := os.ReadFile(filepath.Join(d.dir, "enc.volumes")); string(b) != "docs\npub\n" {
		t.Fatalf("marker: %q", b)
	}
	if fi, _ := os.Stat(filepath.Join(d.dir, "enc.volumes")); fi.Mode().Perm() != 0o444 {
		t.Fatalf("marker mode %v", fi.Mode())
	}
	if len(d.encMounts) != 2 {
		t.Fatalf("reclaim list: %v", d.encMounts)
	}
	// refusals: not a secret domain, too little memory, a malformed entry (the standard runtime's message)
	if _, _, err := run(vols, "", 1024); err == nil || !strings.Contains(err.Error(), "secret domain") {
		t.Errorf("a non-secret domain: %v", err)
	}
	// 64 MiB -> 66 MiB of tmpfs (64+1+64/64), 8 -> 9: 75 MiB, plus 128 for the runtime and app
	if _, _, err := run(vols, sec, 128+75-1); err == nil || !strings.Contains(err.Error(), "need 75 MiB") {
		t.Errorf("too little memory: %v", err)
	}
	if _, _, err := run(vols, sec, 128+75); err != nil {
		t.Errorf("exactly enough memory was refused: %v", err)
	}
	if _, _, err := run(`{"encVolumes":[{"name":"BAD"}]}`, sec, 4096); err == nil || !strings.Contains(err.Error(), "bad volume name") {
		t.Errorf("a bad name: %v", err)
	}
	if _, _, err := run(`{"encVolumes":[{"name":"a","maxMb":99999}]}`, sec, 1<<20); err == nil || !strings.Contains(err.Error(), "maxMb must be 1..4096") {
		t.Errorf("an oversized cap: %v", err)
	}
}
