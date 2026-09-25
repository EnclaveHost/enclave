package egress

import (
	"strings"
	"testing"
)

var relay = Origin{Host: "api.enclave.host"}

func TestParseOriginAccepts(t *testing.T) {
	for raw, want := range map[string]string{
		"https://images.example/v1/images/generations": "images.example",
		"HTTPS://Images.Example:443/x":                "images.example", // case and an explicit :443 normalize
		"https://0ddbd824.app.enclave.host/":          "0ddbd824.app.enclave.host",
		"https://xn--bcher-kva.example/p?q=1#f":       "xn--bcher-kva.example", // punycode ASCII is a DNS name
		"https://a-b.c-d.example":                     "a-b.c-d.example",
		"https://notes.example/api/notes/${user}":     "notes.example", // a placeholder in the PATH is the app's own
	} {
		o, err := ParseOrigin(raw)
		if err != nil || o.Host != want {
			t.Fatalf("%q: got %q %v, want %q", raw, o.Host, err, want)
		}
	}
}

// enclave-99's negatives (review of the controlled-egress draft), one per way a host can be spelled past a check.
func TestParseOriginRefuses(t *testing.T) {
	for _, raw := range []string{
		"http://images.example/",                 // not https
		"https://2130706433/",                    // decimal IPv4
		"https://0x7f.1/",                        // hex + short IPv4
		"https://127.1/",                         // short IPv4
		"https://127.0.0.1/",                     // dotted IPv4
		"https://1.2.3.4.example.1/",             // last label numeric: WHATWG reads the host as IPv4
		"https://example.0x1f/",                  // hex last label
		"https://[::1]/",                         // IPv6 literal
		"https://[::ffff:127.0.0.1]/",            // IPv4-mapped IPv6
		"https://bücher.example/",                // non-ASCII (IDN not in punycode)
		"https://example.com./",                  // trailing dot
		"https://ex%61mple.com/",                 // percent-encoding in the host
		"https://user@images.example/",           // userinfo
		"https://images.example@evil.example/",   // @ in the authority
		"https://evil.example\\@images.example/", // backslash ends the authority (WHATWG), leaving evil.example... refused for the @
		"https://images.example:8443/",           // a port other than 443
		"https://images.example:/",               // an empty port
		"https://${IMAGE_ENDPOINT}/v1",           // an unresolved placeholder in the authority
		"https://images.example\t/",              // a control character
		" https://images.example/",               // leading whitespace
		"https://localhost/",                     // a single label
		"https://-bad.example/",                  // a label with a leading hyphen
		"https:///path",                          // no host
		"https:images.example",                   // no //
	} {
		if o, err := ParseOrigin(raw); err == nil {
			t.Fatalf("%q was allowed as %q", raw, o.Host)
		}
	}
}

// @ in the PATH is not in the authority: allowed, and the host is the authority's.
func TestAtInThePathIsNotUserinfo(t *testing.T) {
	o, err := ParseOrigin("https://images.example/users/@me")
	if err != nil || o.Host != "images.example" {
		t.Fatalf("got %q %v", o.Host, err)
	}
}

// A placeholder whose VALUE contains / @ : changes the authority after substitution; the judge runs on the resolved
// string, so the authority it judges is the one the request will use.
func TestSubstitutionThatChangesTheAuthorityIsJudgedAfter(t *testing.T) {
	// "${EP}/v1" with EP = "https://images.example@evil.example" resolves to an @-authority: refused
	p, err := derive(`{"url":"https://images.example@evil.example/v1"}`, relay)
	if err != nil {
		t.Fatal(err)
	}
	if p.Allows("evil.example") || p.Allows("images.example") {
		t.Fatalf("an authority rewritten by a secret value became allowed: %+v", p.Origins)
	}
	if len(p.Refused) != 1 {
		t.Fatalf("the refusal was not recorded: %v", p.Refused)
	}
}

func TestDeriveFromTheResolvedConfig(t *testing.T) {
	cfg := `{"api_key":"k","http":[
	  {"url":"https://images.example/v1/images/generations"},
	  {"url":"https://vm.example/exec","headers":{"x-api-key":"v"}},
	  {"url":"https://notes.example/api/notes/${user}"},
	  {"url":"http://plain.example/"},
	  {"note":"see https://docs.example for help"}
	]}`
	p, err := derive(cfg, relay)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, o := range p.Origins {
		got = append(got, o.Host)
	}
	want := "api.enclave.host,images.example,notes.example,vm.example"
	if strings.Join(got, ",") != want {
		t.Fatalf("origins %v, want %s", got, want)
	}
	// "see https://docs.example for help" is prose: only a string that IS an https URL (starts with https://) is a
	// candidate, so prose that merely mentions a host never opens it
	if p.Allows("docs.example") || p.Allows("plain.example") {
		t.Fatal("prose or http:// opened a destination")
	}
}

func TestExplicitEgressReplacesDerivation(t *testing.T) {
	p, err := derive(`{"egress":["https://only.example"],"http":[{"url":"https://images.example/x"}]}`, relay)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Allows("only.example") || p.Allows("images.example") || !p.Allows("api.enclave.host") {
		t.Fatalf("origins %+v", p.Origins)
	}
	for _, bad := range []string{`{"egress":"https://x.example"}`, `{"egress":[1]}`} {
		if _, err := derive(bad, relay); err == nil {
			t.Fatalf("%s accepted", bad)
		}
	}
}

// The relay origin is pinned by the platform: config cannot remove it, and listing it is harmless.
func TestTheRelayOriginIsAlwaysThereAndCannotBeRedirected(t *testing.T) {
	for _, cfg := range []string{``, `{}`, `{"egress":[]}`, `{"egress":["https://api.enclave.host"]}`} {
		p, err := derive(cfg, relay)
		if err != nil {
			t.Fatal(err)
		}
		if !p.Allows("api.enclave.host") {
			t.Fatalf("%q removed the relay origin", cfg)
		}
	}
	if _, err := derive(`{}`, Origin{Host: "127.0.0.1"}); err == nil {
		t.Fatal("an IP relay origin was accepted")
	}
}

func TestAllowsNormalizesLikeParse(t *testing.T) {
	p, _ := derive(`{"u":"https://Images.Example/x"}`, relay)
	for _, h := range []string{"images.example", "IMAGES.EXAMPLE", "images.example:443"} {
		if !p.Allows(h) {
			t.Fatalf("%q not allowed", h)
		}
	}
	for _, h := range []string{"images.example.", "images.example:80", "evil.example", "127.0.0.1", ""} {
		if p.Allows(h) {
			t.Fatalf("%q allowed", h)
		}
	}
}
