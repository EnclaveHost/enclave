package appconfig

import (
	"strings"
	"testing"
)

// The release facts (facts.go; work/storage-front-binding-interface.txt): what the measured front substitutes for the two
// reserved names, and what it refuses.

var factDeployment = [32]byte{0x5a, 0x01, 0x02}

const (
	factDeploymentHex = "0x5a01020000000000000000000000000000000000000000000000000000000000"
	factLedger        = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b" // the live rev-16d ledger
	canonicalFact     = `{"source":"lease16","chainId":8453,"ledger":"` + factLedger + `","deployment":"` + factDeploymentHex + `","claimBlock":52515800,"claimLogIndex":7}`
)

// The REAL sia-s3 production config (sia-s3 DEPLOY.md, the catalog version's config) with the writer-fencing keys its
// REPLICATION.md documents: the exact text sia-s3's config.rs fence_policy then reads (writerAuthority a string holding
// the fact's JSON, resolved literally because it no longer starts with "$"; instanceIsolation "snp").
func TestResolveWithFactsDeliversTheSiaS3ProductionConfigExactly(t *testing.T) {
	config := `{"indexer":"https://sia.enclave.host","appKey":"$SIA_APP_KEY","region":"auto","buckets":["ipfs","s3check"],` +
		`"credentials":[{"accessKeyId":"$S3_ACCESS_KEY_ID","secretAccessKey":"$S3_SECRET_ACCESS_KEY"}],"egress":"public-web",` +
		`"writerFence":"required","writerAuthority":"$ENCLAVE_WRITER_AUTHORITY","instanceIsolation":"$ENCLAVE_INSTANCE_ISOLATION","wasi":"0.2"}`
	secrets := map[string]string{"SIA_APP_KEY": "synthetic-app-key", "S3_ACCESS_KEY_ID": "AKSYNTH", "S3_SECRET_ACCESS_KEY": "synthetic-secret"}
	facts := map[string]string{FactWriterAuthority: canonicalFact, FactInstanceIsolation: "snp"}
	got, err := ResolveWithFacts(config, secrets, facts)
	if err != nil {
		t.Fatal(err)
	}
	escaped := strings.ReplaceAll(canonicalFact, `"`, `\"`)
	want := `{"indexer":"https://sia.enclave.host","appKey":"synthetic-app-key","region":"auto","buckets":["ipfs","s3check"],` +
		`"credentials":[{"accessKeyId":"AKSYNTH","secretAccessKey":"synthetic-secret"}],"egress":"public-web",` +
		`"writerFence":"required","writerAuthority":"` + escaped + `","instanceIsolation":"snp","wasi":"0.2"}`
	if got != want {
		t.Fatalf("delivered config:\n got %s\nwant %s", got, want)
	}
	// without facts (an old front, or none established): the names stay unresolved and sia-s3 fails closed itself
	got, err = ResolveWithFacts(config, secrets, nil)
	if err != nil || !strings.Contains(got, `"writerAuthority":"$ENCLAVE_WRITER_AUTHORITY"`) || !strings.Contains(got, `"instanceIsolation":"$ENCLAVE_INSTANCE_ISOLATION"`) {
		t.Fatalf("no facts: %v %s", err, got)
	}
}

