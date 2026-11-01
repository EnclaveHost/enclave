package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/appconfig"
	"enclave.host/isolation/m2/release"
)

// The facts a relay-release front hands its app (provision.go releaseFacts / relayPathFacts): the isolation of its own
// measured runtime always; the writer authority only as the relay delivered it, read strictly and bound to THIS
// deployment; and no chain read at all when the config does not refer to it.
func TestReleaseFactsAreBoundToTheDeployment(t *testing.T) {
	id := [32]byte{0x5a, 0x01, 0x02}
	fact := `{"source":"lease16","chainId":8453,"ledger":"0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b","deployment":"0x5a01020000000000000000000000000000000000000000000000000000000000","claimBlock":52515800,"claimLogIndex":7}`
	var rel release.Release
	if err := json.Unmarshal([]byte(`{"id":"x","facts":{"writerAuthority":`+fact+`}}`), &rel); err != nil {
		t.Fatal(err)
	}
	f, err := releaseFacts(&rel, id, snpIsolation)
	if err != nil || f[appconfig.FactWriterAuthority] != fact || f[appconfig.FactInstanceIsolation] != "snp" || len(f) != 2 {
		t.Fatalf("facts %v %v", f, err)
	}
	other := id
	other[31] = 9
	if _, err := releaseFacts(&rel, other, snpIsolation); err == nil {
		t.Fatal("a fact naming another deployment was accepted")
	}
	// an old relay (no facts) and a config that never refers to the name: the isolation only, nothing read
	f, err = (&provisioner{}).relayPathFacts(context.Background(), &release.Release{}, id, `{"indexer":"https://x"}`, snpIsolation)
	if err != nil || len(f) != 1 || f[appconfig.FactInstanceIsolation] != "snp" {
		t.Fatalf("facts %v %v", f, err)
	}
	// a config that refers to it, a release without the authority and without the lease holder (an older relay): no fact,
	// and no chain read on an unbound lease
	if _, err := (&provisioner{}).relayPathFacts(context.Background(), &release.Release{}, id, `{"w":"$ENCLAVE_WRITER_AUTHORITY"}`, snpIsolation); err == nil {
		t.Fatal("a release naming no lease holder gave a writer authority")
	}
}

// The lease holder a release names (facts.runner): exactly a lowercase, non-zero 0x bytes32.
func TestReleaseRunnerIsStrict(t *testing.T) {
	good := "0xab" + strings.Repeat("00", 30) + "0f"
	r, err := releaseRunner(&release.Release{Facts: &release.ReleaseFacts{Runner: good}})
	if err != nil || r[0] != 0xab || r[31] != 0x0f {
		t.Fatalf("runner %x %v", r, err)
	}
	for _, bad := range []string{"", good[:65], good + "0", "0X" + good[2:], "0x" + "AB" + good[4:], "0x" + strings.Repeat("0", 64), "0x" + "zz" + good[4:]} {
		if _, err := releaseRunner(&release.Release{Facts: &release.ReleaseFacts{Runner: bad}}); err == nil {
			t.Errorf("runner %q accepted", bad)
		}
	}
	if _, err := releaseRunner(nil); err == nil {
		t.Error("no release accepted")
	}
}

// The Shield relay front (shield_secrets.go): the facts its runtime gets are those the MEASURED /app.config refers to.
func shieldFactsFixture(t *testing.T) (*front, *secretSink, ed25519.PrivateKey, string) {
	t.Helper()
	f, sink, priv := secretFixture(t)
	f.secrets.egress = newEgressWorld(t, `{"bucket":"jot-notes","endpoint":"$R2_ENDPOINT","writerAuthority":"$ENCLAVE_WRITER_AUTHORITY","instanceIsolation":"$ENCLAVE_INSTANCE_ISOLATION"}`).eg
	fact := `{"source":"lease16","chainId":8453,"ledger":"0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b","deployment":"0x` + strings.Repeat("07", 32) + `","claimBlock":52515800,"claimLogIndex":7}`
	return f, sink, priv, fact
}

func TestShieldRuntimeGetsTheReferencedFactsOnItsPipe(t *testing.T) {
	f, sink, priv, fact := shieldFactsFixture(t)
	runner := "0x" + strings.Repeat("ab", 32)
	plain := map[string]any{"id": f.secrets.text, "config": nil, "secrets": map[string]string{"API_KEY": "synthetic-value"},
		"facts": map[string]any{"writerAuthority": json.RawMessage(fact), "runner": runner}, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	if code := postSecret(f, sealForTest(t, f.secrets, priv, plain)); code != 200 || !sink.closed {
		t.Fatalf("release with facts: %d", code)
	}
	var got map[string]string
	if err := json.Unmarshal(sink.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"API_KEY": "synthetic-value", appconfig.FactWriterAuthority: fact, appconfig.FactInstanceIsolation: "vbs"}
	if len(got) != len(want) {
		t.Fatalf("pipe %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("pipe %s = %q, want %q", k, got[k], v)
		}
	}
}

func TestShieldRefusesAForeignFactAndAnUnboundPendingRelease(t *testing.T) {
	// a fact naming another deployment: refused before anything reaches the runtime
	f, sink, priv, fact := shieldFactsFixture(t)
	foreign := strings.Replace(fact, strings.Repeat("07", 32), strings.Repeat("08", 32), 1)
	plain := map[string]any{"id": f.secrets.text, "config": nil, "secrets": map[string]string{"API_KEY": "synthetic-value"},
		"facts": map[string]any{"writerAuthority": json.RawMessage(foreign)}, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	if code := postSecret(f, sealForTest(t, f.secrets, priv, plain)); code != 403 || sink.Len() != 0 || sink.closed {
		t.Fatalf("foreign fact: %d", code)
	}
	// no fact and no lease holder (a relay predating facts.runner): refused before the release is spent
	f, sink, priv, _ = shieldFactsFixture(t)
	plain = map[string]any{"id": f.secrets.text, "config": nil, "secrets": map[string]string{"API_KEY": "synthetic-value"}, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	if code := postSecret(f, sealForTest(t, f.secrets, priv, plain)); code != 403 || sink.Len() != 0 || sink.closed || f.secrets.done {
		t.Fatalf("unbound pending release: %d", code)
	}
}

// No fact in the release, a lease holder named: accepted as pending; the front's own read cannot establish it here (no
// chain), so when its window ends the pipe is closed EMPTY and the runtime never starts the app.
func TestShieldPendingAuthorityThatNeverArrivesStartsNothing(t *testing.T) {
	window, interval := writerAuthorityWindow, writerAuthorityInterval
	writerAuthorityWindow, writerAuthorityInterval = 300*time.Millisecond, 50*time.Millisecond
	defer func() { writerAuthorityWindow, writerAuthorityInterval = window, interval }()
	f, sink, priv, _ := shieldFactsFixture(t)
	plain := map[string]any{"id": f.secrets.text, "config": nil, "secrets": map[string]string{"API_KEY": "synthetic-value"},
		"facts": map[string]any{"runner": "0x" + strings.Repeat("ab", 32)}, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	raw, _ := json.Marshal(sealForTest(t, f.secrets, priv, plain))
	w := httptest.NewRecorder()
	f.serveShieldSecrets(w, httptest.NewRequest("POST", shieldSecretsPath, bytes.NewReader(raw)))
	if w.Code != 200 || w.Body.String() != `{"ok":true,"writerAuthority":"pending"}` {
		t.Fatalf("pending: %d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	for !sink.closed && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !sink.closed || sink.Len() != 0 {
		t.Fatal("an authority that never arrived must close the pipe empty")
	}
}