// An owner can never supply a reserved value: not as a secret (the whole ENCLAVE_ prefix), and a forged or foreign fact
// is refused on the fact channel.
func TestFactsRefuseForgedAndOwnerSuppliedValues(t *testing.T) {
	cfg := `{"writerAuthority":"$ENCLAVE_WRITER_AUTHORITY"}`
	for _, name := range []string{FactWriterAuthority, FactInstanceIsolation, "enclave_writer_authority"} {
		if _, err := ResolveWithFacts(cfg, map[string]string{name: canonicalFact}, nil); err == nil {
			t.Fatalf("an owner secret %s was accepted", name)
		}
	}
	bad := map[string]map[string]string{
		"non-canonical spacing": {FactWriterAuthority: strings.Replace(canonicalFact, `":`, `": `, 1)},
		"reordered fields":      {FactWriterAuthority: `{"chainId":8453,"source":"lease16","ledger":"` + factLedger + `","deployment":"` + factDeploymentHex + `","claimBlock":52515800,"claimLogIndex":7}`},
		"extra field":           {FactWriterAuthority: strings.TrimSuffix(canonicalFact, "}") + `,"generation":1}`},
		"lease17 source":        {FactWriterAuthority: strings.Replace(canonicalFact, "lease16", "lease17", 1)},
		"owner-cold source":     {FactWriterAuthority: strings.Replace(canonicalFact, "lease16", "owner-cold", 1)},
		"uppercase ledger":      {FactWriterAuthority: strings.Replace(canonicalFact, factLedger, strings.ToUpper(factLedger[2:])+"", 1)},
		"zero claim block":      {FactWriterAuthority: strings.Replace(canonicalFact, "52515800", "0", 1)},
		"claim block 2^32":      {FactWriterAuthority: strings.Replace(canonicalFact, "52515800", "4294967296", 1)},
		"log index 2^16":        {FactWriterAuthority: strings.Replace(canonicalFact, `"claimLogIndex":7`, `"claimLogIndex":65536`, 1)},
		"isolation tdx":         {FactInstanceIsolation: "tdx"},
		"isolation owner":       {FactInstanceIsolation: "owner-process"},
		"another name":          {"ENCLAVE_GENERATION": "1"},
	}
	for what, f := range bad {
		if _, err := ResolveWithFacts(cfg, nil, f); err == nil {
			t.Errorf("%s: accepted", what)
		}
	}
}

// What the front reads from a release: exactly the six fields, once each, naming THIS deployment on Base.
func TestParseWriterAuthorityIsStrictAndBound(t *testing.T) {
	got, err := ParseWriterAuthority([]byte(`{ "claimLogIndex": 7, "claimBlock": 52515800, "deployment": "`+factDeploymentHex+`", "ledger": "`+factLedger+`", "chainId": 8453, "source": "lease16" }`), factDeployment, 8453)
	if err != nil || got != canonicalFact {
		t.Fatalf("parse: %v %s", err, got)
	}
	other := factDeployment
	other[31] = 1
	for what, c := range map[string]struct {
		raw   string
		id    [32]byte
		chain uint64
	}{
		"another deployment": {canonicalFact, other, 8453},
		"another chain":      {canonicalFact, factDeployment, 1},
		"a repeated key":     {strings.TrimSuffix(canonicalFact, "}") + `,"claimBlock":52515801}`, factDeployment, 8453},
		"a missing field":    {strings.Replace(canonicalFact, `,"claimLogIndex":7`, "", 1), factDeployment, 8453},
		"an unknown field":   {strings.Replace(canonicalFact, `"claimLogIndex":7`, `"logIndex":7`, 1), factDeployment, 8453},
		"a string number":    {strings.Replace(canonicalFact, `52515800`, `"52515800"`, 1), factDeployment, 8453},
		"a negative number":  {strings.Replace(canonicalFact, `"claimLogIndex":7`, `"claimLogIndex":-7`, 1), factDeployment, 8453},
		"trailing data":      {canonicalFact + `{}`, factDeployment, 8453},
		"not an object":      {`[1,2,3,4,5,6]`, factDeployment, 8453},
	} {
		if _, err := ParseWriterAuthority([]byte(c.raw), c.id, c.chain); err == nil {
			t.Errorf("%s: accepted", what)
		}
	}
}

func TestSplitFactsSeparatesOnlyTheReservedNames(t *testing.T) {
	s, f := SplitFacts(map[string]string{"SIA_APP_KEY": "k", FactWriterAuthority: canonicalFact, FactInstanceIsolation: "vbs", "ENCLAVE_OTHER": "x"})
	if len(f) != 2 || f[FactInstanceIsolation] != "vbs" || f[FactWriterAuthority] != canonicalFact {
		t.Fatalf("facts %v", f)
	}
	if len(s) != 2 || s["SIA_APP_KEY"] != "k" {
		t.Fatalf("secrets %v", s)
	}
	if ValidateSecrets(s) == nil {
		t.Fatal("an ENCLAVE_ name left among the secrets must still be refused as a secret")
	}
}
